#!/usr/bin/env node
/**
 * 世界杯赛果自动复盘校准闭环(2026-06-06)——开赛后每日"预测 vs 实际",让模型整届期间被验证/校准。
 * ════════════════════════════════════════════════════════════════════
 * 融进同一模型,不另起分离分析:用超算冻结的赛前预测基线(worldcup-forecast-baseline.json,
 * 首跑从 worldcup-supercomputer.json 冻结)对比真实赛果(fixture-store 2026/06-07 世界杯场,
 * 由 recap:backfill 的 fifa.world 码回填)→ 出晋级 Brier / 夺冠 logloss / 存活概率质量 / 最大爆冷。
 * 遵 no-fabrication:开赛前 0 场已踢 → 诚实空态(只冻结基线),绝不编赛果;阶段按真实赛程日期判。
 * 用法: node scripts/wc-recap.mjs [--json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { getExportDir } from "../src/paths.js";
import { pathToFileURL } from "node:url";

const SUPER = join(getExportDir(), "worldcup-supercomputer.json");
const BASELINE = join(getExportDir(), "worldcup-forecast-baseline.json");
const WC_START = "2026-06-11", WC_END = "2026-07-19";
// FIFA 2026 真实赛程日期分段(48队:小组6/11-6/27,后32强淘汰赛)。按 localDate 判阶段,稳健不靠 round 字段。
export const STAGE = (d) => d <= "2026-06-27" ? "group" : d <= "2026-07-03" ? "r32" : d <= "2026-07-07" ? "r16"
  : d <= "2026-07-11" ? "qf" : d <= "2026-07-15" ? "sf" : "final";
const KO = new Set(["r32", "r16", "qf", "sf", "final"]);
const pcf = (x) => (x * 100).toFixed(1) + "%";

/** 纯打分:赛前基线 rows + 已踢场 played[{stage,home,away,hg,ag}] → 校准指标。canon=队名归一函数。 */
export function computeWcRecap(baseRows, played, canon = (x) => String(x)) {
  const rank = { group: 0, r32: 1, r16: 2, qf: 3, sf: 4, final: 5 };
  const teamStage = new Map(); let champion = null;
  for (const m of played) {
    for (const t of [m.home, m.away]) { const k = canon(t); if ((rank[m.stage] ?? 0) > (rank[teamStage.get(k)] ?? -1)) teamStage.set(k, m.stage); }
    if (m.stage === "final") champion = canon(m.hg > m.ag ? m.home : m.ag > m.hg ? m.away : m.home);
  }
  const groupDone = played.filter((m) => m.stage === "group").length >= 72;
  let brierSum = 0, brierN = 0; const busts = [], hits = [];
  for (const r of baseRows) {
    const advanced = KO.has(teamStage.get(canon(r.en || r.team))) ? 1 : 0;
    if (groupDone) { brierSum += (r.advance - advanced) ** 2; brierN++; }
    if (groupDone && r.advance >= 0.6 && !advanced) busts.push(`${r.team}(预测出线${pcf(r.advance)}→出局)`);
    if (groupDone && r.advance <= 0.5 && advanced) hits.push(`${r.team}(预测${pcf(r.advance)}→出线)`);
  }
  const aliveMass = baseRows.filter((r) => { const s = teamStage.get(canon(r.en || r.team)); return !groupDone || KO.has(s) || !s; })
    .reduce((s, r) => s + r.champion, 0);
  const champRow = champion ? baseRows.find((r) => canon(r.en || r.team) === champion) : null;
  const stageDist = ["group", "r32", "r16", "qf", "sf", "final"].map((s) => [s, played.filter((m) => m.stage === s).length]);
  return { playedCount: played.length, groupDone, advanceBrier: brierN ? brierSum / brierN : null, aliveMass, champion, champRow, busts, hits, stageDist };
}

function runMain() {
// 1) 冻结/载入赛前预测基线
if (!existsSync(BASELINE)) {
  if (!existsSync(SUPER)) { console.log("无超算预测(先跑 run-worldcup-supercomputer.mjs --json),无法冻结基线。"); process.exit(0); }
  const sup = JSON.parse(readFileSync(SUPER, "utf8"));
  writeFileSync(BASELINE, JSON.stringify({ frozenFrom: "worldcup-supercomputer.json", n: sup.n, seed: sup.seed, rows: sup.rows }, null, 1));
  console.log(`✅ 已冻结赛前预测基线 → ${BASELINE}(${sup.rows.length}队)`);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8"));

// 2) 载入 2026 世界杯真实赛果(开赛前应为空)
const played = []; // {date,stage,home,away,hg,ag}
for (const d of listFixtureDates()) {
  if (d < WC_START || d > WC_END) continue;
  for (const f of loadFixtures(d).fixtures) {
    const isWC = (f.tags || []).includes("worldcup") || /世界杯|World Cup/i.test(f.competition || "");
    if (!isWC || !f.result) continue;
    played.push({ date: d, stage: STAGE(f.localDate || d), home: f.homeTeam, away: f.awayTeam, hg: f.result.home, ag: f.result.away });
  }
}

console.log(`\n=== 2026 世界杯赛果复盘校准(基线 N=${base.n}, ${played.length}/104 场已踢)===`);
if (!played.length) {
  console.log("开赛前(6/11)0 场已踢 —— 赛前预测基线已冻结,待开赛逐场验证。诚实空态,不编赛果。");
  console.log("冻结基线(前6):", base.rows.slice(0, 6).map(r => `${r.team} 夺冠${pcf(r.champion)}/出线${pcf(r.advance)}`).join(" · "));
  process.exit(0);
}

const R = computeWcRecap(base.rows, played, canonicalTeamName);
console.log(`阶段分布:`, R.stageDist.map(([s, n]) => `${s}:${n}`).join(" "));
if (R.groupDone) console.log(`出线预测校准 Brier=${R.advanceBrier.toFixed(4)}(越低越准) | 存活队夺冠概率质量=${pcf(R.aliveMass)}`);
else console.log(`小组赛进行中(${R.stageDist[0][1]}/72),出线校准待小组赛结束。`);
if (R.busts.length) console.log(`❌ 最大爆冷(高预测却出局):`, R.busts.slice(0, 5).join("、"));
if (R.hits.length) console.log(`✅ 黑马命中(低预测却出线):`, R.hits.slice(0, 5).join("、"));
if (R.champion) {
  const wr = R.champRow; const rk = [...base.rows].sort((a, b) => b.champion - a.champion).findIndex(r => canonicalTeamName(r.en || r.team) === R.champion) + 1;
  console.log(`🏆 冠军=${wr?.team ?? R.champion} | 赛前预测夺冠 ${wr ? pcf(wr.champion) : "?"}(logloss ${wr ? (-Math.log(Math.max(wr.champion, 1e-4))).toFixed(3) : "?"}) | 赛前排名第${rk}`);
}
if (process.argv.includes("--json")) {
  const p = join(getExportDir(), "worldcup-recap.json");
  writeFileSync(p, JSON.stringify({ playedCount: R.playedCount, groupDone: R.groupDone, advanceBrier: R.advanceBrier, aliveMass: R.aliveMass, champion: R.champion, busts: R.busts, hits: R.hits }, null, 1));
  console.log("已写 JSON:", p);
}
}

// 仅直接运行时执行 main(被 import 当库时不跑,避免测试时触发 I/O/process.exit)
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runMain();
