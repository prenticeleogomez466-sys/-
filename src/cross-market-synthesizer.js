/**
 * cross-market-synthesizer.js —— 跨市场触发合成器(2026-06-23 用户令:所有走势/盘口条件交叉验证后,触发→告诉我最可能那个方向)。
 * ════════════════════════════════════════════════════════════════════════════
 * 把已回测过测的两套引擎交叉投票,产出"一场比赛的单一共识方向 + 信心 + 防平/看胜负 + 大小球倾向":
 *   ① combo-triggers.js  —— 欧赔/亚盘让球线/大小球 初→收盘走势 + 实测高命中组合(89k/12458场过测)。
 *   ② draw-risk-model.js —— 平赔率体系/均势/平赔退烧/价值袋(五大联赛12458场过测·用户盘口手感落地)。
 *
 * 交叉验证铁律(用户2026-06-22):一个方向需 ≥2 个独立维度都指向才算"高信心",单维度只作"参考倾向"。
 * 诚实(signal_backtest_findings + draw_blindspot):命中高≠盈利(收盘已定价);本合成器=选择性出手+防平避坑的
 *   决策辅助,不保证赚钱、不打败收盘线。纯函数无IO,不擅改主概率(决策辅助层)。
 */
import { comboTriggers, parseLine } from "./combo-triggers.js";
import { assessDrawRisk } from "./draw-risk-model.js";
import { firePockets } from "./fire-pockets.js";

const tierW = { 高: 1.0, 中: 0.6, 提醒: 0.4, 倾向: 0.3, 弱: 0.1 };

/**
 * @param {object} m 市场对象,字段同 comboTriggers:
 *   euClose{home,draw,away}(必填) · euOpen · ahLineClose/ahLineOpen(让球线,主队视角) · ouClose/ouOpen(over隐含) · 水位四项
 * @returns {null|{oneXtwo, overUnder, drawRisk, triggers, crossValidated}}
 */
