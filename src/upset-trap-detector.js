// 爆冷风险 + 诱盘/真实盘识别(分析师层,2026-05-31 过夜 L2)
// ---------------------------------------------------------------------------
// 用户硬要求:输出"可能会爆冷的场次 + 原因""每场赔率变化是否符合真实实力——是诱盘还是真实体现"。
//
// 设计原则(遵记忆硬规则):
//   · 只读分析,不改胜负平(wld)锚,不自动弃赛(feedback-confidence-not-autosuppress);
//   · 盘口信号实证超不过市场(reference-signal-backtest-findings),故本层是**透明读数+风险提示**,
//     不作下注触发器;给用户判断材料,下不下注用户定。
//   · 实证锚(reference-data-change-5yr-empirics,33278 场):被加注热门 56.4% 胜 vs 退烧热门 45.5% 胜;
//     大热让球过盘率全程 <50%。本模块用这些经验频率给爆冷风险定档。
//   · ⚠诱盘判定真实性回测(2026-06-01 轮9,run-trap-verdict-backtest.mjs,8266 场,leak-safe DC):
//     **所谓"诱盘"无下注 edge** —— "诱盘嫌疑·公众追高热门"桶热门实际胜率 58.6% vs 收盘隐含 55.6%
//     (+2.9pp,热门反跑赢);无任一桶热门显著跑输隐含。即市场高效、模型↔市场分歧时市场更准
//     (印证 reference-signal-backtest-findings)。故 trapVerdict 的"诱盘/低估/看淡"类带诚实 caveat,
//     仅作分歧诊断、**不构成弃热门依据**;真有方向性的只有 movement(加注 vs 退烧)与 favoriteTier。
//
// 复用已有 analyzeLineMovement(line-movement-signal.js),不重复造轮子;本层叠"热门视角 + 模型对照"。

import { analyzeLineMovement } from "./line-movement-signal.js";

const OUTCOMES = ["home", "draw", "away"];
const LABEL = { home: "主胜", draw: "平局", away: "客胜" };

function round(x, n = 4) {
  const f = 10 ** n;
  return Math.round((Number(x) || 0) * f) / f;
}

// 热门强度分档(按收盘隐含胜率)——与让球深浅、爆冷基线挂钩。
function favoriteTier(p) {
  if (p >= 0.7) return { tier: "超级大热", baseUpset: 0.18 };   // 隐含胜率≥70%
  if (p >= 0.6) return { tier: "强热门", baseUpset: 0.3 };
  if (p >= 0.5) return { tier: "中等热门", baseUpset: 0.42 };
  if (p >= 0.42) return { tier: "微热门", baseUpset: 0.52 };
  return { tier: "势均", baseUpset: 0.6 };
}

/**
 * 分析一场的爆冷风险 + 诱盘/真实盘性质。
 *
 * @param {Object} args
 *   opening   {home,draw,away} 开盘隐含概率(去 vig);缺则只用 closing 给静态风险
 *   closing   {home,draw,away} 收盘/当前隐含概率(去 vig)——必填
 *   model     {home,draw,away} 大模型最终融合概率(可选,用于市场↔模型对照判诱盘)
 * @returns {null | {
 *   favorite, favoriteLabel, favoriteImplied, tier,
 *   movement:{classification,totalMovement,favoriteDrift},
 *   upsetRisk, upsetLevel,
 *   trapVerdict, trapConfidence, reason,
 *   priceReflectsStrength
 * }}
 */
