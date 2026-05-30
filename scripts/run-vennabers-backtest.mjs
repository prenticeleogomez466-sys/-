/**
 * Venn-Abers vs 单 isotonic · 校准留出回测(2026-05-31 学习轮 14)
 * ─────────────────────────────────────────────────────────────
 * 目的:Venn-Abers(对测试点加伪标签0/1各拟一条 isotonic → p0/p1,点估计 p1/(1-p0+p1)、
 *   区间[p0,p1])是否比现单 isotonic 校准更准。优才接生产 + 把区间作"信心区间"展示。
 *   遵 feedback-hitrate-closed-loop:数据驱动、不优不接。
 *
 * 校准对:football-data big-5,每场 市场收盘隐含热门概率(predicted)→ 热门是否兑现(hit)。
 *   这是 isotonicMapMarket 的生产域。70/30 时间留出。
 *
 * 用法:node scripts/run-vennabers-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;

const res = await loadFootballDataMatches({ leagues: BIG5 });
const pairs = [];
for (const m of res.matches) {
  const prob = m.oddsClose || m.odds;
  if (!prob || m.homeGoals == null) continue;
  const favIsHome = prob.home >= prob.away;
  const predicted = favIsHome ? prob.home : prob.away;
  if (!(predicted > 0.33)) continue; // 只看有热门方的场
  const hit = favIsHome ? m.homeGoals > m.awayGoals : m.awayGoals > m.homeGoals;
  pairs.push({ predicted, actual: hit ? 1 : 0, date: m.date });
}
pairs.sort((a, b) => (a.date < b.date ? -1 : 1));
const cut = Math.floor(pairs.length * 0.7);
const train = pairs.slice(0, cut), test = pairs.slice(cut);
console.log(`热门校准对 ${pairs.length};train ${train.length} / test ${test.length}\n`);

// 单 isotonic(现状)
const isoMap = buildIsotonicMap(train.map((p) => ({ predicted: p.predicted, actual: p.actual })));
const trainObs = train.map((p) => ({ predicted: p.predicted, actual: p.actual }));

// Venn-Abers:对测试点 s 加伪标签 0/1 各拟一次,p0/p1
function vennAbers(s) {
  const m0 = buildIsotonicMap([...trainObs, { predicted: s, actual: 0 }]);
  const m1 = buildIsotonicMap([...trainObs, { predicted: s, actual: 1 }]);
  const p0 = applyIsotonicMap(m0, s);
  const p1 = applyIsotonicMap(m1, s);
  const point = (1 - p0 + p1) > 0 ? p1 / (1 - p0 + p1) : (p0 + p1) / 2;
  return { p0, p1, point };
}

let bRaw = 0, lRaw = 0, bIso = 0, lIso = 0, bVA = 0, lVA = 0, widthSum = 0, n = 0;
for (const p of test) {
  const y = p.actual;
  const raw = p.predicted;
  const iso = applyIsotonicMap(isoMap, raw) ?? raw;
  const va = vennAbers(raw);
  const cl = (q) => Math.min(1 - EPS, Math.max(EPS, q));
  bRaw += (raw - y) ** 2; lRaw += -Math.log(cl(y ? raw : 1 - raw));
  bIso += (iso - y) ** 2; lIso += -Math.log(cl(y ? iso : 1 - iso));
  bVA += (va.point - y) ** 2; lVA += -Math.log(cl(y ? va.point : 1 - va.point));
  widthSum += (va.p1 - va.p0);
  n++;
}
console.log("热门兑现校准(越低越准):");
console.log(`  原始市场概率:    Brier ${(bRaw / n).toFixed(4)} | LogLoss ${(lRaw / n).toFixed(4)}`);
console.log(`  单 isotonic(现): Brier ${(bIso / n).toFixed(4)} | LogLoss ${(lIso / n).toFixed(4)}`);
console.log(`  Venn-Abers 点估计: Brier ${(bVA / n).toFixed(4)} | LogLoss ${(lVA / n).toFixed(4)}`);
console.log(`  Venn-Abers 平均区间宽度: ${(widthSum / n * 100).toFixed(2)}pp(= 校准不确定度,可作信心区间)`);
const dIso = (bIso / n - bVA / n);
console.log(`\n诚实结论:Venn-Abers 点估计 Brier ${dIso > 0.0002 ? "优于" : Math.abs(dIso) <= 0.0002 ? "≈持平" : "劣于"} 单 isotonic(差 ${(dIso * 1e4).toFixed(1)}e-4)。`);
console.log(`  ${Math.abs(dIso) <= 0.0002 ? "点估计基本持平 → 不替换基座(轮2结论:isotonic已稳);但区间是真新增价值,可作信心区间透明展示。" : dIso > 0 ? "点估计更优 → 可考虑替换 + 用区间。" : "点估计更差 → 保留现 isotonic。"}`);
