// 预测首发采集(2026-06-14,情报系统真空白模块)——把"赛前预测首发XI+阵型"落缓存供「情报详情」展示。
// 做法(全真实可追溯,零编造):对每场两队,用 ESPN 该队**近期已完赛的真实首发**(summary rosters)做频次聚合
//   → 最可能首发11人 + 众数阵型(src/match-intel.aggregatePredictedXI)。官方赛前阵容一出,展示层自动改用确认首发(✅)。
// 复用 deep-context 的 ESPN 解析(matchFixtureToEvent/espnCodeFor/球队 schedule/summary),不另造轮子。
// 缺即标缺:ESPN 不覆盖/无足够历史首发样本的队 → 该队 predicted=null,展示层标 ⚠️(不硬凑)。
//
// 用法:node scripts/sync-predicted-lineups.mjs [YYYY-MM-DD]  (缺省=本机 UTC+8 当日业务日)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import "../src/env.js";
import { getDataSubdir } from "../src/paths.js";
import { loadFixtures } from "../src/fixture-store.js";
import { espnCodeFor, matchFixtureToEvent } from "../src/deep-context.js";
import { aggregatePredictedXI } from "../src/match-intel.js";

const RECENT = Number(process.env.PREDICTED_XI_RECENT || 6); // 取近 N 场已完赛抽首发
const espnUrl = (code, path) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/${path}`;
async function espnJson(url, fetchImpl) {
  try { const r = await fetchImpl(url); return r.ok ? await r.json() : null; } catch { return null; }
}

// 从 summary 里抽取指定 teamId 的首发(已完赛=确认首发);无 rosters/未满阵=null(不臆造)。
function extractTeamLineup(summary, teamId) {
  const rosters = summary?.rosters;
  if (!Array.isArray(rosters)) return null;
  const r = rosters.find((x) => String(x?.team?.id) === String(teamId));
  if (!r) return null;
  const starters = (Array.isArray(r.roster) ? r.roster : [])
    .filter((p) => p?.starter)
    .map((p) => ({
      name: p.athlete?.displayName ?? p.athlete?.fullName ?? p.athlete?.shortName ?? "",
      position: p.position?.abbreviation ?? null,
    }))
    .filter((p) => p.name);
  if (starters.length < 11) return null;
  return { formation: r.formation ?? null, starters };
}

// fixture → ESPN 联赛码(复用 deep-context 映射;世界杯本地补 fifa.world,不改共享映射防链路打架)。
function codeForFixture(fx) {
  return espnCodeFor(fx.competition) || (/世界杯/.test(String(fx.competition ?? "")) ? "fifa.world" : null);
}
// scoreboard 查询日 = 真实开赛日(kickoff 优先,WC 预售场业务日≠比赛日);取不到退 fixture.date。
// 🔴时区:kickoff 是北京时间(无时区标注),而 ESPN scoreboard 按【美东 ET】日历分组——
//   凌晨开赛的北京场(如 6/15 01:00=ET 6/14 13:00)在 ESPN 落上一天。若直接取北京日期会查到错的一天、
//   matchFixtureToEvent 失败→该场情报恒空。故把带时刻的 kickoff 转成 ET 日期再查询。
export function scoreboardYmd(fx, fallback) {
  const t = String(fx.kickoff ?? "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (t) {
    const inst = new Date(`${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:00+08:00`); // 北京时间瞬时
    if (!Number.isNaN(inst.getTime())) {
      const et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(inst);
      return et.replace(/-/g, "");
    }
  }
  const m = String(fx.kickoff ?? "").match(/(\d{4})-(\d{2})-(\d{2})/) || String(fx.date ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : String(fallback).replace(/-/g, "");
}

// 某队近 RECENT 场已完赛的真实首发历史 → aggregatePredictedXI 输入。
// 跨多个联赛码取赛程合并(国家队近期热身/预选在 fifa.friendly/worldq.*,不在 fifa.world),event id 去重。
async function teamHistory(codes, teamId, fetchImpl, cache) {
  const ck = String(teamId);
  if (cache.has(ck)) return cache.get(ck);
  const seen = new Set();
  const events = [];
  for (const code of [...new Set(codes.filter(Boolean))]) {
    const sch = await espnJson(espnUrl(code, `teams/${teamId}/schedule`), fetchImpl);
    for (const e of (sch?.events || [])) {
      if (!e?.competitions?.[0]?.status?.type?.completed) continue;
      const eid = e?.id ?? e?.competitions?.[0]?.id;
      if (!eid || seen.has(String(eid))) continue;
      seen.add(String(eid));
      events.push({ e, code });
    }
  }
  events.sort((a, b) => String(a.e.date).localeCompare(String(b.e.date)));
  const recent = events.slice(-RECENT);
  const history = [];
  for (const { e, code } of recent) {
    const eid = e?.id ?? e?.competitions?.[0]?.id;
    const summary = await espnJson(espnUrl(code, `summary?event=${eid}`), fetchImpl);
    const lu = extractTeamLineup(summary, teamId);
    if (!lu) continue;
    const comp = e.competitions?.[0];
    const opp = (comp?.competitors || []).find((x) => String(x.team?.id) !== String(teamId))?.team?.displayName ?? null;
    history.push({ date: (e.date || "").slice(0, 10), opponent: opp, formation: lu.formation, starters: lu.starters });
  }
  const predicted = aggregatePredictedXI(history);
  cache.set(ck, predicted);
  return predicted;
}

async function main() {
  const date = process.argv.slice(2).find((a) => !a.startsWith("--"))
    || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") { console.error("当前 Node 不支持 fetch"); process.exit(1); }

  let fixtures = [];
  try { fixtures = loadFixtures(date).fixtures ?? []; } catch { fixtures = []; }
  if (!fixtures.length) { console.log(`⚠️ ${date} 无 fixtures,预测首发缓存空(不报错)。`); }

  const out = {};
  const histCache = new Map();
  const sbCache = new Map(); // `${code}:${ymd}` -> events(按开赛日抓 scoreboard,缓存复用)
  let resolved = 0, teamsWith = 0;
  for (const fx of fixtures) {
    const code = codeForFixture(fx);
    if (!code) continue;
    const ymd = scoreboardYmd(fx, date);
    const sck = `${code}:${ymd}`;
    let events = sbCache.get(sck);
    if (!events) {
      const sb = await espnJson(espnUrl(code, `scoreboard?dates=${ymd}`), fetchImpl);
      events = sb?.events || [];
      sbCache.set(sck, events);
    }
    const m = matchFixtureToEvent(fx, events);
    if (!m) continue;
    resolved += 1;
    const homeId = m.swapped ? m.awayId : m.homeId;
    const awayId = m.swapped ? m.homeId : m.awayId;
    // 国家队近期热身/预选赛程在 fifa.friendly / worldq.* —— 取赛程时多码合并(event 去重)。
    const histCodes = code === "fifa.world"
      ? [code, "fifa.friendly", "uefa.nations"]
      : [code];
    const [ph, pa] = await Promise.all([
      homeId ? teamHistory(histCodes, homeId, fetchImpl, histCache) : null,
      awayId ? teamHistory(histCodes, awayId, fetchImpl, histCache) : null,
    ]);
    if (ph) teamsWith += 1;
    if (pa) teamsWith += 1;
    out[`${fx.homeTeam}|${fx.awayTeam}`] = { home: ph, away: pa };
  }

  const dir = getDataSubdir("intel");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `predicted-lineups-${date}.json`);
  const payload = {
    date,
    generatedAt: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date()),
    source: "ESPN summary rosters(近期真实首发频次聚合,🔶预测·非官方)",
    recentMatches: RECENT,
    fixturesResolved: resolved,
    teamsWithPrediction: teamsWith,
    predicted: out,
  };
  writeFileSync(path, JSON.stringify(payload, null, 1), "utf8");
  console.log(`✅ 预测首发缓存:${path}`);
  console.log(`   ESPN解析场次=${resolved} · 出预测首发的队=${teamsWith}(覆盖有限属正常:ESPN不收的联赛/历史首发<2场的队标缺)`);
}

// 仅在直接运行时执行采集;被 import(如守护测试)时不触发,避免误打 ESPN/覆盖缓存。
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("预测首发采集失败(不阻断主交付):", e.message); process.exit(0); });
}
