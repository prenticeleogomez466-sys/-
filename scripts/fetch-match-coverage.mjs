// 一场比赛"所有数据 + 所有赔率"覆盖抓取器(免费源,真实端到端,缺标缺不编)。
// 用户铁律 2026-06-09:必须把所有赔率/数据补齐覆盖后再生成。
//   · 近5场/H2H = ESPN 隐藏 API(跨 fifa.world/friendly/各预选赛 league 合并,plain HTTP 无反爬)
//   · 大小球 O/U = The Odds API totals(世界杯单场,14家盘口 de-vig 共识);友谊赛无 sport key→真墙标缺
//   · 1X2/让球/比分/半全场 = 已由 500 实时进模型快照,本脚本不重复
// 输出:D:/football-model-data/coverage/<date>.json,供完整交付 + workflow 交叉审计读取。
import "../src/env.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures } from "../src/fixture-store.js";
import { buildCoverageTargets, loadZhToEn } from "../src/coverage-targets.js";
import { resolveDeliveryDate } from "../src/today-delivery-lib.js";
import { clubLeagueForm, clubLeagueH2H } from "../src/club-league-form.js";
import { fetchOddsApiRotating, listOddsApiKeys } from "../src/odds-api-rotation.js";

// 日期:必传合法 YYYY-MM-DD 或缺省=本机 UTC+8 当日;非法 fail-loud 退出(2026-06-10 缺陷#20:废写死历史日期默认)。
let DATE;
try { DATE = resolveDeliveryDate(process.argv[2]); }
catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
// 2026-06-23 修:用多 key 轮换(8 个免费 key),不再只认死掉的主 ODDS_API_KEY——
//   主 key 401 时旧逻辑直接放弃→芬超亚盘/世界杯totals全缺;轮换会切到有效 key(实测 key#1 剩 414 配额)。
const HAS_KEY = listOddsApiKeys().length > 0;

// 抓取目标动态生成(2026-06-10,审计rank2):废 7 场硬编码——从当日 fixtures store 收
//   竞彩在售(jingcai)+ 世界杯场(shengfucai),对阵去重;中文→英文用 groups.json 反查 +
//   静态译名表,查不到 → re=null,下面诚实标"⚠️无英文映射"不编。
const MATCHES = buildCoverageTargets(loadFixtures(DATE).fixtures, loadZhToEn());
if (!MATCHES.length) console.error(`⚠️ ${DATE} fixtures store 无竞彩/世界杯场——无目标可抓(核 D:/football-model-data/fixtures/${DATE}.json)`);
for (const m of MATCHES) {
  const miss = [m.home, m.away].filter((t) => !t.re).map((t) => t.zh);
  if (miss.length) console.error(`⚠️ ${m.zh}:中文→英文映射缺(${miss.join("/")}),该侧近5/H2H/赔率将标未取到,不编`);
}

const LEAGUES = ["fifa.world", "fifa.friendly", "fifa.worldq.uefa", "fifa.worldq.afc", "fifa.worldq.concacaf", "fifa.worldq.conmebol", "fifa.cew", "fifa.nations"];
const scoreVal = (s) => (s == null ? null : typeof s === "object" ? (s.displayValue ?? s.value ?? null) : s);

async function jget(url) { try { const r = await fetch(url); if (r.status !== 200) return null; return await r.json(); } catch { return null; } }

