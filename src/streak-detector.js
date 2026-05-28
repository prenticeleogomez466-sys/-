/**
 * Streak Detector 连胜/连败心理效应
 * ──────────────────────────────────────────────────
 * 心理学和数据:
 *   - 连胜 ≥ 3 场:置信 + 团结 → 短期 form 提升 +3-5%
 *   - 连胜 ≥ 7 场:开始自满 + 对手警惕 → form 维持但 lift 衰减
 *   - 连胜 ≥ 10 场:统计上"回归均值"压力,break-point 概率上升
 *   - 连败 2-3 场:压力 + 急躁 → form 下降 -2-4%
 *   - 连败 5+ 场:危机 → 教练换帅 / 球队反弹效应混合
 *
 * 计算结果作为 Bayesian evidence:
 *   "home-on-winning-streak" → LR (home: 1.06, draw: 0.96, away: 0.95)
 *   "home-on-losing-streak"  → LR (home: 0.93, draw: 1.05, away: 1.05)
 */

/**
 * 给一组按时间升序的最近比赛(球队 perspective),算 streak 状态.
 *
 * @param {Array} recentMatches [{ won: "W"|"D"|"L", date }]
 *   最新一场在末尾.
 */
export function detectStreak(recentMatches) {
  if (!Array.isArray(recentMatches) || !recentMatches.length) {
    return { type: "none", length: 0, lift: 0 };
  }
  // 从末尾向前数,直到出现不同结果
  const last = recentMatches[recentMatches.length - 1];
  const lastResult = String(last.won ?? "").toUpperCase();
  if (!["W", "D", "L"].includes(lastResult)) return { type: "none", length: 0, lift: 0 };
  let length = 0;
  for (let i = recentMatches.length - 1; i >= 0; i--) {
    if (String(recentMatches[i].won).toUpperCase() === lastResult) length++;
    else break;
  }

  // 转 type
  const type = lastResult === "W" ? "winning"
             : lastResult === "L" ? "losing"
             : "drawing";
  const lift = computeStreakLift(type, length);
  const breakPointRisk = type === "winning" && length >= 7
                       ? round(0.15 + (length - 7) * 0.05)
                       : type === "losing" && length >= 5
                       ? round(0.20 + (length - 5) * 0.05)
                       : 0;
  return {
    type,
    length,
    lift,
    breakPointRisk: Math.min(0.45, breakPointRisk),
    narrative: buildNarrative(type, length, lift, breakPointRisk)
  };
}

function computeStreakLift(type, length) {
  if (type === "winning") {
    if (length >= 10) return 0.01;     // 接近 mean-reversion
    if (length >= 7) return 0.02;
    if (length >= 5) return 0.04;
    if (length >= 3) return 0.04;
    return 0.02;
  }
  if (type === "losing") {
    if (length >= 7) return -0.06;     // 危机
    if (length >= 5) return -0.05;
    if (length >= 3) return -0.03;
    return -0.02;
  }
  return 0;  // drawing streak 无明显效应
}

function buildNarrative(type, length, lift, risk) {
  if (type === "winning" && length >= 7) {
    return `连胜 ${length} 场,士气高但 mean-reversion 风险 ${(risk*100).toFixed(0)}%`;
  }
  if (type === "winning" && length >= 3) {
    return `连胜 ${length} 场,form 提升 +${(lift*100).toFixed(1)}%`;
  }
  if (type === "losing" && length >= 5) {
    return `连败 ${length} 场,危机阶段,反弹概率 ${(risk*100).toFixed(0)}%`;
  }
  if (type === "losing") {
    return `连败 ${length} 场,form 下降 ${(lift*100).toFixed(1)}%`;
  }
  if (type === "drawing") return `连续 ${length} 场平局,无明显方向`;
  return "无 streak";
}

/**
 * 把 streak lift 转成 Bayesian LR(用于 bayesian-belief-update).
 */
export function streakToLR(streak) {
  if (!streak || streak.length < 2) return null;
  const lift = streak.lift;
  if (streak.type === "winning") {
    return {
      home: 1 + lift,
      draw: 1 - lift * 0.5,
      away: 1 - lift * 0.5
    };
  }
  if (streak.type === "losing") {
    return {
      home: 1 + lift,           // lift 是负数
      draw: 1 - lift * 0.3,     // 平局率小幅上升
      away: 1 - lift * 0.7      // 客胜率明显上升
    };
  }
  return null;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
