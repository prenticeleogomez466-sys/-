#!/usr/bin/env node
/**
 * 赛果回填(2026-05-31 用户:"数据不全 全补上去")。
 *
 * 复盘里大量场次长期 pending——免费赛果源(OpenLigaDB/原 ESPN 子集)对国际赛/北欧/日职/
 * 欧冠/big-5/解放者杯等覆盖不全。本脚本用 ESPN 隐藏 JSON API(零授权、覆盖全球数十联赛)
 * 按**单日**抓完赛赛果,用 team-aliases.canonicalTeamName 把英文队名桥接到 store 里的中文
 * fixture,把真实 result 写进去 → recap:daily 即可逐场结算(sameTeam 走中文↔中文)。
 *
 * 只写"确有真实赛果且能可靠匹配"的场,匹配不上的如实报告留 pending(遵 no-fabrication)。
 * 全免费、Node 直连、不触付费源(遵 free-only)。
 *
 * 用法:
 *   node scripts/backfill-results.mjs --dry            # 扫 ledger 所有 pending 过去日期,只报告
 *   node scripts/backfill-results.mjs                  # 实写 store(过去日期,排除今天/未来)
 *   node scripts/backfill-results.mjs --date 2026-05-29
 */
import "../src/env.js";
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";
import { hasKickedOff, fixtureMatchDate } from "../src/kickoff-time.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { getExportDir } from "../src/paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

// 覆盖竞彩常见全部联赛的 ESPN 联赛码(单日 scoreboard)。fin.1 等可能无赛果,空跑无害。
const LEAGUES = [
  "fifa.world", // 世界杯正赛(2026-06-06 验证 ESPN 码=fifa.world,64场/届);不补则开赛后赛果回填不进、recap 结算不了
  "fifa.friendly", "fifa.worldq.uefa", "fifa.worldq.conmebol", "fifa.worldq.concacaf",
  "fifa.worldq.afc", "fifa.worldq.caf", "fifa.nations", "uefa.nations",
  "uefa.champions", "uefa.europa", "uefa.europa.conf", "uefa.super_cup",
  "eng.1", "eng.2", "eng.3", "eng.fa", "eng.league_cup",
  "esp.1", "esp.2", "esp.copa_del_rey", "ger.1", "ger.2", "ger.dfb_pokal",
  "ita.1", "ita.2", "ita.coppa_italia",
  "fra.1", "fra.2", "fra.coupe_de_france", "por.1", "ned.1", "ned.2", "bel.1", "tur.1", "sco.1", "gre.1",
  "swe.1", "nor.1", "den.1", "fin.1", "aut.1", "sui.1", "rus.1", "nor.2", "swe.2",
  "usa.1", "mex.1", "bra.1", "arg.1", "jpn.1", "kor.1", "ksa.1", "aus.1", "chn.1",
  "conmebol.libertadores", "conmebol.sudamericana",
];

const args = process.argv.slice(2);
const dry = args.includes("--dry");
// 匹配模式(2026-06-10 缺陷#2 收紧):默认 strict——只写双边(主↔主且客↔客)匹配,
// 丢弃单边锚定(home/away-anchored/nearest)。单边锚定靠"窗口内该队唯一"猜对家,
// 队名映射不全时易把比分写到错的场(HJK→火花教训;06-10 审计:42 条未开赛世界杯场
// 被单边锚定喂了热身赛假赛果)。仅显式 --loose 才允许单边锚定,且打醒目告警。
const loose = args.includes("--loose");
const strictOnly = !loose;
if (loose) {
  console.warn("⚠️⚠️ --loose:已启用单边锚定匹配(home/away-anchored/nearest)。");
  console.warn("⚠️⚠️ 该模式靠'窗口内该队唯一'猜对家,可能把别场比分写进 fixture(06-10 假赛果事故根因)。");
  console.warn("⚠️⚠️ 仅限人工核对场景;自动化任务一律默认 strict。\n");
}
const dateArg = (() => { const i = args.indexOf("--date"); return i >= 0 ? args[i + 1] : null; })();
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