// 跨 league 建队名→{id, leagues[]}
async function buildTeamMap() {
  const map = {};
  for (const lg of LEAGUES) {
    const j = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams`);
    for (const t of j?.sports?.[0]?.leagues?.[0]?.teams || []) {
      const nm = t.team.displayName;
      map[nm] = map[nm] || { id: t.team.id, name: nm, abbr: t.team.abbreviation, leagues: [] };
      if (!map[nm].leagues.includes(lg)) map[nm].leagues.push(lg);
    }
  }
  return map;
}

// 某队跨其所有 league 的已完赛事(去重 by event id),含对手/比分/主客/结果
async function teamHistory(team) {
  const seen = new Set(), games = [];
  for (const lg of team.leagues) {
    const sc = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/${team.id}/schedule`);
    for (const e of sc?.events || []) {
      const c = e.competitions?.[0];
      if (!c?.status?.type?.completed) continue;
      if (seen.has(e.id)) continue; seen.add(e.id);
      const me = c.competitors.find((x) => x.team.id === team.id);
      const opp = c.competitors.find((x) => x.team.id !== team.id);
      if (!me || !opp) continue;
      const ms = parseInt(scoreVal(me.score)), os = parseInt(scoreVal(opp.score));
      if (!Number.isFinite(ms) || !Number.isFinite(os)) continue;
      games.push({
        date: e.date?.slice(0, 10), lg,
        homeAway: me.homeAway, oppName: opp.team.displayName, oppAbbr: opp.team.abbreviation,
        gf: ms, ga: os, res: ms > os ? "胜" : ms === os ? "平" : "负",
        score: `${me.homeAway === "home" ? ms : os}-${me.homeAway === "home" ? os : ms}`,
      });
    }
  }
  games.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return games;
}

