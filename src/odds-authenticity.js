/**
 * 赔率真实性检测(2026-06-02)——"必须保证所有内容真实"的代码防线。
 * ════════════════════════════════════════════════════════════════════
 * 背景:早盘/低流动性时,500 等源会挂"模板占位赔率"(主客对称、未走盘),
 *   它们不是真实市场价,绝不能当真盘展示/驱动。靠人眼发现不可靠,写进代码硬拦。
 * 检测信号:
 *   ① 比分盘 aXY 与 bYX 对称(主胜比分=镜像客胜比分)→ 占位;
 *   ② 半全场 主主==客客 且 主客==客主 → 占位;
 *   ③ 胜平负三项与"开==收"完全没动 + 数值是整模板 → 早盘未走(弱信号)。
 * 真盘在有热门时必然主客**不对称**(热门方比分赔率更低)。
 */

const approxEq = (a, b, tol = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));

/** 比分盘是否占位(主客对称)。bf: {a10,b10,a21,b21,...}(aXY=主胜向, bXY=客胜向镜像)。 */
export function isScoreTemplate(bf) {
  if (!bf || typeof bf !== "object") return false;
  const pairs = [];
  for (const k of Object.keys(bf)) {
    if (!/^a\d\d$/.test(k)) continue;
    const bk = "b" + k.slice(1);
    if (bk in bf) pairs.push([bf[k], bf[bk]]);
  }
  if (pairs.length < 4) return false;
  const symCount = pairs.filter(([a, b]) => approxEq(a, b)).length;
  return symCount / pairs.length >= 0.8; // ≥80% 主客对称 → 占位
}

/** 半全场盘是否占位(主主==客客 且 主客==客主)。bqc 中文键。 */
export function isHalfFullTemplate(bqc) {
  if (!bqc || typeof bqc !== "object") return false;
  return approxEq(bqc["主主"], bqc["客客"]) && approxEq(bqc["主客"], bqc["客主"]) && approxEq(bqc["主平"], bqc["客平"]);
}

/**
 * 综合判定一场抓取的赔率真实性。
 * @returns {{authentic:boolean, templateMarkets:string[], note:string}}
 */
export function assessOddsAuthenticity({ bf, bqc, spf } = {}) {
  const tpl = [];
  if (isScoreTemplate(bf)) tpl.push("比分");
  if (isHalfFullTemplate(bqc)) tpl.push("半全场");
  const authentic = tpl.length === 0;
  return {
    authentic,
    templateMarkets: tpl,
    note: authentic ? "盘口已走、主客不对称=真盘" : `占位/模板盘(主客对称未走盘):${tpl.join("、")} — 不可当真盘用/展示`,
  };
}
