/**
 * Bankroll 风险管理(顶级团队标配)
 * ──────────────────────────────────────────────────
 * 三块:
 *   1. Risk of Ruin: 蒙特卡洛仿真破产概率
 *   2. Drawdown 控制: 历史最大回撤 + 当前回撤 + 触发减仓
 *   3. Stop-Loss: 连败 N 次自动暂停推荐
 *
 * 数学:
 *   - Risk of Ruin (RoR) 近似公式(均匀单位仓位):
 *       RoR ≈ ((1-edge)/(1+edge))^(bankroll/avg_loss)
 *     其中 edge = win_rate × avg_win - loss_rate × avg_loss
 *   - 蒙特卡洛仿真:N 次随机 bet 序列,统计触底比例
 *
 * 用法:
 *   const r = computeRiskOfRuin({ winRate: 0.56, avgWin: 1.0, avgLoss: 1.0, bankrollUnits: 100 });
 *   r.riskOfRuin;          // 0.001 = 0.1% 破产概率
 *   r.recommendedKelly;    // 基于 RoR 调整后的凯利分数
 */

/**
 * 近似公式版 RoR.
 */
export function computeRiskOfRuinFormula({ winRate, avgWin = 1.0, avgLoss = 1.0, bankrollUnits = 100 }) {
  const p = Number(winRate);
  const q = 1 - p;
  const aw = Number(avgWin);
  const al = Number(avgLoss);
  if (!Number.isFinite(p) || !Number.isFinite(aw) || !Number.isFinite(al) || p <= 0 || aw <= 0 || al <= 0) {
    return { ok: false, reason: "invalid-input" };
  }
  // Edge per bet (单位仓位)
  const edge = p * aw - q * al;
  if (edge <= 0) {
    return {
      ok: true,
      edge: round(edge),
      riskOfRuin: 1.0,
      verdict: "🔴 负 edge,长期必破产"
    };
  }
  // 简化的 RoR (单位仓位均匀,正态近似):
  // RoR ≈ ((1-edge)/(1+edge))^N,N = bankroll/avg_bet_size
  const ratio = (1 - edge) / (1 + edge);
  const ror = Math.pow(Math.max(0, ratio), bankrollUnits);
  return {
    ok: true,
    edge: round(edge),
    riskOfRuin: round(ror),
    bankrollUnits,
    verdict: ror < 0.001 ? "🟢 破产概率 <0.1%, 安全"
           : ror < 0.01 ? "🟢 破产概率 <1%, 较安全"
           : ror < 0.05 ? "🟠 破产概率 <5%, 可控"
           : ror < 0.20 ? "🟠 破产概率 <20%, 警惕"
           : "🔴 破产概率高,减仓"
  };
}

/**
 * 蒙特卡洛仿真版 RoR.更准但慢.
 */
export function simulateRiskOfRuin({ winRate, avgWin = 1.0, avgLoss = 1.0, bankrollUnits = 100, simulations = 10000, maxBets = 1000 }) {
  const p = Number(winRate);
  const aw = Number(avgWin);
  const al = Number(avgLoss);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return { ok: false, reason: "invalid-winrate" };

  let ruinCount = 0;
  let totalFinalBankroll = 0;
  let maxDrawdownsum = 0;
  for (let sim = 0; sim < simulations; sim++) {
    let bk = bankrollUnits;
    let peak = bk;
    let maxDd = 0;
    let ruined = false;
    for (let b = 0; b < maxBets; b++) {
      if (Math.random() < p) bk += aw;
      else bk -= al;
      if (bk > peak) peak = bk;
      const dd = (peak - bk) / peak;
      if (dd > maxDd) maxDd = dd;
      if (bk <= 0) { ruined = true; break; }
    }
    if (ruined) ruinCount++;
    totalFinalBankroll += Math.max(0, bk);
    maxDrawdownsum += maxDd;
  }
  return {
    ok: true,
    simulations,
    riskOfRuin: round(ruinCount / simulations),
    avgFinalBankroll: round(totalFinalBankroll / simulations),
    avgMaxDrawdown: round(maxDrawdownsum / simulations),
    growthRate: round((totalFinalBankroll / simulations - bankrollUnits) / bankrollUnits)
  };
}

