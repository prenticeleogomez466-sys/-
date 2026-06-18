/**
 * 连续风险分 (risk-score) — 0~100, 把"高/中/低"三档升级为连续量化分。
 * ──────────────────────────────────────────────────────────────────────────
 * 用户裁决"四项全挖到底"·工作流A(2026-06-18)。OOS 回测(scripts/backtest-risk-score.mjs,
 *   25531 场·13 联赛·7 季·时间切分前70%训练→后30%测试)裁决:
 *
 *   ▸ 连续市场隐含"pick不中"概率 = 最优风险预测:
 *       三档离散 Brier 0.2356  >  纯市场基线 0.2321  >  base+多因子 0.2328
 *     → 连续化是真增益(分辨率 38.8pp vs 三档 33.2pp);
 *     → **多因子堆叠反而更差**(平局/浅线/大球虽单看 z 显著, 但市场早已定价,
 *        再加进分数=双重计数=过拟合)。故:
 *
 *   风险分 = 市场隐含的"这注不中"概率(连续 0-100) = 1 − 市场devig(pick)。
 *   各风险因子**不计入分数**, 仅作「透明驱动标注」告诉用户"为什么这场风险高",
 *   既给信息又不双重计数, 也不替用户弃赛(守 feedback_confidence_not_autosuppress)。
 *
 *   校准实测(测试集10档): 风险分21→实际不胜18% … 风险分56→实际不胜57%(单调贴线)。
 *
 * 纯函数, 无 IO。缺市场隐含 → 返回 null(诚实: 无法量化, 不编造)。
 *
 * 关联: [[reference_signal_backtest_findings]](分歧越大市场越对) ·
 *      与 honest-pass-gate.js(0/1过关裁决)、upset-trap-detector.js(爆冷分型) 互补。
 */

const OUTCOMES = ["home", "draw", "away"];

