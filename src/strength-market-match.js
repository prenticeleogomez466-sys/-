/**
 * 实力 ↔ 盘口 匹配度(2026-06-18 用户:盘口合理性不能只看盘口自洽,要先独立做两队实力对比,
 *   再判盘口给的赔率/让球与实力是否匹配,据此定"是否合理")。
 *
 * 独立实力源(全✅真实·不依赖竞彩盘口):
 *   · WC 国家队 Elo 先验胜率(worldCupMatchPrior.probabilities,含洲际校正+东道主)= 纸面实力基准;
 *   · ESPN 近5场场均分(ppg)+场均进失 = 近期状态/攻防(真实赛果)。
 * 把"实力热门胜率"经 LINE_FAV_BANDS 反查成"实力应得让球线",与盘口实际让球线/实际隐含胜率对比:
 *   · 匹配(差小)→ 盘口对得起实力 = 合理;
 *   · 盘口比实力更看好热门(让更深/隐含更高)→ 市场计入了 Elo 之外信息(主力/状态/动机/主场)或高估;
 *   · 盘口比实力更看淡 → 反之;
 *   · 方向相反(盘口热门 ≠ Elo强队)→ 市场认为状态/伤停已逆转纸面实力。
 *
 * 🔴 诚实框定(reference_signal_backtest_findings:模型/纸面与市场分歧时,市场通常更准——它信息更全):
 *   本读数是"独立实力 vs 市场定价"的偏离诊断,给判断材料;**不鼓励按纸面逆市下注**(逆市是陷阱)。
 *   分歧更可能是"市场比纯 Elo 多知道了东西",而非盘口错。✅实测Elo+✅盘口,缺则标缺不编。
 */
import { LINE_FAV_BANDS } from "./handicap-sanity.js";