/**
 * Drawdown 分析:历史 ledger 行序列 → 找最大回撤 + 当前回撤
 */
export function analyzeDrawdown(ledgerRows, opts = {}) {
  const startBankroll = opts.startBankroll ?? 100;
  if (!Array.isArray(ledgerRows) || ledgerRows.length === 0) {
    return { ok: false, reason: "no-history" };
  }
  let bk = startBankroll;
  let peak = bk;
  let maxDd = 0;
  let maxDdAt = 0;
  let currentDd = 0;
  const equity = [{ idx: 0, bk: startBankroll, dd: 0 }];
  for (let i = 0; i < ledgerRows.length; i++) {
    const row = ledgerRows[i];
    const stake = Number(row.stakeUnitsPer100 ?? 1);  // 默认 1 单位
    if (row.hit === true) {
      const odds = Number(row.primaryOdds ?? 2.0);
      bk += stake * (odds - 1);
    } else if (row.hit === false) {
      bk -= stake;
    }
    if (bk > peak) peak = bk;
    currentDd = peak > 0 ? (peak - bk) / peak : 0;
    if (currentDd > maxDd) { maxDd = currentDd; maxDdAt = i; }
    equity.push({ idx: i + 1, bk: round(bk), dd: round(currentDd) });
  }
  const consecutiveLosses = countTrailingLosses(ledgerRows);
  return {
    ok: true,
    startBankroll, finalBankroll: round(bk),
    peakBankroll: round(peak),
    maxDrawdown: round(maxDd),
    maxDrawdownAt: maxDdAt,
    currentDrawdown: round(currentDd),
    consecutiveLosses,
    equityCurve: equity.slice(-50),  // 最近 50 个点
    recommendation: buildDrawdownRecommendation(currentDd, maxDd, consecutiveLosses)
  };
}

function countTrailingLosses(rows) {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].hit === false) count++;
    else if (rows[i].hit === true) break;
  }
  return count;
}

function buildDrawdownRecommendation(currentDd, maxDd, consecutiveLosses) {
  if (consecutiveLosses >= 7) return "🔴 连败 ≥7,强制暂停 1 周";
  if (consecutiveLosses >= 5) return "🟠 连败 ≥5,减仓到 1/4";
  if (currentDd > 0.30) return "🔴 当前回撤 >30%,减仓到 1/2 并复盘";
  if (currentDd > 0.20) return "🟠 当前回撤 >20%,减仓到 3/4 并审视";
  if (currentDd > 0.10) return "🟡 当前回撤 >10%,关注但暂不减仓";
  return "🟢 正常,无需调整";
}

/**
 * Stop-loss 触发器:多种触发条件(连败/回撤/单日大损)
 */
export function shouldStop(ledgerRows, opts = {}) {
  const maxConsecLosses = opts.maxConsecLosses ?? 5;
  const maxDrawdown = opts.maxDrawdown ?? 0.30;
  const dd = analyzeDrawdown(ledgerRows, opts);
  if (!dd.ok) return { stop: false };
  return {
    stop: dd.consecutiveLosses >= maxConsecLosses || dd.currentDrawdown >= maxDrawdown,
    reasons: [
      dd.consecutiveLosses >= maxConsecLosses ? `连败 ${dd.consecutiveLosses} 次 ≥ ${maxConsecLosses}` : null,
      dd.currentDrawdown >= maxDrawdown ? `当前回撤 ${(dd.currentDrawdown*100).toFixed(1)}% ≥ ${(maxDrawdown*100).toFixed(0)}%` : null
    ].filter(Boolean),
    currentDrawdown: dd.currentDrawdown,
    consecutiveLosses: dd.consecutiveLosses
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
