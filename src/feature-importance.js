/**
 * SHAP-style 特征重要性分解
 * ──────────────────────────────────────────────────
 * 借鉴 SHAP (SHapley Additive exPlanations) 思想:
 *   把模型输出的概率分解成各特征贡献的加法分量,
 *   让用户看到"主胜 55% = 50% baseline + Elo +0.03 + xG +0.02 + 主场 +0.04 - injuries -0.04"
 *
 * 由于 SHAP 完整版需要 model interpretability framework,这里用「逐特征边际贡献」简化:
 *   - baseline = 平均概率(0.45 主胜 baseline)
 *   - 每个 signal 的 contribution = signal 实际作用后的概率变化
 *   - 排序展示 top contributors
 *
 * 用法:
 *   const breakdown = decomposeProbability(prediction);
 *   breakdown.contributions: [{ signal: "Elo", weight: 0.03, narrative: "主队 Elo 高出..." }]
 */

// 经验先验:跨联赛全样本的胜负平 baseline
const BASELINE_PROBABILITIES = { home: 0.45, draw: 0.27, away: 0.28 };

/**
 * 把 prediction 对象拆解成 baseline + signals contributions.
 * @param {Object} prediction  predictFixture 返回的对象
 * @returns {{ baseline, finalProbs, contributions, narrative }}
 */
export function decomposeProbability(prediction) {
  if (!prediction || !prediction.probabilities) return null;
  const final = prediction.probabilities;
  const baseProbs = prediction.baseProbabilities ?? final;
  const adjustments = prediction.probabilityAdjustment ?? {};

  // 1. baseline → odds-implied(赔率隐含 = 第一层基底)
  const baselineToOddsImplied = {
    home: round(baseProbs.home - BASELINE_PROBABILITIES.home),
    draw: round(baseProbs.draw - BASELINE_PROBABILITIES.draw),
    away: round(baseProbs.away - BASELINE_PROBABILITIES.away)
  };

  const contributions = [
    {
      signal: "全局先验",
      probability: { home: BASELINE_PROBABILITIES.home, draw: BASELINE_PROBABILITIES.draw, away: BASELINE_PROBABILITIES.away },
      isAbsolute: true,
      narrative: `跨联赛平均胜负平 ≈ ${(BASELINE_PROBABILITIES.home*100).toFixed(0)}/${(BASELINE_PROBABILITIES.draw*100).toFixed(0)}/${(BASELINE_PROBABILITIES.away*100).toFixed(0)}`
    },
    {
      signal: "赔率市场共识",
      probability: baselineToOddsImplied,
      isAbsolute: false,
      narrative: `市场让主胜偏离 baseline ${formatDelta(baselineToOddsImplied.home)}`
    }
  ];

  // 2. 高级信号贡献(advancedFeatures + probabilityAdjustment.signals)
  const signals = adjustments.signals ?? [];
  for (const sig of signals) {
    if (!sig || typeof sig !== "object") continue;
    const score = Number(sig.score);
    if (!Number.isFinite(score)) continue;
    const homeShift = round(score * 0.1);  // 简化:score 直接转概率
    contributions.push({
      signal: sig.name ?? sig.source ?? "信号",
      probability: { home: homeShift, draw: -Math.abs(homeShift) * 0.3, away: -homeShift * 0.7 },
      isAbsolute: false,
      score,
      narrative: scoreNarrative(sig)
    });
  }

  // 3. Calibration 影响
  const calib = adjustments.calibration;
  if (calib && Number.isFinite(calib.adjustment)) {
    contributions.push({
      signal: "概率校准",
      probability: { home: round(calib.adjustment), draw: 0, away: round(-calib.adjustment) },
      isAbsolute: false,
      narrative: `校准模块基于历史复盘${calib.adjustment > 0 ? "提升" : "下调"}主胜 ${Math.abs(calib.adjustment * 100).toFixed(1)} pp`
    });
  }

  // 4. Ensemble 分歧(若有)
  if (prediction.ensembleView) {
    const ens = prediction.ensembleView.probabilities;
    const drift = round(ens.home - final.home);
    if (Math.abs(drift) > 0.02) {
      contributions.push({
        signal: `${prediction.ensembleView.methodCount} 模型 ensemble 分歧`,
        probability: { home: drift, draw: 0, away: -drift },
        isAbsolute: false,
        narrative: drift > 0 ? `Ensemble 比主路径多给主胜 ${(drift*100).toFixed(1)}pp` : `Ensemble 比主路径少给主胜 ${(Math.abs(drift)*100).toFixed(1)}pp`
      });
    }
  }

  // 按主胜贡献绝对值排序
  const sortedContrib = [...contributions].sort((a, b) =>
    Math.abs(b.probability.home ?? 0) - Math.abs(a.probability.home ?? 0)
  );

  // 生成 narrative 字符串
  const narrative = sortedContrib.slice(0, 5).map((c) => {
    const delta = c.probability.home;
    if (c.isAbsolute) return `${c.signal}: 主胜 ${((delta ?? 0)*100).toFixed(0)}%`;
    return `${c.signal}: ${formatDelta(delta)} 主胜`;
  }).join("; ");

  return {
    baseline: BASELINE_PROBABILITIES,
    finalProbs: final,
    baseProbabilities: baseProbs,
    contributions: sortedContrib,
    narrative
  };
}

function scoreNarrative(sig) {
  const name = sig.name ?? sig.source ?? "信号";
  const score = Number(sig.score ?? 0);
  if (score > 0.15) return `${name} 强烈利主队`;
  if (score > 0.05) return `${name} 利主队`;
  if (score > -0.05) return `${name} 中性`;
  if (score > -0.15) return `${name} 利客队`;
  return `${name} 强烈利客队`;
}

function formatDelta(d) {
  const pct = (Number(d) * 100).toFixed(1);
  return Number(d) >= 0 ? `+${pct}pp` : `${pct}pp`;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