export function analyzeUpsetTrap({ opening = null, closing = null, model = null } = {}) {
  if (!closing || !OUTCOMES.every((o) => Number.isFinite(closing[o]))) return null;
  const fav = OUTCOMES.reduce((b, o) => (closing[o] > closing[b] ? o : b), "home");
  const favImplied = closing[fav];
  const { tier, baseUpset } = favoriteTier(favImplied);

  // 盘口移动(开盘→收盘);缺开盘 → 视作 flat。
  const lm = opening && OUTCOMES.every((o) => Number.isFinite(opening[o]))
    ? analyzeLineMovement(opening, closing)
    : { classification: "flat", totalMovement: 0, drift: { home: 0, draw: 0, away: 0 } };
  const favDrift = round(lm.drift[fav]); // >0 = 热门被加注(隐含胜率升);<0 = 退烧

  // 爆冷风险 = 热门**不胜**的经验概率。从强度基线出发,按加注/退烧用 5 年实证比例微调。
  //   被加注(favDrift>+0.02):实证 56.4% 胜 → 更可靠,爆冷基线 ×0.9;
  //   退烧(favDrift<-0.02):实证 45.5% 胜 → 更危险,爆冷基线 ×1.18;
  //   中性:基线不动。封顶 [0.08, 0.85]。
  let upsetRisk = baseUpset;
  let moveTag = "盘口平稳";
  if (favDrift > 0.02) { upsetRisk = baseUpset * 0.9; moveTag = "热门被加注(收盘更热)"; }
  else if (favDrift < -0.02) { upsetRisk = baseUpset * 1.18; moveTag = "热门退烧(收盘走冷)"; }
  upsetRisk = round(Math.min(0.85, Math.max(0.08, upsetRisk)), 3);
  const upsetLevel = upsetRisk >= 0.55 ? "高" : upsetRisk >= 0.42 ? "中" : "低";

  // 诱盘 vs 真实:市场价是否与"实力(模型)"一致。
  //   modelFav = 模型给热门方向的概率;market 价 favImplied。
  //   · 加注 + 模型认同(modelFav>=favImplied-0.03):真实——市场加注被独立模型确认。
  //   · 加注 + 模型明显更低(modelFav<favImplied-0.06):诱盘嫌疑——公众在追一个模型评级更低的热门。
  //   · 退烧 + 模型也更低(modelFav<favImplied):聪明钱撤离被确认——爆冷价值警示(非诱盘,是真实走冷)。
  //   · 退烧 + 模型仍高:市场过度走冷,热门反而有价值(逆诱盘)。
  //   · 平稳:看模型与市场差,差大标读数,差小=中性。
  const modelFav = model && Number.isFinite(model[fav]) ? round(model[fav]) : null;
  const gap = modelFav != null ? round(modelFav - favImplied) : null; // >0 模型比市场更看好热门
  let trapVerdict = "中性·价实相符";
  let trapConfidence = 0.4;
  let priceReflectsStrength = true;
  if (favDrift > 0.02) {
    if (gap == null) { trapVerdict = "加注·待模型确认"; trapConfidence = 0.4; }
    else if (gap >= -0.03) { trapVerdict = "真实·加注被模型确认"; trapConfidence = 0.7; }
    else if (gap < -0.06) { trapVerdict = "诱盘嫌疑·公众追高热门"; trapConfidence = 0.65; priceReflectsStrength = false; }
    else { trapVerdict = "偏诱盘·加注略超模型"; trapConfidence = 0.5; priceReflectsStrength = false; }
  } else if (favDrift < -0.02) {
    if (gap == null) { trapVerdict = "退烧·聪明钱撤离"; trapConfidence = 0.5; }
    else if (gap <= 0) { trapVerdict = "真实走冷·撤离被模型确认(爆冷价值)"; trapConfidence = 0.68; }
    else { trapVerdict = "逆诱盘·市场过度走冷(热门或仍有值)"; trapConfidence = 0.5; }
  } else {
    if (gap != null && Math.abs(gap) >= 0.08) {
      trapVerdict = gap > 0 ? "盘稳但模型更看好热门(市场或低估)" : "盘稳但模型更看淡热门(警惕)";
      trapConfidence = 0.45;
      priceReflectsStrength = gap > 0;
    }
  }

  // 诚实 caveat(2026-06-01 轮9 回测,8266 场):模型与市场分歧时(gap≠0 的诱盘/低估/看淡类判定),
  //   热门**实际胜率≈或高于收盘隐含**("诱盘嫌疑"桶实际 58.6% vs 隐含 55.6%,+2.9pp)——即市场高效、
  //   分歧时市场更准,所谓"诱盘"无下注 edge。故这些判定仅作分歧诊断,**不构成弃热门依据**。
  const isModelDisagreement = gap != null && Math.abs(gap) >= 0.03 && /诱盘|低估|看淡/.test(trapVerdict);
  const caveat = isModelDisagreement
    ? "模型与市场分歧;回测证市场通常更准(分歧时热门仍达隐含),仅作诊断、非弃注依据"
    : null;

  const reason = buildReason({ tier, favLabel: LABEL[fav], favImplied, moveTag, upsetRisk, upsetLevel, trapVerdict, gap, caveat });

  return {
    favorite: fav,
    favoriteLabel: LABEL[fav],
    favoriteImplied: round(favImplied),
    tier,
    movement: { classification: lm.classification, totalMovement: round(lm.totalMovement), favoriteDrift: favDrift },
    upsetRisk,
    upsetLevel,
    trapVerdict,
    trapConfidence: round(trapConfidence, 2),
    priceReflectsStrength,
    modelGap: gap,
    caveat,
    reason,
  };
}

