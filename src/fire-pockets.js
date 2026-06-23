/**
 * fire-pockets.js —— 选择性出手·高命中口袋(2026-06-23 用户:无死角·每场回答"看胜负平/看大小球/看让球")。
 * ════════════════════════════════════════════════════════════════════════════
 * 全部已在五大联赛全7赛季 12458 场 walk-forward 双稳过测(scripts/backtest-fire-pockets.mjs)。
 * 每个口袋 = 精确条件(让球线档 × 平赔/资金动向) → 看哪个市场+哪个方向 + 五大真实命中(训练/测试)。
 * 只在口袋命中时"出手",其余沉默(不硬凑)。诚实:命中高≠盈利(收盘已定价);让球"过盘"无高命中口袋(庄家做平)。
 *
 * 三问对照:
 *   ① 看胜负平 → "胜负平·热门赢" 口袋(深盘让1.25/1.5/2+ + 平稳/平高/加注,命中65-85%)。
 *   ② 看几个球 → "大小球" 口袋(让0.25/0.75/2+ 平4+→大球;平手/0.25/0.5 平<3.2→小球,命中58-71%)。
 *   ③ 看让球   → 过盘无高命中口袋(已证伪);深盘玩"让球后胜平负的胜"(=①热门赢)。
 */
import { comboFeatures } from "./combo-triggers.js";

// 让球线档匹配(主队视角绝对值)
const lineBand = (f, lo, hi) => f.ahAbs !== null && f.ahAbs >= lo && f.ahAbs < hi;
// 子条件
const subFns = {
  平稳: (f) => f.drift === "平稳",
  加注: (f) => f.drift === "加注",
  退烧: (f) => f.drift === "退烧",
  "平<3.2": (f) => f.drawOdds < 3.2,
  "平3.7-4": (f) => f.drawOdds >= 3.7 && f.drawOdds < 4,
  "平4+": (f) => f.drawOdds >= 4,
};

// market: 胜负平(热门赢) / 大小球(大球|小球)。dir 为方向标签(热门赢=运行时解析主/客胜)。tr/te=训练/测试命中,te=诚实展示值。
export const FIRE_POCKETS = [
  // ── ① 胜负平·热门赢(深让球盘) ──
  { line: "让2+", lo: 1.625, hi: 9, sub: "加注", market: "胜负平", dir: "热门赢", tr: 0.77, te: 0.85, n: 269 },
  { line: "让2+", lo: 1.625, hi: 9, sub: "平稳", market: "胜负平", dir: "热门赢", tr: 0.78, te: 0.84, n: 543 },
  { line: "让2+", lo: 1.625, hi: 9, sub: "平4+", market: "胜负平", dir: "热门赢", tr: 0.78, te: 0.84, n: 887 },
  { line: "让1.5", lo: 1.375, hi: 1.625, sub: "平4+", market: "胜负平", dir: "热门赢", tr: 0.74, te: 0.76, n: 673 },
  { line: "让1.5", lo: 1.375, hi: 1.625, sub: "平稳", market: "胜负平", dir: "热门赢", tr: 0.75, te: 0.75, n: 367 },
  { line: "让1.5", lo: 1.375, hi: 1.625, sub: "加注", market: "胜负平", dir: "热门赢", tr: 0.72, te: 0.71, n: 207 },
  { line: "让1.25", lo: 1.125, hi: 1.375, sub: "平稳", market: "胜负平", dir: "热门赢", tr: 0.72, te: 0.70, n: 489 },
  { line: "让1.25", lo: 1.125, hi: 1.375, sub: "平4+", market: "胜负平", dir: "热门赢", tr: 0.71, te: 0.67, n: 881 },
  { line: "让1.25", lo: 1.125, hi: 1.375, sub: "退烧", market: "胜负平", dir: "热门赢", tr: 0.69, te: 0.65, n: 144 },
  // ── ② 大小球 ──
  { line: "让0.25", lo: 0.125, hi: 0.375, sub: "平3.7-4", market: "大小球", dir: "大球", tr: 0.70, te: 0.71, n: 211 },
  { line: "让2+", lo: 1.625, hi: 9, sub: "平4+", market: "大小球", dir: "大球", tr: 0.70, te: 0.70, n: 887 },
  { line: "让2+", lo: 1.625, hi: 9, sub: "平稳", market: "大小球", dir: "大球", tr: 0.70, te: 0.69, n: 543 },
  { line: "让2+", lo: 1.625, hi: 9, sub: "加注", market: "大小球", dir: "大球", tr: 0.73, te: 0.68, n: 269 },
  { line: "让1.25", lo: 1.125, hi: 1.375, sub: "退烧", market: "大小球", dir: "大球", tr: 0.63, te: 0.65, n: 144 },
  { line: "让0.75", lo: 0.625, hi: 0.875, sub: "平4+", market: "大小球", dir: "大球", tr: 0.66, te: 0.64, n: 472 },
  { line: "让1.5", lo: 1.375, hi: 1.625, sub: "平4+", market: "大小球", dir: "大球", tr: 0.63, te: 0.60, n: 673 },
  { line: "让0.5", lo: 0.375, hi: 0.625, sub: "平<3.2", market: "大小球", dir: "小球", tr: 0.69, te: 0.60, n: 141 },
  { line: "让0.25", lo: 0.125, hi: 0.375, sub: "平<3.2", market: "大小球", dir: "小球", tr: 0.62, te: 0.60, n: 918 },
  { line: "平手", lo: 0, hi: 0.125, sub: "平<3.2", market: "大小球", dir: "小球", tr: 0.64, te: 0.58, n: 597 },
];

/**
 * 给一场(市场对象 m,字段同 comboFeatures/comboTriggers),返回每市场的最高命中出手 + 让球诚实结论。
 * @returns {null|{ wld, ou, handicap, fired:Array }}
 *   wld/ou = {dir, hitTe, hitTr, cond, n} 或 null(此市场无高命中口袋→沉默)
 *   handicap = 让球过盘结论(恒为"无高命中点"诚实串,深盘给替代建议)
 */
export function firePockets(m) {
  const f = comboFeatures(m);
  if (!f) return null;
  const favWin = f.favHome ? "主胜" : "客胜";
  const matched = FIRE_POCKETS.filter((p) => lineBand(f, p.lo, p.hi) && subFns[p.sub](f));
  const bestOf = (market) => {
    const cand = matched.filter((p) => p.market === market).sort((a, b) => Math.min(b.tr, b.te) - Math.min(a.tr, a.te))[0];
    if (!cand) return null;
    return { dir: cand.dir === "热门赢" ? favWin : cand.dir, hitTe: cand.te, hitTr: cand.tr, cond: `${cand.line}+${cand.sub}`, n: cand.n };
  };
  const wld = bestOf("胜负平");
  const ou = bestOf("大小球");
  // 让球过盘:无高命中口袋(已证伪)。深让球盘(让1.25+)给替代建议=玩"让球后胜平负的胜"(即热门赢)。
  let handicap;
  if (f.ahAbs !== null && f.ahAbs >= 1.125 && wld) handicap = `过盘无高命中点(庄家做平);深盘可玩"让球后胜平负的胜"=${wld.dir}(命中${Math.round(wld.hitTe * 100)}%)`;
  else handicap = "过盘无高命中点(让胜/让平/让负≈掷硬币·五大全样本无≥60%双稳口袋)→不出手";

  return {
    wld, ou, handicap,
    fired: matched.map((p) => ({ market: p.market, dir: p.dir === "热门赢" ? favWin : p.dir, cond: `${p.line}+${p.sub}`, hitTe: p.te, n: p.n })),
  };
}
