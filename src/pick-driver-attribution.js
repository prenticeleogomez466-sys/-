// 逐注驱动因子归因(pick-driver-attribution.js)——2026-06-13。
// ─────────────────────────────────────────────────────────────────────────────
// 目的:把每注「最终概率」诚实拆成可追溯的驱动因子,回答用户最关心的「为什么这么推」。
//   只解释、不宣称提命中(1X2 已到市场天花板,见 reference_top_analyst_essence):本模块是
//   分析深度/解释层,不改概率、不改方向、不替用户弃赛。
//
// 铁律遵循:
//   • 纯读取器——只消费 prediction 已持久化的真实中间量,零重算、零编造。
//   • 任一中间量缺失 → 该段标 "不可分解" / 跳过,绝不填默认/中性/估计值(零兜底铁律)。
//   • 每个因子带证据标签(✅实测 / 🔶推断 / ⚠️存疑),与 guardrail 数据驱动三标签轨迹同源。
//
// 消费字段(均为 prediction-engine.predictFixture 已挂的真实值):
//   provenance                              先验来源串(俱乐部含 blend 权重 "odds(0.65)+dixon-coles(0.35)")
//   baseProbabilities                       融合锚(blend 结果)
//   probabilityAdjustment.probabilities     送入融合层的(已按 advancedData 微调的)锚
//   probabilityAdjustment.fusion            {applied, probabilities, evidence:[{name,source,lr,detail}], ...}
//   probabilityAdjustment.fusionGatedOff    有市场 prior 时融合层是否被关(回测证净负)
//   probabilityAdjustment.calibration       {applied, source, adjustment, bucket, samples, ...}
//   probabilityAdjustment.worldCup          {lambdaMult, ...}(仅 WC)
//   marketImpliedProbabilities              市场赔率去 vig 隐含
//   dixonColes.independentProbs             Dixon-Coles 独立拟合概率
//   wcModel.decisiveFactors / elo / confed / venue / market   (仅 WC 路由场,已是成形的决定因素)
//   probabilities / pick                    最终概率 + 主推方向

const OUTCOME_LABEL = { home: "主胜", draw: "平局", away: "客胜" };

/** 概率(0-1)→ 百分点字符串,1 位小数;非数返回 null(不编造)。 */
function pct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : null;
}
/** 概率差(0-1)→ 带符号百分点数值(1 位小数);非数返回 null。 */
function deltaPP(after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before)) return null;
  return Math.round((after - before) * 1000) / 10;
}

/** 从 provenance 串解析 blend 权重。支持 odds(x)+dixon-coles(y) 与 odds(x)+national-elo(y)。 */
function parseBlendWeights(provenance) {
  if (typeof provenance !== "string") return null;
  const m = provenance.match(/odds\(([\d.]+)\)\+(?:dixon-coles|national-elo)\(([\d.]+)\)/);
  if (m) return { market: Number(m[1]), model: Number(m[2]), modelKind: provenance.includes("national-elo") ? "national-elo" : "dixon-coles" };
  if (/^odds-only/.test(provenance)) return { market: 1, model: 0, modelKind: "odds-only" };
  if (/^dixon-coles-only/.test(provenance)) return { market: 0, model: 1, modelKind: "dixon-coles" };
  if (/^national-elo/.test(provenance)) return { market: 0, model: 1, modelKind: "national-elo" };
  return null;
}

/** 信号代码 → 中文短名(展示用;未知代码原样返回,不编造)。 */
const SIGNAL_ZH = {
  "season-phase": "赛季阶段", "competition-type": "赛事性质", "injury": "伤停",
  "lineup": "首发阵容", "clean-sheet-streak": "零封连胜", "rotation": "轮换",
  "streak": "连胜/连败", "fatigue": "赛程疲劳", "asian-handicap-water": "亚盘水位",
  "referee": "裁判", "set-piece": "定位球", "manager": "教练效应",
};
function signalZh(name) { return SIGNAL_ZH[name] ?? name; }

