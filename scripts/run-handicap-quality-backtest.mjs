// 让球(亚盘)玩法模型质量回测(过夜轮16)——核心竞彩玩法,带符号 sanity check 防约定错。
// ───────────────────────────────────────────────────────────────────────────
// football-data asian: {line, homeWaterClose, awayWaterClose, lineClose}(收盘)。
//   约定:line 为主队让球数,主过盘 = (主净胜 > line),push = (==),客过盘 = (<)。
//   模型 handicapCoverFromMatrix(matrix, L) 内部 adj=h+L → 主过盘当 主净胜 > -L,故传 -lineClose 对齐。
// ⚠ sanity check:实际主队过盘率 ≈ 模型平均主队过盘概率(差<3pp)才信结果;否则符号/约定错,如实报。
// 测:模型让球命中 vs 市场收盘隐含(去vig);分歧下注有无 edge。
// 跑法:node scripts/run-handicap-quality-backtest.mjs
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { handicapCoverFromMatrix } from "../src/derived-score-model.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => m.asian && Number.isFinite(m.asian.lineClose) && Number.isFinite(m.asian.homeWaterClose) && Number.isFinite(m.asian.awayWaterClose) && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场(带收盘亚盘线+水位)`);

// 实际过盘(主视角):>line 主过 / ==line push / <line 客过。整数/半盘;此处只取非 push 的二元结算(push 跳过)。
function actualCover(m) {
  const margin = m.homeGoals - m.awayGoals;
  const L = m.asian.lineClose;
  if (margin > L) return "home";
  if (margin < L) return "away";
  return "push";
}
// 市场收盘隐含(去vig)主过盘概率
function marketHomeCover(m) {
  const hw = m.asian.homeWaterClose, aw = m.asian.awayWaterClose;
  const ih = 1 / hw, ia = 1 / aw;
  return ih / (ih + ia);
}

const agg = { n: 0, modelHit: 0, marketHit: 0, brierModel: 0, brierMarket: 0 };
let actualHomeCover = 0, modelHomeProbSum = 0, sanN = 0;
const THRS = [0.05, 0.10];
const disagree = THRS.map((t) => ({ thr: t, n: 0, won: 0, impliedSum: 0 }));

let curYm = null, fit = null;
for (let i = 0; i < usable.length; i++) {
  const m = usable[i];
  const ym = String(m.date).slice(0, 7);
  if (ym !== curYm) {
    const prior = usable.slice(0, i);
    if (prior.length >= minTrain) { const f = fitFromMatches(prior.slice(-maxTrain), { referenceDate: m.date }); if (f?.usable) fit = f; }
    curYm = ym;
  }
  if (!fit) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.matrix) continue;
  const cover = handicapCoverFromMatrix(pred.matrix, -m.asian.lineClose); // 符号对齐
  if (!cover?.cover) continue;
  const pHome = cover.cover.home, pAway = cover.cover.away;
  const denom = pHome + pAway || 1;
  const pModelHome = pHome / denom;           // 去 push 归一,二元主/客过盘
  const pMarketHome = marketHomeCover(m);
  const act = actualCover(m);
  // sanity:累计实际主过率 vs 模型主过率(含 push 的全样本)
  sanN++; if (act === "home") actualHomeCover++; modelHomeProbSum += pHome;
  if (act === "push") continue; // push 退款,不计命中
  const homeWon = act === "home";
  agg.n++;
  if ((pModelHome >= 0.5) === homeWon) agg.modelHit++;
  if ((pMarketHome >= 0.5) === homeWon) agg.marketHit++;
  agg.brierModel += (pModelHome - (homeWon ? 1 : 0)) ** 2;
  agg.brierMarket += (pMarketHome - (homeWon ? 1 : 0)) ** 2;
  for (const d of disagree) {
    if (Math.abs(pModelHome - pMarketHome) >= d.thr) {
      const betHome = pModelHome > pMarketHome;
      d.n++; if (betHome === homeWon) d.won++;
      d.impliedSum += betHome ? pMarketHome : (1 - pMarketHome);
    }
  }
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const sanActual = actualHomeCover / sanN, sanModel = modelHomeProbSum / sanN;
console.log(`\n=== 符号 sanity check ===`);
console.log(`实际主队过盘率 ${pct(sanActual)} vs 模型平均主过盘概率 ${pct(sanModel)} · 差 ${((sanModel - sanActual) * 100).toFixed(1)}pp ${Math.abs(sanModel - sanActual) < 0.03 ? "✅ 对齐可信" : "⚠ 偏差大,符号/约定可疑,下方结果存疑"}`);

const _marketHit = agg.marketHit / agg.n, _modelHit = agg.modelHit / agg.n;
const _suspect = _marketHit < 0.5 || _modelHit > 0.65; // 市场侧约定坏 → 内联 edge 标记不可信
console.log(`\n=== 让球模型 vs 市场收盘亚盘线(去 push,n=${agg.n})===`);
console.log(`模型命中 ${pct(_modelHit)} / Brier ${(agg.brierModel / agg.n).toFixed(4)}`);
console.log(`市场命中 ${pct(_marketHit)} / Brier ${(agg.brierMarket / agg.n).toFixed(4)}`);
console.log("\n=== 分歧下注(跟模型主/客过盘)===");
for (const d of disagree) {
  if (!d.n) { console.log(`${d.thr}: 0`); continue; }
  const win = d.won / d.n, implied = d.impliedSum / d.n;
  const mark = _suspect ? "(存疑·见下方 INCONCLUSIVE)" : (win - implied >= 0.02 ? "✅edge" : "≈/<市场");
  console.log(`阈值${d.thr}: n=${d.n} 跟模型命中 ${pct(win)} vs 市场隐含 ${pct(implied)} · 差 ${((win - implied) * 100).toFixed(1)}pp ${mark}`);
}
// 可信度护栏(2026-06-01):有效市场的隐含概率**不可能**预测得比随机差,故 marketHit<50% = 市场侧
//   (亚盘 line 符号约定↔水位列)不一致的 bug;让球命中>65%/分歧 edge>5pp 同样物理不可信
//   (与整夜铁证"模型=市场跟随器·无 edge"矛盾)。此时**自标 INCONCLUSIVE,绝不把假 edge 当真发现**
//   (遵 feedback-no-fabrication-live-only / reference-signal-backtest-findings)。
const marketHit = agg.marketHit / agg.n;
const modelHit = agg.modelHit / agg.n;
const maxEdge = Math.max(...disagree.map((d) => (d.n ? d.won / d.n - d.impliedSum / d.n : 0)));
const implausible = marketHit < 0.5 || modelHit > 0.65 || maxEdge > 0.05;
if (implausible) {
  console.log("\n⚠ INCONCLUSIVE:结果物理不可信(市场命中<50% 或 让球命中>65% 或分歧 edge>5pp)。");
  console.log("  根因 = football-data 亚盘 line 符号约定与水位列(AHCh/AHCa)不一致,非真 edge。");
  console.log("  sanity check 仅比对模型↔实际(同约定自洽),漏了市场↔实际,故被骗;**不采信本结果、不接任何让球信号**。");
  console.log("  让球玩法生产以胜负平为锚(feedback-wld-anchor-inference),独立让球 edge 不成立(同 1X2 无 edge)。");
} else {
  console.log("\n诚实判读:sanity ✅ 且结果物理可信;模型≈市场=高效;分歧>2pp 才 edge。");
}
