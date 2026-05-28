/**
 * 自动解释生成器
 * ──────────────────────────────────────────────────
 * 从 prediction 对象自动生成中文解释,替代当前手动撰写的 reason 字段.
 * 输出包括:
 *   1. 方向理由(赔率结构 / 让球盘 / 半全场结构)
 *   2. 关键信号(Elo / xG / injury / weather 影响)
 *   3. 风险标注(爆冷分析 / 阵容残缺 / 杯赛性质)
 *   4. 串关建议(若适用)
 */

export function generateExplanation(prediction, opts = {}) {
  const lines = [];
  const f = prediction.fixture;
  const snap = prediction.marketSnapshot;
  const ranked = [prediction.pick, prediction.secondaryPick].filter(Boolean);
  const pickLabel = ranked[0]?.label ?? "主胜";

  // 1. 方向 + 概率
  if (ranked[0]) {
    const probPct = ((ranked[0].probability ?? 0) * 100).toFixed(1);
    const gap = ((ranked[0].probability - (ranked[1]?.probability ?? 0)) * 100).toFixed(1);
    lines.push(`方向: ${pickLabel} (概率 ${probPct}%,领先次选 ${gap} pp)`);
  }

  // 2. 赔率结构
  if (snap?.europeanOdds?.current) {
    const o = snap.europeanOdds.current;
    const inv = [1/o.home, 1/o.draw, 1/o.away];
    const total = inv.reduce((a, b) => a + b, 0);
    const vig = ((total - 1) * 100).toFixed(1);
    lines.push(`赔率: 主 ${o.home} / 平 ${o.draw} / 客 ${o.away} (vig ${vig}%)`);
  }

  // 3. 让球盘解读
  if (snap?.handicapOdds?.current) {
    const ho = snap.handicapOdds.current;
    const line = snap.handicapOdds.line ?? snap.handicapOdds.current.line ?? "?";
    const minDir = Object.entries(ho).filter(([k]) => ["home", "draw", "away"].includes(k))
      .sort((a, b) => Number(a[1]) - Number(b[1]))[0];
    if (minDir) {
      const dirName = minDir[0] === "home" ? "主胜" : minDir[0] === "draw" ? "平局" : "客胜";
      lines.push(`让球盘 (让 ${line}): 庄家最看好 ${dirName} (赔 ${minDir[1]})`);
    }
  }

  // 4. Dixon-Coles 信号
  if (prediction.dixonColes?.expectedGoals) {
    const eg = prediction.dixonColes.expectedGoals;
    lines.push(`DC 期望进球: 主 ${eg.home} / 客 ${eg.away}`);
  }

  // 5. 高级数据信号
  const signals = prediction.probabilityAdjustment?.signals ?? [];
  if (signals.length) {
    const summarized = signals.slice(0, 3).map((s) => signalToText(s)).filter(Boolean);
    if (summarized.length) lines.push(`高级信号: ${summarized.join(" / ")}`);
  }

  // 6. 风险标注
  if (prediction.risk) {
    lines.push(`风险评级: ${prediction.risk}${prediction.confidence ? ` (信心 ${prediction.confidence})` : ""}`);
  }

  // 7. EV
  if (prediction.expectedValue?.primary) {
    const e = prediction.expectedValue.primary;
    const evPct = ((e.ev ?? 0) * 100).toFixed(1);
    lines.push(`首选 EV: ${evPct}% (${e.verdict})`);
  }

  // 8. 比分 + 半全场推荐摘要
  if (prediction.scorePicks?.primary && prediction.halfFullPicks?.primary) {
    lines.push(`比分推荐: ${prediction.scorePicks.primary} / 半全场: ${prediction.halfFullPicks.primary}`);
  }

  // 9. Ensemble 对比(若存在)
  if (prediction.ensembleView) {
    const ev = prediction.ensembleView.probabilities;
    const main = prediction.probabilities;
    const drift = Math.abs(ev.home - main.home);
    if (drift > 0.04) {
      lines.push(`⚠ ${prediction.ensembleView.methodCount}-模型 ensemble 跟主路径分歧: ensemble 主胜 ${(ev.home*100).toFixed(0)}% vs 主路径 ${(main.home*100).toFixed(0)}%`);
    }
  }

  return lines.join("; ");
}

function signalToText(signal) {
  if (!signal) return null;
  const name = signal.name ?? signal.source ?? "未知信号";
  const score = signal.score;
  const direction = Number.isFinite(score) ? (score > 0 ? `+${score.toFixed(2)} 利主队` : `${score.toFixed(2)} 利客队`) : "";
  return `${name}${direction ? ` (${direction})` : ""}`;
}
