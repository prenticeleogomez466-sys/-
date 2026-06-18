/**
 * 选择分层(2026-05-31)—— 把"命中的真正杠杆=选择"操作化。
 * ────────────────────────────────────────────────────────────
 * 实证(run-selection-tier-backtest,ALL_LEAGUES 33263 场,leak-safe):
 *   命中率算在"你选择下注的子集"上才有意义。按**市场隐含热门概率**(去vig)分档,
 *   档内命中率单调上升;而"模型是否同向"在高档内对命中**无提升**(模型≈市场,98.7%同向)。
 *   ⇒ 选择信号是市场隐含概率,不是模型信心。下表 hit 为各"≥下限"累计实测命中率:
 *
 *     市场热门概率 ≥0.80 → 88.2%(覆盖 1.9%)
 *                  ≥0.72 → 82.2%(6.0%)
 *                  ≥0.65 → 77.6%(12.2%)
 *                  ≥0.55 → 69.2%(27.6%)
 *                  ≥0.45 → 59.4%(56.8%)
 *                  全样本 → 51.3%(100%)
 *
 * 用途:给每场推荐贴"档位 + 回测命中率",让 14场胆码/任选9 单选只压高档;
 *   不替用户弃赛(遵 feedback-confidence-not-autosuppress),只给经数据验证的分层信息。
 *
 * ── 跨联赛迁移验证(2026-06-18 工作流①, backtest-tier-cross-league, 五大12458场 vs 其它/弱联赛29977场)──
 *   ✅ 中低档 T3-T6 跨联赛**完全一致**(偏差≤1.8pp), 分档可直接跨联赛用;
 *   ✅ 存档命中率(88.2%…)系全联赛混合值, 与弱联赛实测吻合(弱联赛 T1=88.9%);
 *   ⚠️ 唯一 caveat: **五大联赛的超强热门(≥0.72)实测比弱联赛低~5pp**(五大 T1=83.5% vs 弱联赛88.9%)
 *      —— 强联赛强队也更易被爆。故 T1/T2 档对**五大联赛**场略偏乐观, 单押强热门胆码时心里打个折。
 *   结论: 分档迁移成立, 不拆 per-联赛档(无交付增益+防过拟合); 季度重训因 automation freeze 不建 cron。
 */

// 阈值取"档内"边界,hit 用该档**档内**实测命中率(更诚实:落在此区间的真实命中)。
// dcHit = 双选(双重机会·覆盖market top2)实测命中率(2026-06-02 backtest-double-chance,45811场):
//   低信心场单选命中低,但双选命中仍高 → 可执行规则:强热门单关、弱/均势走双选。
const TIERS = [
  { key: "T1", min: 0.80, hitWithin: 0.882, dcHit: 0.93, label: "🟢一档", short: "强信心", play: "单关" },
  { key: "T2", min: 0.72, hitWithin: 0.795, dcHit: 0.92, label: "🟢一档", short: "强信心", play: "单关" },
  { key: "T3", min: 0.65, hitWithin: 0.731, dcHit: 0.921, label: "🟢二档", short: "高信心", play: "单关" },
  { key: "T4", min: 0.55, hitWithin: 0.626, dcHit: 0.839, label: "🟡三档", short: "中等", play: "单关或双选" },
  { key: "T5", min: 0.45, hitWithin: 0.502, dcHit: 0.776, label: "🟠偏弱", short: "偏弱", play: "双选" },
  { key: "T6", min: 0.00, hitWithin: 0.407, dcHit: 0.718, label: "⚪硬币档", short: "≈掷硬币", play: "双选或弃" },
];

/**
 * 按市场隐含热门概率定档。
 * @param {number} marketFavProb 去vig 后三选里最高的隐含概率(主/平/客的 max)
 * @returns {{key,label,short,backtestHit,bankerEligible,marketFavProb}}
 */
export function selectionTier(marketFavProb) {
  const p = Number(marketFavProb);
  const t = Number.isFinite(p) ? TIERS.find((x) => p >= x.min) : TIERS[TIERS.length - 1];
  return {
    key: t.key,
    label: t.label,
    short: t.short,
    backtestHit: t.hitWithin,                 // 该档单选档内实测命中率
    doubleChanceHit: t.dcHit,                 // 该档双选(双重机会)实测命中率
    play: t.play,                             // 可执行建议:单关/单关或双选/双选/双选或弃
    bankerEligible: t.min >= 0.65,            // ≥0.65(回测档内≥73%)才够格做胆码/任选9 单选
    marketFavProb: Number.isFinite(p) ? Math.round(p * 1000) / 1000 : null,
  };
}

/**
 * 从一条 prediction 取"市场隐含热门概率"。优先用纯市场赔率隐含(最 sharp 的选择信号),
 * 缺则退回最终融合概率(≈市场,因 blend 以市场为主)。
 */
export function marketFavProbOf(prediction) {
  const m = prediction?.marketImpliedProbabilities ?? prediction?.oddsProbabilities ?? null;
  const probs = (m && Number.isFinite(m.home)) ? m : (prediction?.probabilities ?? null);
  if (!probs) return null;
  const vals = [probs.home, probs.draw, probs.away].map(Number).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * 是否有「真实市场盘口」可定档(2026-06-07)。无盘口(如世界杯未开赛)时 selectionTier 用的热门概率
 *   是行内退回的模型融合概率、非真实市场背书 —— 用此判据让展示层诚实标注,不推翻退回设计。
 */
export function hasRealMarketOdds(prediction) {
  const m = prediction?.marketImpliedProbabilities ?? prediction?.oddsProbabilities ?? null;
  return Boolean(m && Number.isFinite(Number(m.home)));
}

/** 一步到位:从 prediction 直接得档位。 */
export function tierOfPrediction(prediction) {
  return selectionTier(marketFavProbOf(prediction));
}

export { TIERS as SELECTION_TIERS };
