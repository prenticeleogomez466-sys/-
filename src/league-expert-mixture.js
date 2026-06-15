/**
 * 联赛专家混合层 / Mixture-of-League-Experts(2026-05-31)
 * ──────────────────────────────────────────────────
 * 用户方向:"每个联赛独立做一个小模型,汇总到大模型"。
 * 统计学正确实现 = 分层部分池化(partial pooling),而非各联赛完全独立(冷门联赛会过拟合)。
 *
 * 三个专家,按可靠度门控(gating)加权汇总:
 *   1) 联赛专家   hierarchical-poisson 已估的"本联赛进球率/主场优势"(内部已按样本向全局收缩)
 *   2) 类型专家   competition-type-model 的赛事性质系数(杯赛/友谊/欧冠/国家队 强度·平局·爆冷)
 *   3) 全局大模型 跨联赛 hyper-prior 兜底
 *
 * 门控权重 w_league = n / (n + K):
 *   - 英超 380 场/季 → w≈0.86,主要信本联赛
 *   - 友谊赛 50 场   → w≈0.45,一半往全局收
 *   - 英乙 5 场      → w≈0.08,几乎全靠全局(避免学噪声)
 *
 * 这就是"小模型汇总到大模型"的真实门控机制。是否驱动主推荐,以回测为准(见 backtest-league-mixture.mjs)。
 */
import { fitHierarchicalPoisson } from "./hierarchical-poisson.js";
import { competitionProfile } from "./competition-type-model.js";
import { canonicalLeague } from "./league-profile.js";

const round = (v) => Math.round(v * 10000) / 10000;

/**
 * 从"已拟合的 hierarchical-poisson 对象"直接取某联赛专家 + 门控权重。
 * 用于引擎里复用 ratingsBootstrap.hierarchical,无需重拟合。
 */
export function leagueExpertFromFitted(hp, competition, gateK = 60) {
  if (!hp?.getLeagueParams) return null;
  const key = canonicalLeague(competition) ?? competition;
  const lp = hp.getLeagueParams(key);
  const n = lp.samples ?? 0;
  const w = n / (n + gateK);
  return {
    league: key,
    samples: n,
    weight: round(w),
    reliable: lp.reliable ?? false,
    baseRate: lp.baseRate,
    homeAdvantage: lp.homeAdvantage,
    explain: n >= 20
      ? `本联赛历史 ${n} 场,信本联赛 ${(w * 100).toFixed(0)}%(其余向大模型收缩)`
      : n > 0
        ? `本联赛仅 ${n} 场,${(100 - w * 100).toFixed(0)}% 靠大模型先验兜底(防过拟合)`
        : `无本联赛历史样本,完全靠大模型全局先验`,
  };
}