function buildReason({ tier, favLabel, favImplied, moveTag, upsetRisk, upsetLevel, trapVerdict, gap, caveat }) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const parts = [
    `${tier}(${favLabel}隐含胜率${pct(favImplied)})`,
    moveTag,
    `爆冷风险${upsetLevel}(≈${pct(upsetRisk)})`,
    trapVerdict,
  ];
  if (gap != null) parts.push(`模型−市场${gap >= 0 ? "+" : ""}${pct(gap)}`);
  if (caveat) parts.push(`⚠${caveat}`);
  return parts.join(" · ");
}

// ───────────────────────────────────────────────────────────────────────────
// 多信号爆冷风险诊断(2026-06-16,用户最终目的:"为什么德国不冷、西班牙冷——盘口水位/
//   赔率/球队特点上有没有体现")。
//
// 实证锚(德国vs库拉索 7-1·没冷  vs  西班牙vs佛得角 0-0·爆冷,真实存盘赔率):
//   · 1X2 都笃定(德1.03/97% vs 西1.06/94%)→ 光看 1X2 分不出谁会冷;
//   · 但 亚盘让球线深度 + 大小球总进球线 把两场清楚分开:
//       德国 亚盘-3.5 / 大小球4.5(深线+高球=市场预期血洗)→ 真打出 7-1;
//       西班牙 亚盘-2.5 / 大小球3.5(线浅+球低=市场预期"赢球但低净胜分闷局")→ 被铁桶逼平 0-0。
//   · 机制 = 背离:1X2 极笃定(≥80%)但 让球线浅 + 大小球线低 ⇒ 市场在"赢球确定性"与
//     "赢多少/进多少"之间自相背离 = 隐藏的"啃硬骨头"风险 = 平局/爆冷温床。
//   · 球队特点(佛得角防守强/摆大巴)免费抓不到(FBref Cloudflare 墙),但市场已把它消化进
//     "大小球只敢挂3.5、让球只敢-2.5"里 —— 读懂这两条线 ≈ 间接读到球队特点。
//
// 诚实边界(瑞典vs突尼斯反例:亚盘-0.5/大小球2.5 线浅球低却 5-1):盘口信号只能**上调风险**、
//   提示"别当胆/别打深让球",绝不保证必爆,也不自动弃赛(遵 feedback-confidence-not-autosuppress)。
//   概率以"热门1X2不胜"市场共识为诚实锚,背离信号只作风险升档与原因披露,不编造精确加成数字。
//
// ── 深浅基准(2026-06-16 细挖 mine-upset-drivers.mjs,8906场五大联赛)──
//   同 1X2 热门强度档的"典型亚盘线中位",作为判"线深/浅"的客观标准(浅≠绝对值小,而是比同类浅)。
const LINE_BENCHMARK = [
  [0.50, 0.5], [0.55, 0.75], [0.60, 1.0], [0.65, 1.25], [0.70, 1.5], [0.75, 1.75], [0.80, 2.25], [0.85, 2.5], [0.90, 2.75],
];
function benchmarkLine(p) {
  let med = null;
  for (const [lo, m] of LINE_BENCHMARK) if (p >= lo) med = m;
  return med;
}