// 国家队英→中补充(team-aliases 没收国家队;ESPN 友谊赛/世预赛用得上)。
// 键=canonicalTeamName 对英文名归一后的形态(小写无空格),值=中文短名。
const NATION = {
  switzerland: "瑞士", jordan: "约旦", germany: "德国", finland: "芬兰",
  unitedstates: "美国", usa: "美国", senegal: "塞内加尔", brazil: "巴西", panama: "巴拿马",
  bulgaria: "保加利亚", montenegro: "黑山", norway: "挪威", sweden: "瑞典",
  turkey: "土耳其", turkiye: "土耳其", northmacedonia: "北马其顿", austria: "奥地利",
  tunisia: "突尼斯", colombia: "哥伦比亚", costarica: "哥斯达黎加", canada: "加拿大",
  uzbekistan: "乌兹别克斯坦", mexico: "墨西哥", australia: "澳大利亚", scotland: "苏格兰",
  curacao: "库拉索", southkorea: "韩国", korearepublic: "韩国", japan: "日本", iceland: "冰岛",
  nigeria: "尼日利亚", ecuador: "厄瓜多尔", saudiarabia: "沙特阿拉伯", iran: "伊朗", iraq: "伊拉克",
  gambia: "冈比亚", andorra: "安道尔", southafrica: "南非", nicaragua: "尼加拉瓜",
  bosniaherzegovina: "波黑", zimbabwe: "津巴布韦", india: "印度", jamaica: "牙买加",
  trinidadandtobago: "特立尼达和多巴哥", england: "英格兰", france: "法国", spain: "西班牙",
  italy: "意大利", portugal: "葡萄牙", netherlands: "荷兰", belgium: "比利时", croatia: "克罗地亚",
  argentina: "阿根廷", uruguay: "乌拉圭", chile: "智利", peru: "秘鲁", paraguay: "巴拉圭",
  poland: "波兰", denmark: "丹麦", serbia: "塞尔维亚", wales: "威尔士", ireland: "爱尔兰",
  morocco: "摩洛哥", egypt: "埃及", ghana: "加纳", cameroon: "喀麦隆", ivorycoast: "科特迪瓦",
  algeria: "阿尔及利亚", qatar: "卡塔尔", uae: "阿联酋", china: "中国", venezuela: "委内瑞拉",
  bolivia: "玻利维亚", honduras: "洪都拉斯", elsalvador: "萨尔瓦多", greece: "希腊",
  czechia: "捷克", czechrepublic: "捷克", hungary: "匈牙利", romania: "罗马尼亚", ukraine: "乌克兰",
  slovenia: "斯洛文尼亚", slovakia: "斯洛伐克", albania: "阿尔巴尼亚", israel: "以色列",
  newzealand: "新西兰", kosovo: "科索沃", luxembourg: "卢森堡", kazakhstan: "哈萨克斯坦",
};
// 俱乐部英→中桥(2026-06-06):ESPN 有赛果但 canonicalTeamName 桥不起来的联赛(美职/挪超/瑞超/英冠)。
// 键 = canonicalTeamName(ESPN 英文名) 的归一形态(或其内置中文如博多格林特/南安普顿),
// 值 = 对应 fixture 中文队名的 canonical 形态(实测自 src/team-aliases.js,如夏洛特fc/洛杉矶fc/萨普斯堡)。
// 只收已逐场用 ESPN scoreboard 真名核对过的映射;strict 双边匹配,任一边不在表内则留 pending(宁缺勿假)。
const CLUB = {
  // 美职 MLS
  minnesotaunitedfc: "明尼苏达", realsaltlake: "盐湖城", charlottefc: "夏洛特fc",
  newenglandrevolution: "新英格兰", dcunited: "华盛顿", cfmontreal: "蒙特利尔",
  nashvillesc: "纳什维尔", newyorkcityfc: "纽约城", portlandtimbers: "波特兰",
  sanjoseearthquakes: "圣何塞", intermiamicf: "迈国际", philadelphiaunion: "费城",
  lafc: "洛杉矶fc", seattlesoundersfc: "西雅图",
  // 英冠
  hullcity: "赫尔城", middlesbrough: "米堡", 南安普顿: "南安普敦",
  // 挪超
  博多格林特: "博德闪耀", skbrann: "布兰", kristiansundbk: "克里斯蒂",
  vikingfk: "维京", sarpsborgfk: "萨普斯堡",
  // 瑞超
  gais: "哥德堡盖斯", kalmarff: "卡尔马",
};
function ck(name) { const c = canonicalTeamName(name); return CLUB[c] ?? NATION[c] ?? c; }