/** 一条信号 LR → 它最偏向哪个方向 + 强度(偏离 1 的幅度)。LR>1 推该方向、<1 压该方向。 */
function lrDirection(lr) {
  if (!lr || typeof lr !== "object") return null;
  let best = null;
  for (const k of ["home", "draw", "away"]) {
    const v = Number(lr[k]);
    if (!Number.isFinite(v)) continue;
    const dev = Math.abs(Math.log(v));               // 对数偏离,对称看待 ×2 与 ÷2
    if (!best || dev > best.dev) best = { key: k, lr: v, dev };
  }
  if (!best) return null;
  return { key: best.key, label: OUTCOME_LABEL[best.key], lr: Math.round(best.lr * 100) / 100, push: best.lr >= 1 };
}

// ─── WC 路由场:决定因素已成形,归一化为统一 drivers ────────────────────────────
function attributeWorldCup(prediction) {
  const w = prediction.wcModel ?? {};
  const pickKey = prediction.pick?.key;
  const factors = Array.isArray(w.decisiveFactors) ? w.decisiveFactors : [];
  const drivers = factors.map((f) => ({
    factor: f.key,
    detail: f.detail ?? null,
    weight: Number.isFinite(f.weight) ? f.weight : null,
    tag: f.tag ?? "🔶推断",
  }));
  // 瀑布:Elo 先验 → 洲际校正 → 场馆 λ → 市场对照 → 最终 wld(WC 内部 Elo→λ→比分矩阵为非线性,
  //   故按「关键量」展示而非逐 outcome 位移,诚实不强造 pp 差)。
  const waterfall = [];
  if (w.elo && Number.isFinite(w.elo.diff)) waterfall.push({ stage: "elo", label: "国家队 Elo 实力差", value: `${w.elo.home} vs ${w.elo.away}(差 ${w.elo.diff > 0 ? "+" : ""}${w.elo.diff})`, tag: "✅实测" });
  if (w.confed && Number.isFinite(w.confed.adj) && w.confed.adj !== 0) waterfall.push({ stage: "confed", label: "洲际校正", value: `${w.confed.home} vs ${w.confed.away} → Elo${w.confed.adj > 0 ? "+" : ""}${w.confed.adj}`, tag: "✅实测(OOS验证)" });
  if (Number.isFinite(prediction.probabilityAdjustment?.worldCup?.lambdaMult)) {
    const lm = prediction.probabilityAdjustment.worldCup.lambdaMult;
    if (Math.abs(lm - 1) > 1e-6) waterfall.push({ stage: "venue", label: "场馆环境 λ 乘子", value: `×${lm}${w.venue ? `(${w.venue.city}·海拔${w.venue.altitude_m}m·${w.venue.temp}℃)` : ""}`, tag: "✅实测" });
  }
  if (w.market?.implied) {
    waterfall.push({ stage: "market", label: "市场赔率对照", value: `市场主推 ${OUTCOME_LABEL[codeToKey(w.market.marketPickCode)] ?? "?"}·${w.market.agree ? "与模型同向" : "与模型分歧"}${Number.isFinite(w.market.divergence) ? `(分歧${pct(w.market.divergence)})` : ""}`, tag: "✅实测(只作对照)" });
  }
  waterfall.push({ stage: "final", label: "最终(WC 模型自主)", probs: clone(prediction.probabilities), note: "国家队域单选·不防平(0611 铁律)", tag: "✅实测" });

  return {
    pick: pickSummary(prediction),
    route: "worldcup-match-model",
    drivers,
    waterfall,
    narrative: wcNarrative(prediction, w),
    gaps: Array.isArray(w.gaps) ? w.gaps : [],
  };
}
function codeToKey(code) { return code === "3" ? "home" : code === "1" ? "draw" : code === "0" ? "away" : null; }
function wcNarrative(prediction, w) {
  const pk = prediction.pick;
  if (!pk) return null;
  const bits = [`主推 ${pk.label} ${pct(pk.probability)}`];
  if (w.elo && Number.isFinite(w.elo.diff)) bits.push(`Elo 差 ${w.elo.diff > 0 ? "+" : ""}${w.elo.diff}`);
  if (w.confed && w.confed.adj) bits.push(`洲际校正 ${w.confed.adj > 0 ? "+" : ""}${w.confed.adj}`);
  if (w.market) bits.push(w.market.agree ? "与市场同向" : "与市场分歧(高风险)");
  return bits.join("·");
}