// @param {Object} a
//   p1x2Fav     {number}  热门 1X2 隐含胜率(de-vig,必填;0~1)
//   ahLine      {number}  亚盘让球线(热门视角;|line| 越大=市场预期净胜越大)
//   totalsLine  {number}  大小球总进球线(如 2.5/3.5/4.5)
//   pOver25     {number}  (可选)大球 de-vig 概率,佐证进球量
//   drawImplied {number}  (可选)收盘平局隐含概率——细挖证最干净的平局信号(校准好,≥30%→实际31.5%)
//   favDrift    {number}  (可选)热门赔率移动:>0 加注 / <0 退烧
// @returns {null | { favWinProb, baseUpsetProb, marginExpect, goalsExpect,
//   lineDepth, grindDivergence, band, signals:[], reason, caveat }}
//
// 2026-06-16 细挖修正(诚实):①深浅以"同1X2实力档中位线"为基准(LINE_BENCHMARK),
//   西班牙-2.5对94%热门其实是"正常"非"浅"——上一版"绝对<3=浅"不严谨已废。②真正区分
//   德国(没冷)/西班牙(冷)的是**大小球线**(德4.5血洗/西3.5闷局),非线深浅。③线比同类浅 →
//   总爆冷率反而**更低**(磨平小胜型,25.7%<35.1%),故线浅不直接拉爆冷档,只作背景参照;
//   仅"深热门+线比同类浅"对**平局**有边缘正信号(19.8% vs 12.2%,z=2.2)。④最干净平局信号=平局隐含概率。
export function diagnoseUpsetRisk(a = {}) {
  const p = Number(a.p1x2Fav);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null; // 无 1X2 隐含=不诊断,不编造
  const ahAbs = Number.isFinite(Number(a.ahLine)) ? Math.abs(Number(a.ahLine)) : null;
  const totals = Number.isFinite(Number(a.totalsLine)) ? Number(a.totalsLine) : null;
  const drift = Number.isFinite(Number(a.favDrift)) ? Number(a.favDrift) : null;
  const pOver = Number.isFinite(Number(a.pOver25)) ? Number(a.pOver25) : null;
  const pDraw = Number.isFinite(Number(a.drawImplied)) ? Number(a.drawImplied) : null;

  const baseUpsetProb = round(1 - p, 3);            // ✅市场锚:热门不胜的共识概率
  const heavyFav = p >= 0.78;                        // 超级大热(1X2 极笃定)
  const signals = [];
  signals.push(`1X2热门不胜${pct(baseUpsetProb)}(市场共识)`);

  // 让球线深度 → 以"同1X2实力档中位线"为基准判深浅(残差),非绝对值。
  let marginExpect = "未知", lineDepth = null;
  if (ahAbs != null) {
    const bm = benchmarkLine(p);
    const residual = bm != null ? round(ahAbs - bm, 2) : null;
    lineDepth = residual == null ? null : residual <= -0.25 ? "浅于同类" : residual >= 0.25 ? "深于同类(市场敢加码)" : "同类正常";
    marginExpect = ahAbs >= 2.5 ? "重让(预期大胜)" : ahAbs >= 1.5 ? "明显优势" : ahAbs >= 0.75 ? "小胜预期" : "势均/半球内";
    signals.push(`亚盘${a.ahLine}${lineDepth ? `(${lineDepth}·基准${bm})` : ""}`);
  }
  // 大小球线 → 进球量预期。低线=闷战=净胜薄+平局多(德4.5血洗/西3.5闷局的真区分点)。
  let goalsExpect = "未知";
  const lowGoals = (totals != null && totals <= 3.5) || (pOver != null && pOver <= 0.50);
  if (totals != null) {
    goalsExpect = totals >= 4 ? "高球(goalfest)" : totals >= 3.25 ? "中高" : totals >= 2.75 ? "中" : "低球闷战";
    signals.push(`大小球${totals}(${goalsExpect})${pOver != null ? `·大球${pct(pOver)}` : ""}`);
  } else if (pOver != null) {
    goalsExpect = pOver >= 0.58 ? "偏大球" : pOver <= 0.46 ? "偏小球闷战" : "中";
    signals.push(`大球概率${pct(pOver)}(${goalsExpect})`);
  }

  // ── 平局/爆冷信号(2026-06-16 回测审计后,只保留样本外OOS验证过的)──
  //   ✅平局隐含≥30%:校准实际31.5%(最干净·OOS成立)。✅势均(下方双向):OOS胜47%/平28%/负25%。
  //   ❌"深热门+大小球线低→易爆冷平"已被OOS证伪——五大联赛这类573场实际78.7%胜(强队窄胜非平)!
  //     西班牙0-0是WC"铁桶弱旅摆大巴"罕见尾部,公开盘口不可靠预判,仅留定性caveat、不作统计触发。
  const drawSignalHigh = pDraw != null && pDraw >= 0.30;           // OOS校准:实际平局≈31.5%
  const lowGoalsHeavy = heavyFav && lowGoals;                      // 仅WC尾部定性提示(OOS证五大联赛78%窄胜)
  const grindDivergence = drawSignalHigh;                          // 字段沿用=唯一OOS成立的隐藏平局风险
  if (drawSignalHigh) signals.push(`平局隐含${pct(pDraw)}≥30%→历史实际平局31.5%·防平(OOS验证)`);
  if (lowGoalsHeavy) signals.push("强热+大小球线低:五大联赛证多为78%窄胜(非平);仅WC对铁桶弱旅有罕见被逼平尾部·定性提示非触发");
  if (lineDepth === "浅于同类" && heavyFav) signals.push("让球线比同类浅(参照·边缘信号z=2.2,不单独升档)");

  // ── 赔率移动(细挖+审计均证对1X2爆冷=噪声,仅描述不升降档)──
  if (drift != null) {
    if (drift < -0.02) signals.push("热门退烧(走冷)·注:回测证1X2走势对爆冷=噪声,不升档");
    else if (drift > 0.02) signals.push("热门被加注(更热)·注:1X2走势=噪声");
  }

  // ── 分档(只用OOS验证过的:概率锚 + 平局隐含)──
  let band;
  if (baseUpsetProb >= 0.35) band = "高";                        // 1X2 本身就不稳(如比利时36%)
  else if (baseUpsetProb >= 0.25) band = "中";                   // 中等热门(如乌拉圭28%)
  else if (drawSignalHigh) band = "中";                          // 平局隐含≥30%(唯一OOS成立的低概率升档)
  else band = "低";                                             // 强热(西班牙型也归此:OOS证不可靠预判)

  // ── 爆冷分型(回测审计后:砍掉伪"易爆冷平",只留OOS成立的)──
  //   🔴双向爆冷=势均(OOS胜47/平28/负25);🟡防平=平局隐含≥30%(OOS校准31.5%);
  //   🟢低风险=强热≥72%(OOS胜~78%,低球也是窄胜);WC对铁桶弱旅留尾部定性提示。
  let upsetType = "中性";
  if (baseUpsetProb >= 0.42) upsetType = "🔴双向爆冷(势均·平/负各半·勿当胆)";
  else if (drawSignalHigh) upsetType = "🟡防平(平局隐含≥30%·校准31.5%)";
  else if (p >= 0.72) upsetType = lowGoalsHeavy ? "🟢低风险(强热窄胜·WC对弱旅留尾部)" : "🟢低风险(强热可胆)";
  signals.push(`分型:${upsetType}`);

  const reason = buildUpsetReason({ band, baseUpsetProb, marginExpect, goalsExpect, lineDepth, lowGoalsHeavy, drawSignalHigh, pDraw, upsetType });
  return {
    favWinProb: round(p, 3),
    baseUpsetProb,
    upsetType,
    marginExpect, goalsExpect, lineDepth,
    grindDivergence,
    band,
    signals,
    reason,
    caveat: "盘口只上调风险、非必爆(瑞典5-1反例);深浅以同实力档中位线为参照,真信号=大小球线+平局隐含;不自动弃赛",
  };
}

