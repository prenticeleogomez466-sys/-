/**
 * 分段校准 vs 全局校准 · leak-safe 回测(② 验证,2026-05-31)
 * ─────────────────────────────────────────────────────────────
 * 流程:
 *   1. walk-forward(防泄漏,refit 节流)收集每场 favorite 的 (predicted, hit, segment) 对;
 *   2. 把 pair 按时间 70/30 切;train 段学 全局 isotonic + 各段 isotonic;
 *   3. test 段评估两种校准:校准误差 |E[cal]-实际命中|(分桶)+ Brier(favorite)+ 命中。
 * 判读:非 top5 段(otherTop/second)校准误差应下降,top5 不退化 → 分段有效。
 * 用法:node scripts/run-segmented-calibration-backtest.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted, blendWithOdds } from "../src/dixon-coles-engine.js";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";
import { calibrationSegment, CALIBRATION_SEGMENTS } from "../src/calibration-segments.js";

const REFIT = 7, MIN_TRAIN = 400, MAX_TRAIN = 2000;
const fav = (p) => { const k = ["home", "draw", "away"].reduce((b, o) => (p[o] > p[b] ? o : b), "home"); return { key: k, p: p[k] }; };
const actual = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const round = (v) => Math.round(v * 10000) / 10000;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

console.log("加载全联赛 + walk-forward 收集 favorite 校准对(leak-safe)...");
const loaded = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
if (!loaded.ok) { console.error("加载失败"); process.exit(1); }
const matches = loaded.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const dates = [...new Set(matches.map((m) => m.date))].sort();

const pairs = [];           // { predicted, hit, seg, date, market:bool }
let fit = null, lastFit = null;
const daysBetween = (a, b) => Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
for (const date of dates) {
  const prior = matches.filter((m) => m.date < date);
  if (prior.length < MIN_TRAIN) continue;
  if (!fit || daysBetween(lastFit, date) >= REFIT) {
    const f = fitFromMatches(prior.slice(-MAX_TRAIN), { referenceDate: date });
    if (f?.usable) { fit = f; lastFit = date; }
  }
  if (!fit) continue;
  for (const m of matches.filter((mm) => mm.date === date)) {
    const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities) continue;
    const a = actual(m.homeGoals, m.awayGoals);
    const seg = calibrationSegment(m.league);
    const df = fav(pred.probabilities);
    pairs.push({ predicted: df.p, hit: df.key === a ? 1 : 0, seg, date, market: false });
    if (m.odds) {
      const bp = blendWithOdds(m.odds, pred, { competition: m.league }).probabilities ?? m.odds;
      const bf = fav(bp);
      pairs.push({ predicted: bf.p, hit: bf.key === a ? 1 : 0, seg, date, market: true });
    }
  }
}
console.log(`收集 ${pairs.length} 对(${dates[0]}~${dates.at(-1)})`);

// 只看 DC 路径(无赔率)——分段价值最大(市场路径近恒等)
const dc = pairs.filter((p) => !p.market).sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(dc.length * 0.7);
const train = dc.slice(0, cut), test = dc.slice(cut);
console.log(`DC 路径 train ${train.length} / test ${test.length}\n`);

const globalMap = buildIsotonicMap(train.map((p) => ({ predicted: p.predicted, actual: p.hit })));
const segMaps = {};
for (const s of CALIBRATION_SEGMENTS) {
  const sub = train.filter((p) => p.seg === s);
  segMaps[s] = sub.length >= 300 ? buildIsotonicMap(sub.map((p) => ({ predicted: p.predicted, actual: p.hit }))) : null;
  console.log(`段 ${s.padEnd(8)} train ${sub.length} → ${segMaps[s] ? "有段图" : "样本不足,回退全局"}`);
}

// 评估:校准误差 ECE(10 桶)+ Brier
function evalArm(rows, mapper) {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, h: 0, n: 0 }));
  let brier = 0;
  for (const r of rows) {
    const cal = mapper(r);
    const bi = Math.min(9, Math.floor(cal * 10));
    bins[bi].p += cal; bins[bi].h += r.hit; bins[bi].n++;
    brier += (cal - r.hit) ** 2;
  }
  let ece = 0, N = rows.length;
  for (const b of bins) if (b.n) ece += (b.n / N) * Math.abs(b.p / b.n - b.h / b.n);
  return { ece: round(ece), brier: round(brier / N), n: N };
}

console.log("\n=== 逐段:全局校准 vs 分段校准(ECE 校准误差越低越好,Brier 越低越好)===");
console.log("段        样本   ECE全局  ECE分段   Δ      Brier全局 Brier分段");
for (const s of CALIBRATION_SEGMENTS) {
  const rows = test.filter((p) => p.seg === s);
  if (!rows.length) { console.log(`${s.padEnd(8)} 0`); continue; }
  const g = evalArm(rows, (r) => applyIsotonicMap(globalMap, r.predicted) ?? r.predicted);
  const d = evalArm(rows, (r) => applyIsotonicMap(segMaps[s] ?? globalMap, r.predicted) ?? r.predicted);
  const better = d.ece < g.ece ? "✅" : (d.ece > g.ece ? "❌" : "=");
  console.log(`${s.padEnd(8)} ${String(g.n).padStart(5)}  ${g.ece.toFixed(4)}  ${d.ece.toFixed(4)}  ${better}${(g.ece - d.ece >= 0 ? "+" : "")}${(g.ece - d.ece).toFixed(4)}  ${g.brier.toFixed(4)}   ${d.brier.toFixed(4)}`);
}
const gAll = evalArm(test, (r) => applyIsotonicMap(globalMap, r.predicted) ?? r.predicted);
const dAll = evalArm(test, (r) => applyIsotonicMap(segMaps[r.seg] ?? globalMap, r.predicted) ?? r.predicted);
console.log(`\n全体     ${String(gAll.n).padStart(5)}  ${gAll.ece.toFixed(4)}  ${dAll.ece.toFixed(4)}  ${(gAll.ece - dAll.ece >= 0 ? "✅+" : "❌")}${(gAll.ece - dAll.ece).toFixed(4)}  ${gAll.brier.toFixed(4)}   ${dAll.brier.toFixed(4)}`);
