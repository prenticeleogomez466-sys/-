/**
 * Shot-based Expected Goals 代理(pre-xG 时代期望进球)
 * ────────────────────────────────────────────────────────────
 * 背景(见分析师评审):真实 per-match xG 在本系统拿不到
 *   —— OpenFootball 历史只有比分,Understat 反爬,无 API key。
 * 但 football-data.co.uk 五大联赛逐场都有 射门(HS/AS)+ 射正(HST/AST),
 * 而"用射门质量估期望进球、再让实际进球向它回归去噪"正是 xG 比进球更准的核心机理:
 *   - 实际进球是高方差的"实现值"(一场 2-0 可能 xG 只配 0.9);
 *   - 射门/射正样本量更大,更接近"潜在实力"。
 *
 * 关键设计:转化率不写死,而是从传入的比赛集自校准 ——
 *   - 每个进球本身就是一次射正 → goals/SOT 即射正转化率的天然估计;
 *   - 用无截距最小二乘(0 射门→0 期望进球)解 射正 / 射偏 两个系数,夹到合理区间。
 * 在 walk-forward 里,fitFromMatches 只喂训练切片,故校准也只用训练数据,不泄漏未来。
 */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * 从一组带 shots/sot/goals 的比赛自校准射门→进球转化率。
 * 模型(无截距):goals ≈ sotRate·SOT + offTargetRate·(shots-SOT)
 * @param {Array<{shots:{home,away},sot:{home,away},homeGoals,awayGoals}>} matches
 * @returns {{sotRate:number,offTargetRate:number,samples:number}|null}
 */
export function calibrateShotConversion(matches = []) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, n = 0;
  for (const m of matches) {
    if (!m?.shots || !m?.sot) continue;
    for (const side of ["home", "away"]) {
      const sot = side === "home" ? m.sot.home : m.sot.away;
      const sh = side === "home" ? m.shots.home : m.shots.away;
      const g = side === "home" ? m.homeGoals : m.awayGoals;
      if (![sot, sh, g].every((v) => Number.isFinite(Number(v)))) continue;
      const x1 = Math.max(0, Number(sot));
      const x2 = Math.max(0, Number(sh) - Number(sot));
      const y = Number(g);
      s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2;
      s1y += x1 * y; s2y += x2 * y; n++;
    }
  }
  if (n < 20) return null; // 样本太少,不可靠
  const det = s11 * s22 - s12 * s12;
  let b1, b2;
  if (Math.abs(det) < 1e-9) {
    // 共线/退化:退回 goals/SOT 单变量率
    b1 = s11 > 0 ? s1y / s11 : 0.3;
    b2 = 0;
  } else {
    b1 = (s22 * s1y - s12 * s2y) / det;
    b2 = (s11 * s2y - s12 * s1y) / det;
  }
  return {
    sotRate: clamp(b1, 0.05, 0.6), // 射正转化率,典型 ~0.30
    offTargetRate: clamp(b2, 0, 0.15), // 射偏边际贡献(领土压制可持续性),典型很小
    samples: n
  };
}

/**
 * 用校准好的转化率,把一队某场的射门数据估成期望进球。
 * @param {{shots:number,sot:number}} line
 * @param {{sotRate:number,offTargetRate:number}} conversion
 * @returns {number|null}
 */
export function shotXgProxy(line, conversion) {
  if (!conversion) return null;
  const shots = Number(line?.shots);
  const sot = Number(line?.sot);
  if (!Number.isFinite(shots) || !Number.isFinite(sot)) return null;
  const offTarget = Math.max(0, shots - sot);
  return Math.max(0, conversion.sotRate * Math.max(0, sot) + conversion.offTargetRate * offTarget);
}

/**
 * 把实际进球向射门期望回归去噪。
 * @param {number} actualGoals
 * @param {number} xgProxy
 * @param {number} weight 朝期望回归的权重 0~1(0=纯实际进球,1=纯射门期望)
 * @returns {number}
 */
export function regressedGoalSignal(actualGoals, xgProxy, weight = 0.5) {
  const a = Number(actualGoals);
  if (!Number.isFinite(xgProxy)) return a;
  const w = clamp(Number(weight), 0, 1);
  return (1 - w) * a + w * xgProxy;
}

/**
 * 给一组比赛批量标注 shot-regressed 进球信号,供 Dixon-Coles 拟合用。
 * 不修改原数组;有 shots/sot 的场次替换 homeGoals/awayGoals 为去噪信号,
 * 并保留 _rawHomeGoals/_rawAwayGoals/_xg 供审计。
 * @param {Array} matches
 * @param {{conversion?, weight?:number}} opts
 * @returns {{matches:Array, conversion, applied:number, weight:number}}
 */
export function annotateRegressedGoals(matches = [], opts = {}) {
  const conversion = opts.conversion ?? calibrateShotConversion(matches);
  const weight = opts.weight ?? 0.5;
  if (!conversion) {
    return { matches: matches.map((m) => ({ ...m })), conversion: null, applied: 0, weight };
  }
  let applied = 0;
  const out = matches.map((m) => {
    if (!m?.shots || !m?.sot) return { ...m };
    const xgH = shotXgProxy({ shots: m.shots.home, sot: m.sot.home }, conversion);
    const xgA = shotXgProxy({ shots: m.shots.away, sot: m.sot.away }, conversion);
    if (xgH == null || xgA == null) return { ...m };
    applied++;
    return {
      ...m,
      homeGoals: regressedGoalSignal(m.homeGoals, xgH, weight),
      awayGoals: regressedGoalSignal(m.awayGoals, xgA, weight),
      _rawHomeGoals: m.homeGoals,
      _rawAwayGoals: m.awayGoals,
      _xg: { home: round(xgH), away: round(xgA) }
    };
  });
  return { matches: out, conversion, applied, weight };
}
