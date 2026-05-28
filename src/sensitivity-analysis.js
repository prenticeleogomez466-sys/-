/**
 * Sensitivity / What-If 反事实分析
 * ──────────────────────────────────────────────────
 * 给一个 prediction,扰动每个输入信号(伤兵/天气/阵容/Elo)→ 看主胜概率怎么变化.
 * 输出:
 *   - 哪个信号是 most sensitive(最敏感)
 *   - 哪些反事实(伤兵复出/暴雨)会改变方向
 *   - 信号鲁棒性评分
 *
 * 用法:
 *   const r = sensitivityAnalysis(prediction, {
 *     scenarios: [
 *       { name: "伤兵复出", patch: { injuries: [] } },
 *       { name: "暴雨", patch: { weather: { precipitation: 10 } } }
 *     ]
 *   });
 *   r.mostSensitive;  // "injuries"
 *   r.scenarioImpacts;
 */

/**
 * @param {Object} prediction  baseline prediction
 * @param {Object} opts
 *   scenarios: [{ name, patch }] 每个场景给 fixture/advanced data 的局部修改
 *   recomputeFn: (modifiedPrediction) → newProbabilities;默认用简化扰动
 */
export function sensitivityAnalysis(prediction, opts = {}) {
  if (!prediction || !prediction.probabilities) return null;
  const baseline = { ...prediction.probabilities };
  const scenarios = opts.scenarios ?? defaultScenarios(prediction);

  const impacts = scenarios.map((sc) => {
    const modified = recomputeUnderScenario(prediction, sc.patch, opts.recomputeFn);
    const delta = {
      home: round(modified.home - baseline.home),
      draw: round(modified.draw - baseline.draw),
      away: round(modified.away - baseline.away)
    };
    const directionChanged = topOutcome(modified) !== topOutcome(baseline);
    return {
      scenario: sc.name,
      patch: sc.patch,
      baseline,
      modified,
      delta,
      directionChanged,
      magnitude: round(Math.abs(delta.home) + Math.abs(delta.draw) + Math.abs(delta.away))
    };
  });

  impacts.sort((a, b) => b.magnitude - a.magnitude);

  return {
    baseline,
    impacts,
    mostSensitive: impacts[0]?.scenario ?? null,
    flipScenarios: impacts.filter((i) => i.directionChanged).map((i) => i.scenario),
    robustnessScore: round(Math.max(0, 1 - impacts.reduce((s, i) => s + i.magnitude, 0) / impacts.length)),
    narrative: buildNarrative(impacts)
  };
}

function defaultScenarios(prediction) {
  // 标准反事实清单
  return [
    { name: "伤兵全部复出", patch: { injuries: "clear" } },
    { name: "暴雨大风(进球率 -25%)", patch: { weather: "harsh" } },
    { name: "对手关键球员复出", patch: { opponentInjuries: "clear" } },
    { name: "Elo 差缩小 100", patch: { eloDelta: -100 } },
    { name: "xG 差缩小", patch: { xgDelta: -0.3 } }
  ];
}

/**
 * 简化的扰动重算:不真正调用整个 pipeline,而是对 baseline 做经验性扰动
 */
function recomputeUnderScenario(prediction, patch, customRecompute = null) {
  if (customRecompute) return customRecompute(prediction, patch);
  const base = prediction.probabilities;
  const shifts = {
    "injuries": { type: "clear", boost: 0.04 },  // 伤兵复出 → 主队 +4pp
    "weather": { type: "harsh", drawShift: 0.06 },
    "opponentInjuries": { type: "clear", boost: -0.04 },
    "eloDelta": { multiplier: 0.5 },
    "xgDelta": { multiplier: 0.4 }
  };
  let { home, draw, away } = base;
  if (patch.injuries === "clear") {
    home += shifts.injuries.boost;
    away -= shifts.injuries.boost / 2;
    draw -= shifts.injuries.boost / 2;
  }
  if (patch.weather === "harsh") {
    // 暴雨:平局率上升,极端结果下降
    draw += shifts.weather.drawShift;
    home -= shifts.weather.drawShift / 2;
    away -= shifts.weather.drawShift / 2;
  }
  if (patch.opponentInjuries === "clear") {
    home += shifts.opponentInjuries.boost;
    away -= shifts.opponentInjuries.boost / 2;
  }
  if (Number.isFinite(patch.eloDelta)) {
    const shift = patch.eloDelta / 1000;  // 100 ELO ≈ 10pp
    home += shift * 0.5;
    away -= shift * 0.5;
  }
  if (Number.isFinite(patch.xgDelta)) {
    const shift = patch.xgDelta * 0.1;
    home += shift;
    away -= shift;
  }
  // 归一化 + clip
  home = Math.max(0.01, Math.min(0.98, home));
  draw = Math.max(0.01, Math.min(0.98, draw));
  away = Math.max(0.01, Math.min(0.98, away));
  const sum = home + draw + away;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

function topOutcome(probs) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
}

function buildNarrative(impacts) {
  if (!impacts.length) return "";
  const top = impacts[0];
  const flipping = impacts.filter((i) => i.directionChanged);
  if (flipping.length) {
    return `⚠ 推荐方向不稳:${flipping.map((f) => f.scenario).join("、")} 任一发生都会翻转方向`;
  }
  return `推荐方向相对稳健;最敏感因素:${top.scenario}(改变 ±${(top.magnitude*100).toFixed(1)}pp)`;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
