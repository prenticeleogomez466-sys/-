/**
 * 回测:按联赛分层(收缩)到底比"全局一刀切"准不准?
 * 在 5221 场真实历史结果上,比较三个进球模型的 Poisson LogLoss(越低越好):
 *   M0 全局大模型:λ = 全局进球率(主队×主场优势)—— 一刀切
 *   M1 联赛独立(无收缩):λ = 本联赛原始进球率 —— 用户字面版(易过拟合)
 *   M2 分层收缩:λ = 本联赛向全局收缩后的进球率 —— 统计学正确版
 * 训练/测试 70/30 切分,只在测试集评估(防数据泄漏)。
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitHierarchicalPoisson } from "../src/hierarchical-poisson.js";

const matches = collectHistoricalMatches(400).filter(m => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals));
// 确定性切分(无随机):隔三取一进测试集
const train = [], test = [];
matches.forEach((m, i) => (i % 10 < 7 ? train : test).push(m));

// Poisson 对数似然(单边)
const lnFact = (k) => { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; };
const poissonNLL = (k, lam) => { lam = Math.max(0.05, lam); return -(k * Math.log(lam) - lam - lnFact(k)); };

// 拟合
const hp = fitHierarchicalPoisson(train);
// M1 需要原始(未收缩)联赛进球率 —— 自己从 train 数
const rawByLeague = {};
for (const m of train) {
  const l = m.league ?? "unknown";
  (rawByLeague[l] ??= { h: 0, a: 0, n: 0 });
  rawByLeague[l].h += m.homeGoals; rawByLeague[l].a += m.awayGoals; rawByLeague[l].n++;
}
const g = hp.global;

let nll0 = 0, nll1 = 0, nll2 = 0, n = 0;
for (const m of test) {
  const l = m.league ?? "unknown";
  // M0 全局
  const l0h = g.baseRate * g.homeAdvantage, l0a = g.baseRate;
  // M1 联赛独立(无收缩,样本少也硬用)
  const r = rawByLeague[l];
  const rawBase = r && r.n ? (r.h + r.a) / (2 * r.n) : g.baseRate;
  const rawAdv = r && r.a ? r.h / Math.max(0.01, r.a) : g.homeAdvantage;
  const l1h = rawBase * rawAdv, l1a = rawBase;
  // M2 分层收缩
  const lp = hp.getLeagueParams(l);
  const l2h = lp.baseRate * lp.homeAdvantage, l2a = lp.baseRate;

  nll0 += poissonNLL(m.homeGoals, l0h) + poissonNLL(m.awayGoals, l0a);
  nll1 += poissonNLL(m.homeGoals, l1h) + poissonNLL(m.awayGoals, l1a);
  nll2 += poissonNLL(m.homeGoals, l2h) + poissonNLL(m.awayGoals, l2a);
  n++;
}

const f = (x) => (x / n).toFixed(4);
console.log(`测试集 ${n} 场（训练 ${train.length}）`);
console.log(`M0 全局一刀切      LogLoss/场 = ${f(nll0)}`);
console.log(`M1 联赛独立(无收缩) LogLoss/场 = ${f(nll1)}`);
console.log(`M2 分层收缩(正确版) LogLoss/场 = ${f(nll2)}`);
const base = nll0 / n;
console.log(`\n相对全局一刀切:`);
console.log(`  M1 独立:  ${((nll1 / n - base) >= 0 ? "+" : "")}${(nll1 / n - base).toFixed(4)}  ${nll1 < nll0 ? "✅更好" : "❌更差(过拟合)"}`);
console.log(`  M2 收缩:  ${((nll2 / n - base) >= 0 ? "+" : "")}${(nll2 / n - base).toFixed(4)}  ${nll2 < nll0 ? "✅更好" : "❌更差"}`);