function pct(x) { return `${Math.round((Number(x) || 0) * 100)}%`; }

function buildUpsetReason({ band, baseUpsetProb, marginExpect, goalsExpect, lineDepth, lowGoalsHeavy, drawSignalHigh, pDraw, upsetType }) {
  const head = `爆冷风险${band}(热门不胜≈${pct(baseUpsetProb)})·${upsetType ?? "中性"}`;
  const depthBit = lineDepth ? `让球线${lineDepth}` : "";
  if (drawSignalHigh) {
    return `${head} · 关键:平局隐含${pct(pDraw)}≥30%(历史实际平局31.5%·样本外验证)=最干净的平局信号,防被逼平,勿当胆;${depthBit}`;
  }
  if (baseUpsetProb >= 0.42) {
    return `${head} · 势均场:历史样本外胜47%/平28%/负25%,平负都可能,绝不当胆;${goalsExpect}`;
  }
  if (band === "低" && lowGoalsHeavy) {
    return `${head} · 强热但大小球线低(${goalsExpect}):五大联赛样本外证多为窄胜(78%胜·非平);仅世界杯对铁桶弱旅有罕见被逼平尾部(西班牙0-0型),公开盘口不可靠预判,定性留意非统计触发;${depthBit}`;
  }
  if (band === "低") {
    return `${head} · 强热门(${goalsExpect}/${depthBit || "让球线正常以上"}),样本外胜率~78%,无OOS成立的隐藏风险信号`;
  }
  return `${head} · 1X2本身即非稳胆,${goalsExpect}/${marginExpect},按市场共识控注`;
}

// 供回测/汇总:把一场标成是否"爆冷已发生"(热门未胜)。
export function favoriteUpset(closingImplied, result) {
  if (!closingImplied || !result) return null;
  const fav = OUTCOMES.reduce((b, o) => (closingImplied[o] > closingImplied[b] ? o : b), "home");
  const hg = Number(result.home), ag = Number(result.away);
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const actual = hg > ag ? "home" : hg < ag ? "away" : "draw";
  return { favorite: fav, won: actual === fav, actual };
}