// 双向子串匹配(对齐 recap 的 sameTeam):相等 或 一方包含另一方(长度≥2 防误配)。
function teamLike(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  return false;
}
// 在 ESPN 池匹配。优先级:
//  ① 严格双边(主↔主 且 客↔客)—— 最稳。
//  ② 主队锚定唯一:窗口内只有一场该主队的比赛 → 即此场(一队一个比赛日只踢一场)。
//     用于 ESPN 客队英文名不映射中文(Hamarkameratene/IK Start)但主队能映射的北欧/沙特等。
//  ③ 客队锚定唯一:对称兜底(主队名才是难映射的少数场)。
// 不翻转主客(避免比分颠倒)。多candidate时取开赛日最接近 targetDate 的。
function findEspn(pool, canonHome, canonAway, targetIso, strict_ = strictOnly) {
  const strict = pool.filter((m) => teamLike(canonHome, m.ch) && teamLike(canonAway, m.ca));
  if (strict.length) return { m: nearest(strict, targetIso), how: "strict" };
  if (strict_) return null; // strict-only: 不退化到单边锚定
  const byHome = pool.filter((m) => teamLike(canonHome, m.ch));
  if (byHome.length === 1) return { m: byHome[0], how: "home-anchored" };
  const byAway = pool.filter((m) => teamLike(canonAway, m.ca));
  if (byAway.length === 1) return { m: byAway[0], how: "away-anchored" };
  // 主队多candidate(窗口内踢两场):取开赛日最接近的
  if (byHome.length > 1) { const n = nearest(byHome, targetIso); if (n) return { m: n, how: "home-nearest" }; }
  return null;
}
function nearest(list, targetIso) {
  if (!targetIso) return list[0];
  const t = Date.parse(targetIso + "T00:00:00Z");
  return list.slice().sort((a, b) => Math.abs(Date.parse(a.d + "T00:00:00Z") - t) - Math.abs(Date.parse(b.d + "T00:00:00Z") - t))[0];
}

// 抓单日单联赛完赛赛果(含半场,若 linescores 提供)
async function fetchLeagueDay(league, yyyymmdd) {
  const out = [];
  try {
    const r = await fetch(`${BASE}/${league}/scoreboard?dates=${yyyymmdd}`, { headers: UA });
    if (!r.ok) return out;
    const json = await r.json();
    for (const ev of json?.events ?? []) {
      if (!ev?.status?.type?.completed) continue;
      const comp = ev.competitions?.[0];
      const cs = comp?.competitors ?? [];
      const home = cs.find((c) => c.homeAway === "home");
      const away = cs.find((c) => c.homeAway === "away");
      if (!home || !away) continue;
      const hg = Number(home.score), ag = Number(away.score);
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      // 半场(若 linescores 有分节):period 1 = 上半场
      const hHalf = Number(home.linescores?.[0]?.value);
      const aHalf = Number(away.linescores?.[0]?.value);
      out.push({
        league,
        home: home.team?.displayName ?? home.team?.name,
        away: away.team?.displayName ?? away.team?.name,
        hg, ag,
        halfHome: Number.isFinite(hHalf) ? hHalf : undefined,
        halfAway: Number.isFinite(aHalf) ? aHalf : undefined,
      });
    }
  } catch { /* 单联赛失败跳过 */ }
  return out;
}

async function fetchAllForDay(yyyymmdd) {
  const all = [];
  // 并发抓,控制并发数避免被限流
  const batchSize = 8;
  for (let i = 0; i < LEAGUES.length; i += batchSize) {
    const batch = LEAGUES.slice(i, i + batchSize);
    const res = await Promise.all(batch.map((lg) => fetchLeagueDay(lg, yyyymmdd)));
    for (const arr of res) all.push(...arr);
  }
  return all;
}

// 决定要处理的日期集合
function pendingDates() {
  const led = JSON.parse(readFileSync(join(getExportDir(), "recommendation-ledger.json"), "utf8"));
  const set = new Set();
  for (const r of led) {
    const done = r.actualStatus === "settled" || (r.actual && r.actual !== "");
    if (!done && r.date && r.date < todayIso) set.add(r.date); // 排除今天/未来(没踢完)
  }
  return [...set].sort();
}

