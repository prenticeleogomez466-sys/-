/**
 * Tilt Detection(行为风控)
 * ──────────────────────────────────────────────────
 * Tilt = 赌徒心理学概念,指连败后情绪化加仓的非理性行为.
 * Tilt detection 是顶级 bankroll 管理的关键 — 不只看胜负,更看用户行为模式.
 *
 * 检测信号:
 *   1. 连败次数 ≥ N
 *   2. 仓位上升趋势(过去 K 注仓位平均 > 之前 K 注)
 *   3. 时间间隔急剧缩短(连败后立刻又下,没间隔)
 *   4. 偏离凯利建议(实际仓位 > 凯利建议 × 2)
 *   5. 投注频率激增(以前 1 天 1-2 注,现在 1 天 5-10 注)
 *
 * 触发后:
 *   - 警告 + 建议"冷静期"(24h 不下)
 *   - 自动减仓建议(1/4 凯利 → 1/8 凯利)
 *   - 记录到 memory,提醒用户上次 tilt 的损失教训
 */

const DEFAULT_THRESHOLDS = {
  consecutiveLosses: 4,
  stakeRatioWarn: 1.5,    // 当前 K 注平均仓位 / 之前 K 注 > 1.5
  stakeRatioDanger: 2.5,
  intervalSeconds: 300,   // 5 分钟内连续下注 = 警告
  betFrequencyDaily: 5,   // 一天 ≥ 5 注开始警告
  kellyDeviationWarn: 1.5,
  kellyDeviationDanger: 2.5
};

/**
 * @param {Array} recentBets [{ timestamp, stake, hit, kellySuggestedStake }]
 *   最近 N 注的记录,按时间升序
 * @param {Object} opts
 * @returns {{ tilted, severity, signals, recommendation }}
 */
export function detectTilt(recentBets, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  if (!Array.isArray(recentBets) || recentBets.length < 2) {
    return { tilted: false, severity: "none", signals: [], recommendation: "数据不足 (<2 注)" };
  }

  const signals = [];

  // 1. 连败检测
  const trailingLosses = countTrailingLosses(recentBets);
  if (trailingLosses >= thresholds.consecutiveLosses) {
    signals.push({
      name: "consecutive-losses",
      severity: trailingLosses >= thresholds.consecutiveLosses + 2 ? "danger" : "warn",
      detail: `最近连败 ${trailingLosses} 注`
    });
  }

  // 2. 仓位上升趋势
  const half = Math.floor(recentBets.length / 2);
  if (half > 0) {
    const recentAvgStake = recentBets.slice(-half).reduce((s, b) => s + Number(b.stake || 0), 0) / half;
    const earlierAvgStake = recentBets.slice(0, half).reduce((s, b) => s + Number(b.stake || 0), 0) / half;
    if (earlierAvgStake > 0) {
      const ratio = recentAvgStake / earlierAvgStake;
      if (ratio >= thresholds.stakeRatioDanger) {
        signals.push({
          name: "stake-escalation",
          severity: "danger",
          detail: `近期平均仓位 ${recentAvgStake.toFixed(1)},之前 ${earlierAvgStake.toFixed(1)},放大 ${ratio.toFixed(2)} 倍`
        });
      } else if (ratio >= thresholds.stakeRatioWarn) {
        signals.push({
          name: "stake-escalation",
          severity: "warn",
          detail: `仓位放大 ${ratio.toFixed(2)} 倍`
        });
      }
    }
  }

  // 3. 急促时间间隔
  const intervals = [];
  for (let i = 1; i < recentBets.length; i++) {
    const t1 = new Date(recentBets[i - 1].timestamp).getTime();
    const t2 = new Date(recentBets[i].timestamp).getTime();
    if (Number.isFinite(t1) && Number.isFinite(t2)) intervals.push((t2 - t1) / 1000);
  }
  const shortIntervals = intervals.filter((s) => s < thresholds.intervalSeconds).length;
  if (shortIntervals >= 3) {
    signals.push({
      name: "rapid-betting",
      severity: shortIntervals >= 5 ? "danger" : "warn",
      detail: `${shortIntervals} 次间隔 < ${thresholds.intervalSeconds} 秒`
    });
  }

  // 4. 偏离凯利建议
  const deviations = recentBets
    .filter((b) => Number.isFinite(b.kellySuggestedStake) && b.kellySuggestedStake > 0)
    .map((b) => Number(b.stake) / Number(b.kellySuggestedStake));
  if (deviations.length >= 3) {
    const avgDev = deviations.reduce((s, d) => s + d, 0) / deviations.length;
    if (avgDev >= thresholds.kellyDeviationDanger) {
      signals.push({
        name: "kelly-deviation",
        severity: "danger",
        detail: `仓位平均 ${avgDev.toFixed(2)} 倍凯利建议`
      });
    } else if (avgDev >= thresholds.kellyDeviationWarn) {
      signals.push({
        name: "kelly-deviation",
        severity: "warn",
        detail: `仓位 ${avgDev.toFixed(2)} 倍凯利`
      });
    }
  }

  // 5. 频率激增
  if (recentBets.length >= 1) {
    const last = recentBets[recentBets.length - 1];
    const lastDayBets = recentBets.filter((b) => {
      const t = new Date(b.timestamp).getTime();
      const lt = new Date(last.timestamp).getTime();
      return Number.isFinite(t) && Number.isFinite(lt) && (lt - t) <= 24 * 3600 * 1000;
    }).length;
    if (lastDayBets >= thresholds.betFrequencyDaily) {
      signals.push({
        name: "frequency-spike",
        severity: lastDayBets >= thresholds.betFrequencyDaily * 2 ? "danger" : "warn",
        detail: `近 24 小时下注 ${lastDayBets} 次`
      });
    }
  }

  // 综合
  const dangerCount = signals.filter((s) => s.severity === "danger").length;
  const warnCount = signals.filter((s) => s.severity === "warn").length;
  let severity, recommendation;
  if (dangerCount >= 2) {
    severity = "critical";
    recommendation = "🔴 强烈建议立即停止 24-48 小时;复盘最近 10 注,核对凯利建议";
  } else if (dangerCount >= 1 || warnCount >= 3) {
    severity = "high";
    recommendation = "🔴 进入 tilt 高危区,建议减仓到 1/8 凯利或暂停";
  } else if (warnCount >= 1) {
    severity = "moderate";
    recommendation = "🟠 出现 tilt 早期信号,建议下一注减仓 + 等待 ≥1 小时";
  } else {
    severity = "none";
    recommendation = "🟢 行为正常,继续按计划";
  }

  return {
    tilted: severity !== "none",
    severity,
    signals,
    recommendation,
    summary: {
      bets: recentBets.length,
      consecutiveLosses: trailingLosses,
      dangerSignals: dangerCount,
      warnSignals: warnCount
    }
  };
}

function countTrailingLosses(bets) {
  let count = 0;
  for (let i = bets.length - 1; i >= 0; i--) {
    if (bets[i].hit === false) count++;
    else if (bets[i].hit === true) break;
  }
  return count;
}