// ─── 俱乐部/常规路由场:市场×DC 锚 → 信号融合 → isotonic 校准 三段瀑布 ──────────
function attributeClub(prediction) {
  const pa = prediction.probabilityAdjustment ?? {};
  const pickKey = prediction.pick?.key;
  const market = prediction.marketImpliedProbabilities ?? null;
  const dc = prediction.dixonColes?.independentProbs ?? null;
  const base = prediction.baseProbabilities ?? null;
  const adjBase = pa.probabilities ?? base;
  const fused = pa.fusion?.probabilities ?? adjBase;
  const final = prediction.probabilities ?? null;
  const weights = parseBlendWeights(prediction.provenance);

  const waterfall = [];
  // 锚的两个来源(权重透明)
  if (market) waterfall.push({ stage: "market", label: "市场赔率隐含(去vig)", probs: clone(market), weight: weights?.market ?? null, tag: "✅实测" });
  if (dc) waterfall.push({ stage: "model", label: weights?.modelKind === "national-elo" ? "国家队 Elo 拟合" : "Dixon-Coles 拟合", probs: clone(dc), weight: weights?.model ?? null, tag: "✅实测" });
  if (base) waterfall.push({ stage: "anchor", label: "融合锚", probs: clone(base), note: weights ? `市场×${weights.market}+模型×${weights.model}` : "blend", tag: "✅实测" });

  // 信号融合段
  if (pa.fusionGatedOff) {
    waterfall.push({ stage: "fusion", label: "信号融合", note: "关闭——市场 prior 在场,融合层经回测证净负(头号杠杆A)", probs: clone(adjBase), deltaPP: null, tag: "✅实测(回测裁决)" });
  } else if (pa.fusion?.applied) {
    waterfall.push({ stage: "fusion", label: "信号融合(贝叶斯)", probs: clone(fused), deltaPP: pickKey ? deltaPP(fused?.[pickKey], adjBase?.[pickKey]) : null, fired: (pa.fusion.evidence ?? []).map((e) => signalZh(e.name)), tag: "✅实测" });
  }
  // isotonic 校准段
  if (pa.calibration?.applied) {
    const adj = Number(pa.calibration.adjustment);
    waterfall.push({ stage: "calibration", label: "isotonic 校准", probs: clone(final), deltaPP: Number.isFinite(adj) ? Math.round(adj * 1000) / 10 : (pickKey ? deltaPP(final?.[pickKey], fused?.[pickKey]) : null), note: `${pa.calibration.scope ?? pa.calibration.source}${pa.calibration.bucket ? `·${pa.calibration.bucket}档` : ""}${Number.isFinite(pa.calibration.samples) ? `·${pa.calibration.samples}样本` : ""}`, tag: "✅实测" });
  } else if (final) {
    waterfall.push({ stage: "final", label: "最终", probs: clone(final), note: pa.calibration?.reason ?? "未校准", tag: "✅实测" });
  }

  // drivers:对主推方向 pickKey 的贡献,按量级排序
  const drivers = [];
  if (pickKey && market && weights) drivers.push({ factor: "市场赔率", detail: `隐含 ${pct(market[pickKey])}·权重 ${(weights.market * 100).toFixed(0)}%`, magnitude: market[pickKey] * weights.market, direction: "锚", tag: "✅实测" });
  if (pickKey && dc && weights) drivers.push({ factor: weights.modelKind === "national-elo" ? "国家队 Elo" : "Dixon-Coles", detail: `独立 ${pct(dc[pickKey])}·权重 ${(weights.model * 100).toFixed(0)}%`, magnitude: dc[pickKey] * weights.model, direction: "锚", tag: "✅实测" });
  if (pa.fusion?.applied && Array.isArray(pa.fusion.evidence)) {
    for (const e of pa.fusion.evidence) {
      const d = lrDirection(e.lr);
      if (!d) continue;
      drivers.push({ factor: signalZh(e.name), detail: `${e.detail ?? ""} LR ${d.label}=${d.lr}`.trim(), magnitude: d.dev / 5, direction: `${d.push ? "推" : "压"}${d.label}`, tag: "✅实测", source: e.source });
    }
  }
  if (pa.calibration?.applied && Number.isFinite(Number(pa.calibration.adjustment))) {
    const adj = Number(pa.calibration.adjustment);
    drivers.push({ factor: "isotonic 校准", detail: `${adj > 0 ? "+" : ""}${(adj * 100).toFixed(1)}pp(${pa.calibration.bucket ?? ""}/${pa.calibration.samples ?? "?"}样本)`, magnitude: Math.abs(adj), direction: adj >= 0 ? `推${prediction.pick?.label ?? ""}` : `压${prediction.pick?.label ?? ""}`, tag: "✅实测" });
  }
  drivers.sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));

  return {
    pick: pickSummary(prediction),
    route: weights?.modelKind === "national-elo" ? "national-elo-blend" : (weights?.market === 1 ? "odds-only" : "club-blend"),
    drivers,
    waterfall,
    narrative: clubNarrative(prediction, weights, market, dc),
  };
}
function clubNarrative(prediction, weights, market, dc) {
  const pk = prediction.pick;
  if (!pk) return null;
  const bits = [`主推 ${pk.label} ${pct(pk.probability)}`];
  if (weights && Number.isFinite(weights.market)) bits.push(`锚=市场×${weights.market}+模型×${weights.model}`);
  if (prediction.probabilityAdjustment?.fusionGatedOff) bits.push("融合关(市场prior在场)");
  if (prediction.probabilityAdjustment?.calibration?.applied) bits.push("已 isotonic 校准");
  return bits.join("·");
}