const dates = dateArg ? [dateArg] : pendingDates();
if (!dates.length) { console.log("无待回填的过去日期。"); process.exit(0); }

console.log(`回填日期(${dates.length}):${dates.join(", ")}${dry ? "  [DRY-RUN 不写盘]" : ""}\n`);

let grandMatched = 0, grandPending = 0;
const stillMissing = [];

for (const date of dates) {
  const yyyymmdd = date.replaceAll("-", "");
  const store = loadFixtures(date);
  const fixtures = store.fixtures;
  // 开赛闸(2026-06-10 缺陷#1#2):未开赛(kickoff>now)或 kickoff 不可解析的场绝不回填——
  // 没踢的比赛不存在真实赛果,任何"命中"都是错配(42 条世界杯假赛果事故根因之一)。
  const noResult = fixtures.filter((f) => !f.result);
  const notKickedOff = noResult.filter((f) => !hasKickedOff(f));
  const need = noResult.filter((f) => hasKickedOff(f));
  if (notKickedOff.length) {
    console.log(`${date}: 跳过 ${notKickedOff.length} 场未开赛/开赛时刻不可判定的场(绝不回填):`);
    for (const f of notKickedOff) console.log(`    ⏳ ${f.sequence ?? ""} ${f.homeTeam} vs ${f.awayTeam}  kickoff=${JSON.stringify(f.kickoff ?? "")}`);
  }
  if (!need.length) { console.log(`${date}: 无已开赛且缺 result 的场,跳过`); continue; }

  // ESPN 赛果索引:覆盖 ±2 天(竞彩业务日常比实际开赛日早 1-2 天,实测 5-21 预测→5-23 实际)
  const results = [];
  for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
    results.push(...await fetchAllForDay(shiftDay(yyyymmdd, delta)));
  }
  // 预算 ESPN 池的 canonical 主客名
  const pool = results.map((m) => ({ ...m, ch: ck(m.home), ca: ck(m.away) }));

  let matched = 0;
  const howCount = { strict: 0, "home-anchored": 0, "away-anchored": 0, "home-nearest": 0 };
  const updated = fixtures.map((f) => {
    if (f.result || !hasKickedOff(f)) return f; // 未开赛绝不写 result(同 need 闸,双保险)
    const hit = findEspn(pool, ck(f.homeTeam), ck(f.awayTeam), fixtureMatchDate(f) ?? date);
    if (!hit) return f;
    const m = hit.m;
    matched++; howCount[hit.how] = (howCount[hit.how] ?? 0) + 1;
    const result = { home: m.hg, away: m.ag };
    if (Number.isFinite(m.halfHome) && Number.isFinite(m.halfAway)) { result.halfHome = m.halfHome; result.halfAway = m.halfAway; }
    return { ...f, result };
  });

  for (const f of need) {
    if (!findEspn(pool, ck(f.homeTeam), ck(f.awayTeam), fixtureMatchDate(f) ?? date)) {
      stillMissing.push(`${date} ${f.competition ?? ""} ${f.homeTeam} vs ${f.awayTeam}  [canon ${ck(f.homeTeam)}|${ck(f.awayTeam)}]`);
    }
  }

  grandMatched += matched;
  grandPending += need.length - matched;
  const howStr = Object.entries(howCount).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`${date}: 待回填 ${need.length} → ESPN 命中 ${matched}(${howStr}),仍缺 ${need.length - matched}(池 ${results.length} 场)`);

  if (!dry && matched > 0) {
    saveFixtures(date, updated, { source: "espn-backfill", allowEmpty: false });
  }
}

console.log(`\n合计:命中回填 ${grandMatched} 场,仍缺 ${grandPending} 场`);
if (stillMissing.length) {
  console.log(`\n仍缺(匹配不上 ESPN,留 pending):`);
  for (const s of stillMissing.slice(0, 60)) console.log("  -", s);
  if (stillMissing.length > 60) console.log(`  …还有 ${stillMissing.length - 60} 场`);
}

function shiftDay(yyyymmdd, delta) {
  const y = Number(yyyymmdd.slice(0, 4)), m = Number(yyyymmdd.slice(4, 6)), d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}