export function synthesize(m) {
  if (!m || !m.euClose || !(m.euClose.home > 1 && m.euClose.draw > 1 && m.euClose.away > 1)) return null;
  const ct = comboTriggers(m);
  if (!ct) return null;
  const favHome = m.euClose.home <= m.euClose.away;
  const favLabel = favHome ? "主胜" : "客胜";
  const ahAbs = m.ahLineClose != null ? Math.abs(parseLine(m.ahLineClose) ?? 0) : null;
  const dr = assessDrawRisk(m.euClose, { euOpen: m.euOpen, ahLineAbs: ahAbs });

  // ── 胜平负方向合成 ──
  // 投票:combo里"胜平负/可靠度/风险"类触发(热门可靠/危险) + draw-risk(防平/看胜负)。
  const wldTrig = ct.triggers.filter((t) => t.market === "胜平负" || t.market === "可靠度" || t.market === "风险");
  let favScore = 0, drawScore = 0;
  const dims = new Set();
  for (const t of wldTrig) {
    const w = (tierW[t.tier] ?? 0.2) * Math.max(0, (t.hitRate?.te ?? 0.5) - (t.lift != null ? 0 : 0));
    if (t.predict === "主胜" || t.predict === "客胜") { favScore += w; dims.add("走势·" + (t.by || t.src)); }
    else if (/平/.test(t.predict)) { drawScore += w; dims.add("盘口·平倾向"); }
    else if (/危险|防爆/.test(t.predict)) { drawScore += w * 0.5; dims.add("庄家意图·危险"); }
  }
  // draw-risk 计票(维度=平赔体系,独立于走势)
  if (dr) {
    if (dr.direction === "draw-guard") { drawScore += (dr.tier === "强防平" ? 0.9 : 0.5); dims.add("平赔体系·防平"); }
    else if (dr.direction === "decisive") { favScore += (dr.tier === "强看胜负" ? 0.9 : 0.5); dims.add("平赔体系·看胜负"); }
  }

  // 共识方向 + 模式
  let pick, mode, confidence, why;
  const guard = dr && dr.direction === "draw-guard";
  const decisive = dr && dr.direction === "decisive";
  if (dr?.valueDrawPocket) {
    pick = "平局"; mode = "背平价值"; confidence = "中";
    why = "价值袋:大热门+平≥4+负≥6.5(历史背平ROI+15%,稀但真)";
  } else if (decisive && favScore >= drawScore) {
    pick = favLabel; mode = "单选热门"; confidence = dr.tier === "强看胜负" && favScore >= 1 ? "高" : "中";
    why = `看胜负区(${dr.factors[0]})+走势${favScore.toFixed(1)}票指向热门→放心选${favLabel}`;
  } else if (guard) {
    pick = favLabel + "/平"; mode = "双选(防平)"; confidence = dr.tier === "强防平" ? "高" : "中";
    why = `防平区(${dr.factors.join("·")})→别把${favLabel}当胆,${favLabel}或平双选`;
  } else if (favScore > drawScore + 0.3) {
    pick = favLabel; mode = "单选热门"; confidence = "中";
    why = `走势${favScore.toFixed(1)}票指向热门,平赔中性`;
  } else {
    pick = favLabel + "/平"; mode = "双选(谨慎)"; confidence = "低";
    why = "无强方向共识,保守双选";
  }

  // ── 大小球方向合成 ──
  const ouTrig = ct.triggers.filter((t) => t.market === "大小球");
  let overScore = 0, underScore = 0;
  for (const t of ouTrig) {
    const w = (tierW[t.tier] ?? 0.2) * (t.hitRate?.te ?? 0.5);
    if (t.predict === "大球") overScore += w; else if (t.predict === "小球") underScore += w;
  }
  let ouPick = null, ouConf = null, ouWhy = null;
  if (overScore > 0 || underScore > 0) {
    const isOver = overScore >= underScore;
    ouPick = isOver ? "大球" : "小球";
    const top = ouTrig.filter((t) => t.predict === ouPick).sort((a, b) => (b.hitRate?.te ?? 0) - (a.hitRate?.te ?? 0))[0];
    ouConf = top && top.tier === "高" ? "中高" : "中";
    ouWhy = top ? `${top.id}(TEST命中${Math.round((top.hitRate?.te ?? 0) * 100)}%)` : null;
  }

  // 交叉验证:方向维度≥2 个独立来源
  const crossValidated = dims.size >= 2;

  // ── 无死角三问(2026-06-23 用户):每场直接回答 看胜负平/看大小球/看让球,优先用五大过测高命中口袋 ──
  const fp = firePockets(m);
  const markets = {
    胜负平: fp?.wld
      ? { 出手: true, 方向: fp.wld.dir, 命中: `${Math.round(fp.wld.hitTe * 100)}%`, 条件: fp.wld.cond, 样本: fp.wld.n, 来源: "高命中口袋" }
      : (decisive
        ? { 出手: true, 方向: favLabel, 命中: "看胜负区·热门偏可靠", 条件: dr.factors[0], 来源: "平赔体系" }
        : guard
          ? { 出手: false, 方向: `${favLabel}/平双选(防平)`, 命中: `防平·估平率${dr ? Math.round(dr.drawRateEst * 100) : "—"}%`, 条件: dr?.factors.join("·"), 来源: "平赔体系" }
          : { 出手: false, 方向: "无高命中点→看主表", 来源: "—" }),
    大小球: fp?.ou
      ? { 出手: true, 方向: fp.ou.dir, 命中: `${Math.round(fp.ou.hitTe * 100)}%`, 条件: fp.ou.cond, 样本: fp.ou.n, 来源: "高命中口袋" }
      : (ouPick ? { 出手: true, 方向: ouPick, 命中: ouConf, 条件: ouWhy, 来源: "走势组合" } : { 出手: false, 方向: "无高命中点→看主表", 来源: "—" }),
    让球: { 出手: false, 结论: fp?.handicap ?? "过盘无高命中点(庄家做平)→不出手" },
  };

  return {
    oneXtwo: { pick, mode, confidence, why, crossValidated, favScore: Number(favScore.toFixed(2)), drawScore: Number(drawScore.toFixed(2)), dims: [...dims] },
    overUnder: ouPick ? { pick: ouPick, confidence: ouConf, why: ouWhy } : null,
    drawRisk: dr ? { tier: dr.tier, drawRateEst: dr.drawRateEst, direction: dr.direction, advice: dr.advice, valueDrawPocket: dr.valueDrawPocket } : null,
    markets, // 无死角三问
    triggers: ct.triggers,
    crossValidated,
  };
}
