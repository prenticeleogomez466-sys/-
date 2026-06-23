/**
 * draw-risk-model.js —— 平局风险/防平·看胜负 判定(2026-06-23 用户盘口手感经回测落地)。
 * ════════════════════════════════════════════════════════════════════════════
 * 唯一依据 = 收盘欧赔(胜平负小数赔率)+ 让球线 + 初→收盘平赔移动。全部已在五大联赛 12458 场
 *   walk-forward 回测过测(scripts/backtest-draw-odds-system.mjs):
 *     · 平赔率单调决定平局率(TEST稳):平赔2.7-3.35→平率偏高(+5~12pp,防平区);≥3.7→偏低(-1.4~-7.9pp,看胜负区)。
 *     · 均势盘(主客赔差<0.4)是平局温床(+5.1pp);但叠加"平赔>3.5"反转为看胜负(背热门ROI+8.6%)。
 *     · 平赔退烧(初→收盘平隐含↓≥2%)→平率19.3%(-5.9pp,看胜负)。
 *     · 窄价值袋:让1区大热(主1.4-1.6)+平≥4+负≥6.5→平率27%、背平收盘ROI+15%(双稳,唯一真盈利)。
 *
 * 诚实铁律(draw_blindspot + signal_backtest_findings):平局是头号难市场;本模块只给"方向倾向+防平提示",
 *   不保证盈利(收盘已定价);高于基线≠赚钱。纯函数无IO。决策辅助层用,不擅改主概率(需独立净增益回测才接融合)。
 */

const BASE_DRAW = 0.252; // 五大联赛平局基线(12458场)

// 平赔率 → 该档历史实际平局率(五大联赛全7赛季实测,TEST稳)。用于估平局倾向,非概率融合。
function drawRateForBand(drawOdds) {
  const d = drawOdds;
  if (d < 2.7) return 0.30;            // 样本极少(N=10),保守给略高
  if (d < 2.9) return 0.378;           // +12.5pp 极高平
  if (d < 3.05) return 0.291;          // +3.8pp
  if (d < 3.2) return 0.318;           // +6.6pp
  if (d < 3.35) return 0.307;          // +5.4pp
  if (d < 3.5) return 0.289;           // +3.7pp
  if (d < 3.7) return 0.285;           // +3.3pp 过渡
  if (d < 3.9) return 0.238;           // -1.4pp 偏胜负
  if (d < 4.2) return 0.239;           // -1.3pp
  return 0.173;                        // 4.2+ 强看胜负 -7.9pp
}

/**
 * 主入口:输入一场的收盘欧赔(+可选初盘欧赔、让球线),输出平局风险研判。
 * @param {{home:number,draw:number,away:number}} euClose 收盘小数欧赔(必填)
 * @param {object} [opts] { euOpen:{home,draw,away}, ahLineAbs:number(让球线绝对值) }
 * @returns {null|{ tier, drawRateEst, lift, direction, advice, valueDrawPocket, factors:string[] }}
 *   tier: 强防平 / 偏平 / 中性 / 偏胜负 / 强看胜负
 *   direction: "draw-guard"(防平,别单选一方) / "decisive"(看胜负,可选热门方向) / "neutral"
 */
export function assessDrawRisk(euClose, opts = {}) {
  if (!euClose || !(euClose.home > 1 && euClose.draw > 1 && euClose.away > 1)) return null;
  const { home, draw, away } = euClose;
  const factors = [];

  // 1) 平赔率档基准
  let rate = drawRateForBand(draw);
  if (draw < 3.35) factors.push(`平赔${draw.toFixed(2)}(防平区2.7-3.35)`);
  else if (draw >= 3.7) factors.push(`平赔${draw.toFixed(2)}(看胜负区≥3.7)`);
  else factors.push(`平赔${draw.toFixed(2)}(过渡区3.35-3.7)`);

  // 2) 均势盘修正(主客赔差):小=平局温床;但与"平赔>3.5"叠加时反而看胜负(回测过测)
  const haGap = Math.abs(home - away);
  const balanced = haGap < 0.4;
  if (balanced && draw > 3.5) {
    rate -= 0.03; // 均势但庄家不看好平→热门真有货
    factors.push("均势+平赔>3.5(转看胜负·背热门有据)");
  } else if (balanced) {
    rate += 0.025; // 均势低平赔→平局温床
    factors.push(`主客赔接近(差${haGap.toFixed(2)})·均势易平`);
  }

  // 3) 初→收盘 平赔退烧 → 看胜负(钱撤离平局)
  if (opts.euOpen && opts.euOpen.draw > 1) {
    const drawDrift = (1 / draw) - (1 / opts.euOpen.draw); // >0 平被加注 <0 退烧
    if (drawDrift <= -0.02) { rate -= 0.04; factors.push("平赔退烧(初→收盘平隐含↓≥2%·看胜负)"); }
    else if (drawDrift >= 0.02) { factors.push("平赔被加注(初→收盘平隐含↑≥2%·留意平)"); }
  }

  // 4) 窄价值袋:让1区大热(主1.4-1.6 或 客1.4-1.6)+平≥4+负≥6.5 → 背平真盈利(回测ROI+15%)
  const favOdds = Math.min(home, away), dogOdds = Math.max(home, away);
  const ah = opts.ahLineAbs;
  const valueDrawPocket = favOdds >= 1.4 && favOdds <= 1.6 && draw >= 4 && dogOdds >= 6.5 &&
    (ah == null || (ah >= 0.875 && ah < 1.375));
  if (valueDrawPocket) factors.push("⭐价值袋:大热+平≥4+负≥6.5(背平历史ROI+15%·窄但真)");

  rate = Math.max(0.1, Math.min(0.45, rate));
  const lift = rate - BASE_DRAW;

  let tier, direction, advice;
  if (rate >= 0.31) { tier = "强防平"; direction = "draw-guard"; advice = "平局率显著偏高·别把任一方当胆,建议双选(含平)或避开"; }
  else if (rate >= 0.275) { tier = "偏平"; direction = "draw-guard"; advice = "平局率略高·谨慎单选,可考虑胜平/平负双选"; }
  else if (rate <= 0.205) { tier = "强看胜负"; direction = "decisive"; advice = "平局率显著偏低·放心选热门方向,基本不用防平"; }
  else if (rate <= 0.235) { tier = "偏胜负"; direction = "decisive"; advice = "平局率偏低·倾向选边(热门方向)"; }
  else { tier = "中性"; direction = "neutral"; advice = "平局率接近基线·按其他信号定"; }

  return { tier, drawRateEst: Number(rate.toFixed(3)), lift: Number(lift.toFixed(3)), direction, advice, valueDrawPocket, factors };
}

export const __DRAW_RISK_BASE = BASE_DRAW;