function pickSummary(prediction) {
  const pk = prediction.pick;
  return pk ? { code: pk.code, key: pk.key, label: pk.label, prob: Number(pk.probability) } : null;
}
function clone(o) { return o && typeof o === "object" ? { home: o.home, draw: o.draw, away: o.away } : o; }

/**
 * 逐注驱动因子归因主入口。
 * @param {Object} prediction predictFixture 产出的单场预测对象。
 * @returns {Object|null} { pick, route, drivers[], waterfall[], narrative, gaps? };
 *   data-missing / 无 pick 的场返回 { route:"data-missing", ... } 而非编造。
 */
export function buildPickDriverAttribution(prediction) {
  if (!prediction || typeof prediction !== "object") return null;
  if (!prediction.pick || !prediction.probabilities) {
    return { pick: null, route: "data-missing", drivers: [], waterfall: [], narrative: prediction?.provenance === "data-missing" ? "数据缺失·未预测" : "无主推方向" };
  }
  if (prediction.provenance === "worldcup-match-model" || prediction.wcModel) return attributeWorldCup(prediction);
  return attributeClub(prediction);
}

/** 把归因压成一行中文文本(供 xlsx 单元格 / 手机页展示)。 */
export function attributionLine(attr) {
  if (!attr) return "";
  if (attr.route === "data-missing") return attr.narrative ?? "数据缺失";
  const top = (attr.drivers ?? []).slice(0, 4).map((d) => `${d.factor}${d.detail ? `(${d.detail})` : ""}`);
  return `${attr.narrative ?? ""}${top.length ? " ‖ 主因:" + top.join("；") : ""}`;
}
