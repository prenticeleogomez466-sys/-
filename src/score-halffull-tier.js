/**
 * 比分/半全场 信心分层(2026-06-02 通宵 cycle10)——选择性板块,把命中率杠杆操作化。
 * ────────────────────────────────────────────────────────────────
 * 实证(backtest-score-halffull-tiers,47037/23676 场 leak-safe holdout):
 *   按模型分布峰值(首选概率)分档,高信心档命中率显著更高。各档 hit 为该档**实测命中率**:
 *   比分(首选比分 exact 命中):≥14%→13.0% / 12-14%→12.4% / 10-12%→11.5% / 8-10%→9.7%
 *   半全场(9类首选命中):≥40%→43.2% / 35-40%→32.6% / 30-35%→30.7% / 25-30%→26.4% / <25%→22.0%
 * 用途:给每场比分/半全场 pick 贴"信心档+回测命中率",让用户只压高档(少出、出准)。
 *   遵 feedback-confidence-not-autosuppress:只贴档+提示,不替用户弃赛。
 */

const SCORE_TIERS = [
  { min: 0.14, hit: 0.130, label: "🟢高信心", banker: true },
  { min: 0.12, hit: 0.124, label: "🟡中高", banker: true },
  { min: 0.10, hit: 0.115, label: "🟡中", banker: false },
  { min: 0.08, hit: 0.097, label: "🟠偏低", banker: false },
  { min: 0.00, hit: 0.080, label: "⚪低(发散)", banker: false },
];
const HALFFULL_TIERS = [
  { min: 0.40, hit: 0.432, label: "🟢高信心", banker: true },
  { min: 0.35, hit: 0.326, label: "🟡中高", banker: true },
  { min: 0.30, hit: 0.307, label: "🟡中", banker: false },
  { min: 0.25, hit: 0.264, label: "🟠偏低", banker: false },
  { min: 0.00, hit: 0.220, label: "⚪低(发散)", banker: false },
];

function tierOf(tiers, prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return null;
  const t = tiers.find((x) => p >= x.min) ?? tiers[tiers.length - 1];
  return { label: t.label, backtestHit: t.hit, bankerEligible: t.banker, confidence: Math.round(p * 1000) / 1000 };
}

/** 比分首选概率 → 信心档(回测实测命中率)。 */
export function scoreConfidenceTier(primaryProbability) { return tierOf(SCORE_TIERS, primaryProbability); }
/** 半全场首选概率 → 信心档。 */
export function halfFullConfidenceTier(primaryProbability) { return tierOf(HALFFULL_TIERS, primaryProbability); }

export { SCORE_TIERS, HALFFULL_TIERS };