/** 反查:某热门隐含胜率 → 历史上中位最接近的让球线深度(|line|)。缺→null。 */
export function favLineForProb(prob) {
  if (!Number.isFinite(prob)) return null;
  let best = null, bd = Infinity;
  for (const k of Object.keys(LINE_FAV_BANDS).map(Number)) {
    const d = Math.abs(LINE_FAV_BANDS[k].p50 - prob);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** 近5战绩 → 场均分(ppg)。无→null。 */
export function ppgOf(r5) {
  if (!r5 || !r5.n) return null;
  return Math.round(((r5.w * 3 + r5.d) / r5.n) * 100) / 100;
}

const p1 = (x) => Math.round(Number(x) * 1000) / 10;

/**
 * @param {Object} a
 *   eloProb {home,draw,away}   独立 Elo 先验胜率(必填,缺则返回 null)
 *   eloDiff                    Elo 差(正=主强)
 *   marketFavProb              盘口 de-vig 热门隐含胜率(0~1,缺=null)
 *   favSideIsHome              盘口热门是否主队(true/false,缺=null)
 *   marketLineAbs              盘口让球线绝对值(热门让球深度,缺=null)
 *   homeForm/awayForm          {ppg,gf,ga,n} 近5(✅ESPN,缺=null)
 * @returns {null | {...comparison, verdict, severity, read}}
 */
export function assessStrengthVsMarket({ eloProb, eloDiff, marketFavProb, favSideIsHome, marketLineAbs, homeForm, awayForm } = {}) {
  if (!eloProb || !Number.isFinite(eloProb.home) || !Number.isFinite(eloProb.away)) return null;
  const eloFavSide = eloProb.home >= eloProb.away ? "home" : "away";
  const eloFavProb = eloProb[eloFavSide];
  const eloFairLine = favLineForProb(eloFavProb);

  // 方向是否一致(盘口热门 vs Elo强队)
  const dirKnown = favSideIsHome != null;
  const sameSide = dirKnown ? ((favSideIsHome ? "home" : "away") === eloFavSide) : null;

  // 胜率差:同一热门方向下 市场 - 实力(对市场热门方取 Elo 概率)
  let probGapPp = null;
  if (Number.isFinite(marketFavProb) && dirKnown) {
    const eloProbForMktFav = favSideIsHome ? eloProb.home : eloProb.away;
    probGapPp = Math.round((marketFavProb - eloProbForMktFav) * 1000) / 10;
  }
  // 让球线差:市场 - 实力应得(仅方向一致时可比)
  let lineGap = null;
  if (Number.isFinite(marketLineAbs) && eloFairLine != null && sameSide !== false) {
    lineGap = Math.round((marketLineAbs - eloFairLine) * 100) / 100;
  }

  // 近期状态独立佐证(ppg 差)
  const hp = ppgOf(homeForm), ap = ppgOf(awayForm);
  const formDiff = (hp != null && ap != null) ? Math.round((hp - ap) * 100) / 100 : null; // 正=主近期更好
  const formFavHome = formDiff == null ? null : formDiff > 0;
  const formAgreesElo = (formFavHome == null) ? null : (formFavHome === (eloFavSide === "home"));

  // ── 裁决 ──
  let verdict, severity, read;
  const PROB_T = 8, LINE_T = 0.5;
  if (sameSide === false) {
    verdict = "🔴方向背离";
    severity = "high";
    read = `盘口热门方与纸面实力(Elo强队)相反——市场认为近期状态/伤停/主场已逆转纸面实力,强烈信号:优先信市场,别按纸面Elo逆推。`;
  } else if (probGapPp == null && lineGap == null) {
    verdict = "⚠️无法比对";
    severity = "na";
    read = `缺盘口热门隐含或让球线,无法与实力对比(标缺不编)。`;
  } else {
    const overFav = (probGapPp != null && probGapPp >= PROB_T) || (lineGap != null && lineGap >= LINE_T);
    const underFav = (probGapPp != null && probGapPp <= -PROB_T) || (lineGap != null && lineGap <= -LINE_T);
    if (overFav && !underFav) {
      verdict = "🟠盘口高估热门(强于实力)";
      severity = "mid";
      read = `盘口给热门的定价比纸面实力(Elo)应得的更强（${probGapPp != null ? `隐含胜率+${probGapPp}pp` : ""}${lineGap != null && lineGap >= LINE_T ? `${probGapPp != null ? "·" : ""}让球深${lineGap}球` : ""}）。多半=市场计入了Elo之外的利好(主力复出/状态火热/动机/主场氛围);也可能高估。受让方要博需有市场没反映的反向信息——实证分歧时市场通常更准,别盲目逆。`;
    } else if (underFav && !overFav) {
      verdict = "🟠盘口低估热门(弱于实力)";
      severity = "mid";
      read = `盘口给热门的定价比纸面实力应得的更弱（${probGapPp != null ? `隐含胜率${probGapPp}pp` : ""}${lineGap != null && lineGap <= -LINE_T ? `${probGapPp != null ? "·" : ""}让球浅${lineGap}球` : ""}）。多半=市场计入了Elo之外的利空(伤停/疲劳/轮换/动机低);热门若仍有把握或有市场未反映利好才考虑,同样别盲目逆市。`;
    } else {
      verdict = "🟢盘口与实力匹配·合理";
      severity = "ok";
      read = `盘口给的赔率/让球与两队纸面实力(Elo${eloDiff != null ? `差${eloDiff > 0 ? "+" : ""}${eloDiff}` : ""})${formAgreesElo === false ? "" : "及近期状态"}基本一致${probGapPp != null ? `(隐含胜率差${probGapPp >= 0 ? "+" : ""}${probGapPp}pp` : "("}${lineGap != null ? `·让球差${lineGap >= 0 ? "+" : ""}${lineGap}球` : ""})——这个盘口对得起实力,定价合理。`;
    }
    if (formAgreesElo === false) read += ` ⚠️注意:近期状态(近5场均分 主${hp}/客${ap})与Elo纸面强弱方向相反,实力判断打折,以盘口为准。`;
  }

  return {
    eloFavSide, eloFavProb, eloFairLine, eloDiff,
    marketFavProb, marketLineAbs, probGapPp, lineGap, sameSide,
    homePpg: hp, awayPpg: ap, formDiff, formAgreesElo,
    homeForm, awayForm, verdict, severity, read,
  };
}
