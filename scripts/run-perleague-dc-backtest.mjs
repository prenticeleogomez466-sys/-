/**
 * per-league DC vs 全局 DC · leak-safe walk-forward 回测(2026-05-31)
 * ─────────────────────────────────────────────────────────────
 * 同一批历史(football-data ALL_LEAGUES,带 league 字段)前向拟合,对每个测试日:
 *   A 全局:fitFromMatches(prior)        —— 所有联赛混在一个 DC
 *   B 分联赛:fitPerLeague(prior)         —— 每联赛独立 baseRate + 本联赛内归一
 * 对每场测试比赛用各自模型预测胜负平,比 命中 / RPS / 多类 Brier(总体 + 分层)。
 * RPS(有序结果的正确度量)越低越好。判读:per-league 在非五大/低级别联赛应更优。
 * 用法:node scripts/run-perleague-dc-backtest.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, fitPerLeague, predictFromFitted } from "../src/dixon-coles-engine.js";
import { calibrationSegment } from "../src/calibration-segments.js";

const REFIT = 7, MIN_TRAIN = 400, MAX_TRAIN = 3000;
const actual = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const daysBetween = (from, to) => Math.abs(Date.parse(to) - Date.parse(from)) / 86400000;
const round = (v) => Math.round(v * 100000) / 100000;

// RPS for ordered home>draw>away
function rps(p, outcome) {
  const order = ["home", "draw", "away"];
  const y = order.map((o) => (o === outcome ? 1 : 0));
  const pv = order.map((o) => p[o] ?? 0);
  let cumP = 0, cumY = 0, s = 0;
  for (let i = 0; i < 2; i++) { cumP += pv[i]; cumY += y[i]; s += (cumP - cumY) ** 2; }
  return s; // 0..1 (除以 K-1=2 省略,统一口径即可对比)
}
function brier(p, outcome) {
  return ["home", "draw", "away"].reduce((s, o) => s + ((p[o] ?? 0) - (o === outcome ? 1 : 0)) ** 2, 0);
}

console.log("加载 ALL_LEAGUES + walk-forward(leak-safe)...");
const loaded = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
if (!loaded.ok) { console.error("加载失败"); process.exit(1); }
const matches = loaded.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date && m.home && m.away)
  .sort((a, b) => a.date.localeCompare(b.date));
const dates = [...new Set(matches.map((m) => m.date))].sort();
console.log(`${matches.length} 场,${dates[0]}~${dates.at(-1)}`);

const arms = { A_global: {}, B_perleague: {} };
for (const k of Object.keys(arms)) arms[k] = { hit: 0, rps: 0, brier: 0, n: 0, bySeg: {} };
const segAdd = (arm, seg, key, v) => { (arm.bySeg[seg] ??= { hit: 0, rps: 0, brier: 0, n: 0 })[key] += v; };

let globalFit = null, plFit = null, lastFit = null;
let evald = 0;
for (const date of dates) {
  const prior = matches.filter((m) => m.date < date);
  if (prior.length < MIN_TRAIN) continue;
  if (!globalFit || daysBetween(lastFit, date) >= REFIT) {
    const train = prior.slice(-MAX_TRAIN);
    globalFit = fitFromMatches(train, { referenceDate: date });
    const withDays = train.map((m) => ({ ...m, daysAgo: daysBetween(m.date, date) }));
    plFit = fitPerLeague(withDays, { homeAdvantage: 1.24, minLeagueMatches: 80 });
    lastFit = date;
  }
  if (!globalFit?.usable) continue;
  for (const m of matches.filter((mm) => mm.date === date)) {
    const a = actual(m.homeGoals, m.awayGoals);
    const seg = calibrationSegment(m.league);
    const pa = predictFromFitted(globalFit, { homeTeam: m.home, awayTeam: m.away });
    const pb = predictFromFitted(plFit, { homeTeam: m.home, awayTeam: m.away, competition: m.league });
    if (!pa?.probabilities || !pb?.probabilities) continue;
    evald++;
    for (const [name, p] of [["A_global", pa.probabilities], ["B_perleague", pb.probabilities]]) {
      const arm = arms[name];
      const fav = ["home", "draw", "away"].reduce((b, o) => (p[o] > p[b] ? o : b), "home");
      const hit = fav === a ? 1 : 0, r = rps(p, a), br = brier(p, a);
      arm.hit += hit; arm.rps += r; arm.brier += br; arm.n++;
      segAdd(arm, seg, "hit", hit); segAdd(arm, seg, "rps", r); segAdd(arm, seg, "brier", br); segAdd(arm, seg, "n", 1);
    }
  }
}

console.log(`\n有效对比场次 ${evald}\n`);
console.log("臂            命中率    RPS      Brier");
for (const [name, arm] of Object.entries(arms)) {
  console.log(name.padEnd(12), (arm.hit / arm.n * 100).toFixed(2).padStart(6) + "%", round(arm.rps / arm.n).toFixed(4).padStart(8), round(arm.brier / arm.n).toFixed(4).padStart(8));
}
console.log("\n分层(段 | 场数 | 命中 全局→分联赛 | RPS 全局→分联赛):");
for (const seg of ["top5", "second", "otherTop", "intl"]) {
  const g = arms.A_global.bySeg[seg], b = arms.B_perleague.bySeg[seg];
  if (!g?.n) continue;
  const gh = g.hit / g.n * 100, bh = b.hit / b.n * 100, gr = g.rps / g.n, br = b.rps / b.n;
  const mark = br < gr ? "✅RPS改善" : (br > gr ? "❌RPS退化" : "=");
  console.log(`  ${seg.padEnd(8)} ${String(g.n).padStart(5)} | ${gh.toFixed(1)}%→${bh.toFixed(1)}% | ${gr.toFixed(4)}→${br.toFixed(4)} ${mark}`);
}
console.log("\nRPS 是有序胜负平的标准度量(越低越好);判读 per-league 是否真比全局优,尤其 otherTop/second。");