export const RISK_CONST = {
  // 实测校准对齐(backtest-risk-score §3): <30 低 / 30-50 中 / ≥50 高(50≈硬币区)
  BAND_LOW: 30,
  BAND_HIGH: 50,
  // 驱动标注阈值(各因子单看 OOS z 显著, 仅作披露)
  DRAW_TRAP: 0.30,        // 平局隐含≥30% → 历史实际平局31.5%(OOS最干净信号)
  SHALLOW_HEAVY_P: 0.60,  // 强热门(≥60%)且让球线浅 → 不胜+6pp(z=4.34)
  OVER_LOW: 0.46,         // 大球概率≤46%(闷战) → 不胜+6.4pp(z=8.69)
  DIVERGENCE_PP: 8,       // 与市场分歧>8pp(逆市/大分歧=陷阱)
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function pct(x) { return `${Math.round((Number(x) || 0) * 100)}%`; }
function bandOf(score) {
  return score >= RISK_CONST.BAND_HIGH ? "高" : score >= RISK_CONST.BAND_LOW ? "中" : "低";
}

/**
 * 计算一注的连续风险分 + 驱动标注。
 *
 * @param {Object} a
 *   pick        {"home"|"draw"|"away"|Array<outcome>} 推荐选项(双选传数组, 风险=两选项都不中)
 *   marketProbs {home,draw,away} 市场 devig 隐含概率(必填; 缺→null)
 *   modelProbs  {home,draw,away} 模型概率(可选, 用于逆市/分歧标注, 不计入分数)
 *   drawImplied {number} 平局隐含(可选; 默认取 marketProbs.draw)
 *   favSide     {"home"|"away"} 市场热门方向(可选; 默认 marketProbs 推断)
 *   favImplied  {number} 热门隐含胜率(可选)
 *   ahLineAbs   {number} 亚盘让球线绝对值(可选, 浅线标注)
 *   over25      {number} 大球2.5 概率(可选, 闷战标注)
 *   softLeague  {boolean} 弱赛事先验(可选)
 * @returns {null | { score, band, lossProb, marketPick, aligned, drivers:[{tag,severity,note}], summary }}
 */
export function riskScore(a = {}) {
  const m = a.marketProbs;
  if (!m || !OUTCOMES.every((o) => Number.isFinite(m[o]))) return null; // 无市场=不量化
  const picks = Array.isArray(a.pick) ? a.pick : [a.pick];
  const valid = picks.filter((p) => OUTCOMES.includes(p));
  if (!valid.length) return null;

  // 核心分 = 市场隐含"这注不中"概率 = 1 − Σ市场(pick选项)
  const pickProb = clamp(valid.reduce((s, p) => s + m[p], 0), 0, 1);
  const lossProb = clamp(1 - pickProb, 0, 1);
  const score = clamp(Math.round(lossProb * 100), 1, 99);
  const band = bandOf(score);

  const marketPick = OUTCOMES.reduce((b, o) => (m[o] > m[b] ? o : b), "home");
  const favSide = a.favSide ?? (m.home >= m.away ? "home" : "away");
  const favImplied = Number.isFinite(a.favImplied) ? a.favImplied : m[favSide];
  const drawImplied = Number.isFinite(a.drawImplied) ? a.drawImplied : m.draw;
  const aligned = valid.includes(marketPick); // pick 是否含市场热门方向

  // ── 驱动标注(只披露·不计入分数)──
  const C = RISK_CONST;
  const drivers = [];
  // ① 逆市(pick 完全不含市场热门) — 实证逆市命中仅 22.7%, 最重风险旗标
  if (!aligned && !valid.includes("draw")) {
    drivers.push({ tag: "逆市", severity: "高", note: `选项不含市场热门(${marketPick})·实证逆市命中仅22.7%` });
  }
  // ② 平局陷阱(非平局 pick 时) — OOS 最干净
  if (drawImplied >= C.DRAW_TRAP && !valid.includes("draw")) {
    drivers.push({ tag: "平局陷阱", severity: "中", note: `平局隐含${pct(drawImplied)}≥30%·历史实际平局31.5%(OOS)·防被逼平` });
  }
  // ③ 模型↔市场分歧(可选) — 分歧越大市场越对
  if (a.modelProbs && OUTCOMES.every((o) => Number.isFinite(a.modelProbs[o]))) {
    const divPp = Math.round(OUTCOMES.reduce((s, o) => s + Math.abs(a.modelProbs[o] - m[o]), 0) * 100 / 2);
    if (divPp > C.DIVERGENCE_PP) drivers.push({ tag: "高分歧", severity: "中", note: `模型与市场分歧${divPp}pp>8pp·实证分歧越大市场越对` });
  }
  // ④ 强热窄路: 强热门 + 让球线浅(z=4.34) — 仅当 pick 押热门时才是其风险
  if (favImplied >= C.SHALLOW_HEAVY_P && Number.isFinite(a.ahLineAbs) && a.ahLineAbs <= 1.0 && valid.includes(favSide)) {
    drivers.push({ tag: "浅线强热", severity: "低", note: `强热门(${pct(favImplied)})但让球线仅${a.ahLineAbs}(浅)·同类不胜+6pp(z4.34)·防啃硬骨头` });
  }
  // ⑤ 闷战(大球≤46%, z=8.69) — 低进球→净胜薄/平局多, 押热门时风险
  if (Number.isFinite(a.over25) && a.over25 <= C.OVER_LOW && valid.includes(favSide)) {
    drivers.push({ tag: "闷战低球", severity: "低", note: `大球概率${pct(a.over25)}≤46%(闷战)·热门不胜+6.4pp(z8.69)` });
  }
  // ⑥ 弱赛事先验
  if (a.softLeague === true) drivers.push({ tag: "弱赛事", severity: "低", note: "国际/友谊·统计先验弱·信号多未学习" });

  const summary = `风险分 ${score}/100(${band})·市场隐含不中${pct(lossProb)}` +
    (drivers.length ? `·${drivers.map((d) => d.tag).join("/")}` : "·无额外风险旗标");

  return { score, band, lossProb: +lossProb.toFixed(3), marketPick, aligned, drivers, summary };
}