// ── ESPN/DraftKings 赔率(亚盘pointSpread + 欧赔moneyline + 大小球total),免费、覆盖国际友谊赛 ──
const am2dec = (a) => { const n = parseInt(a); return Number.isFinite(n) ? (n > 0 ? +(n / 100 + 1).toFixed(2) : +(100 / -n + 1).toFixed(2)) : null; };
async function fetchEspnOdds(date) {
  const d = date.replace(/-/g, "");
  const d1 = String(Number(d) + 1); // 跨夜场(如6/10开赛)也扫
  const out = [];
  for (const lg of LEAGUES) {
    for (const dd of [d, d1]) {
      const j = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${dd}`);
      for (const e of j?.events || []) {
        const c = e.competitions?.[0]; const o = c?.odds?.[0];
        if (!o || !o.pointSpread) continue;
        const ps = o.pointSpread, ml = o.moneyline, tot = o.total;
        const provider = o.provider?.name || "?";
        out.push({
          name: e.name, provider,
          asian: {
            line: ps.home?.close?.line ?? ps.home?.open?.line ?? null,
            homeOdds: am2dec(ps.home?.close?.odds), awayOdds: am2dec(ps.away?.close?.odds),
            openLine: ps.home?.open?.line ?? null,
          },
          ml: ml ? { home: am2dec(ml.home?.close?.odds), draw: am2dec(ml.draw?.close?.odds), away: am2dec(ml.away?.close?.odds) } : null,
          total: { line: o.overUnder ?? null, over: am2dec(tot?.over?.close?.odds), under: am2dec(tot?.under?.close?.odds) },
        });
      }
    }
  }
  return out;
}

// ── Odds API totals(世界杯大小球) ──
async function fetchWcTotals() {
  if (!HAS_KEY) return { ok: false, reason: "无 ODDS_API_KEY" };
  const rot = await fetchOddsApiRotating((k) => `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${k}&regions=eu&markets=h2h,totals&oddsFormat=decimal`);
  if (!rot.ok) return { ok: false, reason: rot.quotaExhausted ? `全${rot.attempts.length}key配额尽(401/429)` : (rot.error || `HTTP ${rot.status}`) };
  const remaining = rot.remaining;
  const events = await rot.response.json();
  const median = (a) => { const s = a.filter((x) => x > 0).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const byPair = {};
  for (const ev of Array.isArray(events) ? events : []) {
    // 取 2.5 线(主流);各家 Over/Under @2.5 取中位 → de-vig
    const ov = [], un = [];
    for (const b of ev.bookmakers || []) {
      const m = (b.markets || []).find((x) => x.key === "totals");
      if (!m) continue;
      const o = m.outcomes.find((x) => /over/i.test(x.name) && x.point === 2.5);
      const u = m.outcomes.find((x) => /under/i.test(x.name) && x.point === 2.5);
      if (o && u) { ov.push(o.price); un.push(u.price); }
    }
    const mo = median(ov), mu = median(un);
    if (!mo || !mu) continue;
    const inv = 1 / mo + 1 / mu;
    byPair[`${ev.home_team}|${ev.away_team}`] = {
      line: 2.5, books: ov.length, oddsOver: +mo.toFixed(3), oddsUnder: +mu.toFixed(3),
      pOver: +((1 / mo) / inv).toFixed(3), pUnder: +((1 / mu) / inv).toFixed(3), overround: +inv.toFixed(4),
    };
  }
  return { ok: true, remaining, byPair };
}

// ── 俱乐部联赛亚盘(The Odds API spreads·补ESPN/DK不覆盖的联赛如芬超)──
const CLUB_LEAGUE_SPORTKEY = { "芬兰超级联赛": "soccer_finland_veikkausliiga" };
// 队名归一:小写、去常见后/前缀词(fc/if/ifk/sk/ps/vps/kups/fk)、去非字母。跨源(The Odds API ↔ 积分榜en)匹配用。
const normTeamEn = (s) => String(s || "").toLowerCase().replace(/\b(fc|if|ifk|sk|vps|kups|ps|fk)\b/g, "").replace(/[^a-z]/g, "");

// 积分榜(club-league-standings.json)的 en/oddsAlias → 中文队名 + 联赛名。
//   The Odds API 英文队名(如 "FC Inter Turku"/"KuPS Kuopio")与积分榜 en("Inter Turku"/"Kuopion PS")
//   写法略异 → 用 normTeamEn 归一后建桥;不可归一者由积分榜 oddsAlias 显式补(纯名称归一,非数据编造)。
function buildClubEnToZh() {
  const map = {}; // normEn -> { zh, league }
  try {
    const p = join(process.env.FOOTBALL_DATA_DIR || "D:/football-model-data", "club-league-standings.json");
    const db = JSON.parse(readFileSync(p, "utf8"));
    for (const [lg, ld] of Object.entries(db.leagues || {})) {
      for (const [zh, t] of Object.entries(ld.teams || {})) {
        for (const nm of [t.en, ...(Array.isArray(t.oddsAlias) ? t.oddsAlias : [])]) {
          const k = normTeamEn(nm);
          if (k) map[k] = { zh, league: lg };
        }
      }
    }
  } catch (e) { console.error(`  俱乐部en→zh桥失败: ${e.message}`); }
  return map;
}

// 返回 { `${homeZh}|${awayZh}`: { line(主队视角让球), homeOdds, awayOdds, books, source } }(中文键,主循环精确查)。
async function fetchClubLeagueAsian(leagues) {
  if (!HAS_KEY) return {};
  const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const enToZh = buildClubEnToZh();
  const resolve = (en) => enToZh[normTeamEn(en)]?.zh ?? null; // 解不出=不编,跳过该场
  const byPair = {};
  for (const lg of [...new Set(leagues)]) {
    const sport = CLUB_LEAGUE_SPORTKEY[lg];
    if (!sport) continue;
    try {
      // US 区给亚盘让球线(quarter handicap);取各家主队让球线/水位中位作共识。多key轮换。
      const rot = await fetchOddsApiRotating((k) => `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${k}&regions=us&markets=spreads&oddsFormat=decimal`);
      if (!rot.ok) { console.error(`  俱乐部亚盘 ${lg}: ${rot.quotaExhausted ? `全${rot.attempts.length}key配额尽(401/429)` : (rot.error || `HTTP ${rot.status}`)}`); continue; }
      const events = await rot.response.json();
      let hit = 0;
      for (const ev of Array.isArray(events) ? events : []) {
        const pts = [], hw = [], aw = [];
        for (const b of ev.bookmakers || []) {
          const m = (b.markets || []).find((x) => x.key === "spreads");
          if (!m) continue;
          const ho = m.outcomes.find((o) => o.name === ev.home_team);
          const ao = m.outcomes.find((o) => o.name === ev.away_team);
          if (ho && ao && Number.isFinite(ho.point)) { pts.push(ho.point); hw.push(ho.price); aw.push(ao.price); }
        }
        const line = median(pts);
        if (line == null) continue;
        const homeZh = resolve(ev.home_team), awayZh = resolve(ev.away_team);
        if (!homeZh || !awayZh) { console.error(`  俱乐部亚盘 ${lg}: 队名未解 ${ev.home_team} / ${ev.away_team}(标缺不编)`); continue; }
        byPair[`${homeZh}|${awayZh}`] = {
          line: +line.toFixed(2), homeOdds: +median(hw).toFixed(2), awayOdds: +median(aw).toFixed(2),
          books: pts.length, source: `The Odds API(US亚盘${pts.length}家中位)`,
        };
        hit++;
      }
      console.error(`  俱乐部亚盘 ${lg}: ${hit}场匹配`);
    } catch (e) { console.error(`  俱乐部亚盘 ${lg} 失败: ${e.message}`); }
  }
  return byPair;
}

// ── 主流程 ──
console.error("建 ESPN 队名表…");
const tmap = await buildTeamMap();
const findTeam = (re) => Object.values(tmap).find((t) => new RegExp(re, "i").test(t.name));

console.error("抓 ESPN/DraftKings 赔率(亚盘+欧赔+大小球)…");
const espnOdds = await fetchEspnOdds(DATE);
console.error(`  ESPN赔率: ${espnOdds.length}场带盘口`);

console.error("抓 Odds API 世界杯大小球…");
const tot = await fetchWcTotals();
console.error(`  Odds API totals: ${tot.ok ? `ok, remaining=${tot.remaining}, ${Object.keys(tot.byPair).length}场` : "失败 " + tot.reason}`);

// 俱乐部联赛亚盘(ESPN/DK不覆盖如芬超):仅当当日有此类联赛在售时才抓(省 Odds API credit)
const clubLeagues = [...new Set(MATCHES.filter((m) => !m.wc && CLUB_LEAGUE_SPORTKEY[m.comp]).map((m) => m.comp))];
let clubAsian = {};
if (clubLeagues.length) {
  console.error(`抓俱乐部联赛亚盘(${clubLeagues.join("/")})…`);
  clubAsian = await fetchClubLeagueAsian(clubLeagues);
  console.error(`  俱乐部亚盘命中: ${Object.keys(clubAsian).length}场`);
}

const out = { date: DATE, generatedAt: new Date().toISOString(), oddsApiRemaining: tot.remaining ?? null, matches: [] };

for (const m of MATCHES) {
  console.error(`抓 ${m.zh} …`);
  // re=null(无英文映射)→ 不查 ESPN/Odds API,诚实落空,绝不模糊猜队
  const ht = m.home.re ? findTeam(m.home.re) : null, at = m.away.re ? findTeam(m.away.re) : null;
  const hHist = ht ? await teamHistory(ht) : [];
  const aHist = at ? await teamHistory(at) : [];
  const last5 = (g) => g.slice(-5).reverse();
  // H2H:主队历史里筛对手 = 客队(按 abbr 或 名字)
  const h2h = at ? hHist.filter((g) => g.oppName === at.name || (ht && m.away.re && new RegExp(m.away.re, "i").test(g.oppName))).slice(-5).reverse() : [];

  // 大小球(The Odds API 队名按变体正则匹配,替代旧 oddsHome/oddsAway 硬名单)
  let ou = null;
  if (m.wc && tot.ok && m.home.re && m.away.re) {
    const hRe = new RegExp(m.home.re, "i"), aRe = new RegExp(m.away.re, "i");
    const k = Object.keys(tot.byPair).find((kk) => { const [h, a] = kk.split("|"); return hRe.test(h) && aRe.test(a); });
    if (k) ou = tot.byPair[k];
  }
  // ESPN/DraftKings 盘口(亚盘/欧赔/大小球)按队名匹配(event name = "Away at Home")
  const espn = (m.home.re && m.away.re)
    ? espnOdds.find((x) => new RegExp(m.home.re, "i").test(x.name) && new RegExp(m.away.re, "i").test(x.name)) || null
    : null;
  // 俱乐部联赛(ESPN不覆盖如芬超)亚盘兜底:ESPN缺时用 The Odds API 让球线,挂 espnOdds.asian 供盘口锚/显示读(真线,不编)
  let espnFinal = espn;
  if (!espnFinal && CLUB_LEAGUE_SPORTKEY[m.comp]) {
    const ca = clubAsian[`${m.home.zh}|${m.away.zh}`];
    if (ca) espnFinal = {
      name: m.zh, provider: "The Odds API",
      asian: { line: ca.line, homeOdds: ca.homeOdds, awayOdds: ca.awayOdds, openLine: null },
      ml: null, total: null, _clubSource: ca.source,
    };
  }

  // 俱乐部联赛(ESPN不覆盖,如芬超)赛季战绩兜底:ESPN近5为空时,用真实积分榜补攻防/赛季战绩(诚实标"本季",非近5)
  const hLast5 = last5(hHist), aLast5 = last5(aHist);
  const hSeason = hLast5.length ? null : clubLeagueForm(m.home.zh, m.comp);
  const aSeason = aLast5.length ? null : clubLeagueForm(m.away.zh, m.comp);
  // ESPN无交锋时,用真实俱乐部联赛交锋史兜底(主队视角)
  const h2hFinal = (h2h && h2h.length) ? h2h : clubLeagueH2H(m.home.zh, m.away.zh, m.comp);

  out.matches.push({
    match: m.zh, comp: m.comp,
    home: { zh: m.home.zh, espn: ht?.name ?? null, abbr: ht?.abbr ?? null,
      last5: hLast5, record5: rec(hLast5), seasonForm: hSeason },
    away: { zh: m.away.zh, espn: at?.name ?? null, abbr: at?.abbr ?? null,
      last5: aLast5, record5: rec(aLast5), seasonForm: aSeason },
    h2h: h2hFinal,
    overUnder: ou ? { ...ou, source: "The Odds API (eu, 2.5线de-vig)" }
      : { source: m.wc ? "The Odds API 缺该场" : "❌ 无源(友谊赛The Odds API无key + odds.500退役)", line: null },
    espnOdds: espnFinal ? { ...espnFinal, source: espnFinal._clubSource ?? `ESPN/${espnFinal.provider}` } : null,
  });
}

function rec(g5) {
  const w = g5.filter((x) => x.res === "胜").length, d = g5.filter((x) => x.res === "平").length, l = g5.filter((x) => x.res === "负").length;
  const gf = g5.reduce((s, x) => s + x.gf, 0), ga = g5.reduce((s, x) => s + x.ga, 0);
  return { w, d, l, gf, ga, n: g5.length };
}

const dir = "D:/football-model-data/coverage";
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const outPath = join(dir, `${DATE}.json`);
// 重抓保留富集字段(2026-06-11 踩坑根修:重抓曾把 titan007 亚盘双源 asianHandicap 整批冲掉,亚盘20/24→4/24)——
// 本脚本不产这些字段,旧文件里有而新抓没有 → 按对阵保留;绝不覆盖本次新抓出的同名字段。
if (existsSync(outPath)) {
  try {
    const prev = JSON.parse(readFileSync(outPath, "utf8"));
    const prevBy = new Map((prev.matches ?? []).map((m) => [`${m.home?.zh}|${m.away?.zh}`, m]));
    for (const m of out.matches) {
      const old = prevBy.get(`${m.home?.zh}|${m.away?.zh}`);
      if (!old) continue;
      for (const k of ["asianHandicap", "euroRef"]) if (old[k] != null && m[k] == null) m[k] = old[k];
    }
  } catch { /* 旧文件坏=不保留,照常全新写 */ }
}
writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.error(`\n写入 ${outPath}`);
// 控制台摘要
for (const m of out.matches) {
  const hr = m.home.record5, ar = m.away.record5;
  console.log(`\n【${m.match}】(${m.comp})`);
  console.log(`  ${m.home.zh}近5: ${hr.n ? `${hr.w}胜${hr.d}平${hr.l}负 进${hr.gf}失${hr.ga}` : "❌未取到"} ${m.home.last5.map((x) => x.res + x.score).join(" ")}`);
  console.log(`  ${m.away.zh}近5: ${ar.n ? `${ar.w}胜${ar.d}平${ar.l}负 进${ar.gf}失${ar.ga}` : "❌未取到"} ${m.away.last5.map((x) => x.res + x.score).join(" ")}`);
  console.log(`  H2H: ${m.h2h.length ? m.h2h.map((x) => `${x.date} ${x.score}(${x.res})`).join(" | ") : "❌未取到"}`);
  console.log(`  大小球: ${m.overUnder.line ? `O/U ${m.overUnder.line} 大${(m.overUnder.pOver * 100).toFixed(0)}%/小${(m.overUnder.pUnder * 100).toFixed(0)}% [${m.overUnder.books}家] ${m.overUnder.source}` : m.overUnder.source}`);
}
