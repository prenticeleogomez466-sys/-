/**
 * 半全场"模型级"留出回测(2026-05-31)——比的是 HT/FT **概率映射**质量,不是经验频率。
 * 同一套 λ(DC 训练集拟合,leak-safe)喂给三个映射,只隔离半全场建模优劣:
 *   A  旧版:固定 firstHalfRatio=0.46、裸独立 Poisson、无 τ(prediction-engine.halfFullProbsFromLambdas)
 *   B0 升级-无状态:τ 低分修正 + 数据拟合半场比例,chase=0(两半独立)
 *   B1 升级-全开:B0 + 二半场状态依赖(chase=拟合默认)
 * 指标(9 类):LogLoss / 多类 Brier / argmax 命中 / 半时平局校准(预测 vs 实际)。
 * 用法:node scripts/run-halffull-model-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";
import { halfFullJoint, fitHalfFullParams } from "../src/halftime-fulltime-model.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const sg = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
const norm = (label) => label.replaceAll("主胜", "主").replaceAll("平局", "平").replaceAll("客胜", "客");
const CLASSES = ["主-主", "主-平", "主-客", "平-主", "平-平", "平-客", "客-主", "客-平", "客-客"];

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches
  .filter((m) => m.homeGoals != null && m.awayGoals != null && m.halfHome != null && m.halfAway != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
console.log(`big-5 有半场比分 ${all.length} 场`);

const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`train ${train.length}(${train[0].date}~${train.at(-1).date}) / test ${test.length}(${test[0].date}~${test.at(-1).date})`);

// 训练:DC 队力 + 半场比例参数
const fitted = fitFromMatches(train);
const hfParams = fitHalfFullParams(train);
console.log(`DC usable=${fitted.usable} teams=${Object.keys(fitted.teams || {}).length} | ${hfParams.note}`);

// 把 9 类字典转成 CLASSES 上的归一概率(键统一为 主/平/客)
function toClassProbs(dict) {
  const out = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  let s = 0;
  for (const [k, v] of Object.entries(dict || {})) {
    const nk = norm(k);
    if (nk in out) { out[nk] += v; s += v; }
  }
  if (s > 0) for (const c of CLASSES) out[c] /= s;
  return out;
}

const R = { firstHalfRatioHome: hfParams.firstHalfRatioHome, firstHalfRatioAway: hfParams.firstHalfRatioAway };
const arms = {
  "A 旧(0.46裸Poisson)": (lh, la) => toClassProbs(halfFullProbsFromLambdas(lh, la, 0.46)),
  "B0 τ+拟合比例 chase=0": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0 })),
  "B  +状态 chase=0.10": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0.10 })),
  "B  +状态 chase=0.18": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0.18 })),
  "B  +状态 chase=0.30": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0.30 })),
  "B  +状态 chase=0.45": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0.45 })),
  "C  无τ+拟合比例 chase=0": (lh, la) => toClassProbs(halfFullJoint(lh, la, { ...R, chase: 0, rho: 0 })),
};

const stat = Object.fromEntries(Object.keys(arms).map((k) => [k, { ll: 0, brier: 0, hit: 0, htDrawPred: 0 }]));
let n = 0, htDrawActual = 0;

for (const m of test) {
  const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.expectedGoals) continue;
  const lh = pred.expectedGoals.home, la = pred.expectedGoals.away;
  if (!Number.isFinite(lh) || !Number.isFinite(la)) continue;
  const actual = `${sg(m.halfHome, m.halfAway)}-${sg(m.homeGoals, m.awayGoals)}`;
  const htDraw = m.halfHome === m.halfAway;
  if (htDraw) htDrawActual++;
  n++;
  for (const [name, fn] of Object.entries(arms)) {
    const p = fn(lh, la);
    const pa = Math.max(p[actual] ?? 0, EPS);
    stat[name].ll += -Math.log(pa);
    // 多类 Brier
    for (const c of CLASSES) { const y = c === actual ? 1 : 0; stat[name].brier += (p[c] - y) ** 2; }
    // argmax 命中
    const top = CLASSES.reduce((b, c) => (p[c] > p[b] ? c : b), CLASSES[0]);
    if (top === actual) stat[name].hit++;
    // 半时平局预测概率(P(HT=平)= 平-* 三类之和)
    stat[name].htDrawPred += (p["平-主"] + p["平-平"] + p["平-客"]);
  }
}

console.log(`\n有效测试场次 ${n}(实际半时平局率 ${(htDrawActual / n * 100).toFixed(1)}%)\n`);
console.log("臂                        LogLoss   Brier    命中率   半时平局预测(实际" + (htDrawActual / n * 100).toFixed(1) + "%)");
for (const [name, s] of Object.entries(stat)) {
  console.log(
    name.padEnd(22),
    (s.ll / n).toFixed(4).padStart(8),
    (s.brier / n).toFixed(4).padStart(8),
    (s.hit / n * 100).toFixed(1).padStart(6) + "%",
    (s.htDrawPred / n * 100).toFixed(1).padStart(8) + "%",
  );
}
console.log("\n判读:LogLoss/Brier 越低越好;命中率(9 类 argmax)越高越好;半时平局预测越贴近实际越好(旧版裸 Poisson 通常低估半时平局)。");
