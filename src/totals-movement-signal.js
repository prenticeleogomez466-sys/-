/**
 * 大小球走势触发(2026-06-16,盘口共性挖掘 scripts/mine-handicap-patterns.mjs 实证)。
 *
 * 8906 场五大联赛(2021-2026)挖掘结论:欧赔/亚盘的初→收走势对爆冷=噪声(z<2,印证
 *   reference_signal_backtest_findings),**唯一达统计强度(z>4)的真实 edge 是大小球盘口的走势**:
 *     · 大小球被加注(over 隐含概率 ↑>4pp):实际大球 63.0% vs 基线 53.2%(+9.8pp, z=4.4 🟢)
 *     · 大小球退烧(over 隐含概率 ↓>4pp):实际大球 44.1% vs 基线 53.2%(−9.1pp, z=−4.7 🟢)
 *   交互稳健性:浅/中盘内独立成立(z=3.1);深盘"被加注"消失,但"退烧→小球"仍强(z=−2.7)。
 *
 * 诚实边界(遵 feedback_no_fallback_absolute + confidence-not-autosuppress):
 *   这是**历史频率的方向性提示**,不是保证;只给大小球玩法一个有据的真实倾向 + 历史命中率,
 *   不自动下注、不替用户弃赛。无初/收双盘则返回 null(不编造走势)。
 */

const BASE_OVER = 0.532;     // 五大联赛大球(>2.5)基线
const MOVE_THRESHOLD = 0.04; // 实证触发阈:over 隐含概率移动 ≥4pp

// de-vig 大球隐含概率(从 over/under 赔率)。任一缺/非法 → null。
export function overImpliedProb(over, under) {
  const o = Number(over), u = Number(under);
  if (!(o > 1) || !(u > 1)) return null;
  const io = 1 / o, iu = 1 / u;
  return io / (io + iu);
}

/**
 * @param {Object} a
 *   openOverProb  {number} 初盘大球隐含概率(0~1)
 *   closeOverProb {number} 收盘大球隐含概率(0~1,必填)
 *   ahDepth       {number} (可选)收盘亚盘线深度 |line|,用于档位化命中率
 * @returns {null | { move, lean, empiricalOverRate, band, note }}
 */
export function analyzeTotalsMovement({ openOverProb = null, closeOverProb = null, ahDepth = null } = {}) {
  if (closeOverProb == null) return null;          // 缺收盘=不诊断(null→0 陷阱:必须先判 null)
  const close = Number(closeOverProb);
  if (!Number.isFinite(close)) return null;
  if (openOverProb == null || !Number.isFinite(Number(openOverProb))) {
    // 只有收盘盘,无走势可判——只回报收盘倾向,不编造移动。
    return { move: null, lean: "无初盘·无法判走势", empiricalOverRate: null, band: "⚪", note: "仅收盘大小球,无初→收走势(不编造)" };
  }
  const open = Number(openOverProb);
  const move = round(close - open, 3);
  const depth = Number.isFinite(Number(ahDepth)) ? Math.abs(Number(ahDepth)) : null;

  if (move > MOVE_THRESHOLD) {
    // 被加注→大球。深盘(≥1.25)该效应消失,降级提示。
    const strong = depth == null || depth < 1.25;
    return {
      move, lean: "大球", empiricalOverRate: strong ? 0.63 : null,
      band: strong ? "🟢强" : "⚪深盘内不稳",
      note: strong
        ? `大小球被加注(+${(move * 100).toFixed(0)}pp)→历史实际大球63%(基线53%,z=4.4);倾向大球`
        : `大小球被加注但深盘(让${depth})内该信号历史不稳,仅参考`,
    };
  }
  if (move < -MOVE_THRESHOLD) {
    // 退烧→小球。浅/中/深盘均稳健(深盘 z=-2.7)。
    return {
      move, lean: "小球", empiricalOverRate: 0.44,
      band: "🟢强",
      note: `大小球退烧(${(move * 100).toFixed(0)}pp)→历史实际大球仅44%(基线53%,z=-4.7);倾向小球`,
    };
  }
  return { move, lean: "无明显走势", empiricalOverRate: null, band: "⚪", note: `大小球盘口稳(移动${(move * 100).toFixed(0)}pp<阈4pp),无走势信号` };
}

function round(v, n = 4) { const f = 10 ** n; return Math.round((Number(v) || 0) * f) / f; }
export { BASE_OVER, MOVE_THRESHOLD };
