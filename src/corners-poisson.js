/**
 * 角球泊松模型 corners-poisson
 * ────────────────────────────────────────────────────────────
 * 全新低流动性市场:庄家对角球盘精调远不如 1X2/大小球,存在可挖 edge。
 * 复用 Dixon-Coles 式攻防比率思路,但目标变量换成"每队角球数":
 *   λ主角球 = 联赛主场角球均值 × 主队角球攻击力 × 客队角球防守力
 *   λ客角球 = 联赛客场角球均值 × 客队角球攻击力 × 主队角球防守力
 * 两路独立泊松 → 总角球分布(卷积)→ 大/小角球、让角球(Skellam)。
 *
 * 数据来源:footballdata-loader 的 m.corners = {home:HC, away:AC}(五大+扩展联赛逐场免费)。
 * 设计约束:
 *   - 可插拔、纯描述新市场,**不动** 1X2/比分/俱乐部主路径概率。
 *   - 缺角球数据 → fit 返回 usable:false,predict 返回 null,下游优雅降级(不臆造)。
 *   - 攻防力按样本量向 1.0 收缩(经验贝叶斯),少样本不过拟合。
 *   - 时间衰减 exp(-xi·ageDays) 加权,近赛权重高。
 */

const DEFAULTS = {
  xi: 0.0019, // 时间衰减(与 DC 同量级,半衰期 ~365 天)
  shrink: 6, // 收缩强度:有效样本 n 下,权重 n/(n+shrink) 朝联赛均值 1.0 收缩
  minMatchesPerTeam: 4, // 一支队两个场地合计 <4 场 → 该队不可用
  minLeagueMatches: 30, // 联赛角球样本太少 → 该联赛整体不可用
  clampAttack: [0.4, 2.2], // 攻防力夹逼,防极端
};

function poissonPmf(k, lambda) {
  if (!(lambda > 0) || k < 0) return k === 0 ? Math.exp(-Math.max(lambda, 0)) : 0;
  // log 域防溢出
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

// 两路独立泊松的"总和"分布:Poisson(λ1+λ2)。直接用合并 λ。
function totalCornerDistribution(lambdaHome, lambdaAway, maxK = 30) {
  const lambda = lambdaHome + lambdaAway;
  const dist = [];
  let cum = 0;
  for (let k = 0; k <= maxK; k++) {
    const p = poissonPmf(k, lambda);
    dist.push(p);
    cum += p;
  }
  // 尾部质量归到最后一格,保证和为 1
  if (cum < 1 && dist.length) dist[dist.length - 1] += 1 - cum;
  return dist;
}

// P(总角球 > line)。line 通常为 .5 结尾(8.5/9.5/10.5/11.5)。
export function overUnderCorners(lambdaHome, lambdaAway, line = 9.5) {
  const dist = totalCornerDistribution(lambdaHome, lambdaAway);
  let over = 0;
  for (let k = 0; k < dist.length; k++) if (k > line) over += dist[k];
  return { over: clamp01(over), under: clamp01(1 - over) };
}

// 让角球(主队视角):Skellam(λ主-λ客) 让 line 关。line<0 表示主让。
// 返回 {home,push,away}=主受让后过盘/走盘/输盘。整数线才有 push。
export function handicapCorners(lambdaHome, lambdaAway, line = 0, maxK = 30) {
  let home = 0,
    push = 0,
    away = 0;
  for (let h = 0; h <= maxK; h++) {
    const ph = poissonPmf(h, lambdaHome);
    for (let a = 0; a <= maxK; a++) {
      const p = ph * poissonPmf(a, lambdaAway);
      const margin = h - a + line; // 主队让 line(line 负=主让)后的净角球
      if (margin > 1e-9) home += p;
      else if (margin < -1e-9) away += p;
      else push += p;
    }
  }
  const s = home + push + away || 1;
  return { home: home / s, push: push / s, away: away / s };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function clamp(x, [lo, hi]) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 拟合角球攻防评级。
 * @param {Array} matches  footballdata-loader 行,需 m.corners / m.home / m.away / m.league / m.date
 * @param {object} opts    {xi, shrink, asOf, leagues}
 *   asOf: 只用该日期(不含)之前的比赛 → leak-safe 回测必传。
 *   leagues: 限定联赛集合(数组),不传则按各自联赛分桶。
 * @returns {{usable, byLeague, predict}}
 */
export function fitCornerRatings(matches, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const asOf = opts.asOf ?? null;
  const leagueFilter = opts.leagues ? new Set(opts.leagues) : null;

  const usable = (matches || []).filter(
    (m) =>
      m &&
      m.corners &&
      Number.isFinite(m.corners.home) &&
      Number.isFinite(m.corners.away) &&
      m.home &&
      m.away &&
      m.date &&
      (!asOf || m.date < asOf) &&
      (!leagueFilter || leagueFilter.has(m.league))
  );

  if (!usable.length) return { usable: false, reason: "no_corner_data", byLeague: {}, predict: () => null };

  // 时间衰减锚点 = 数据中最新日期
  const latest = usable.reduce((mx, m) => (m.date > mx ? m.date : mx), usable[0].date);
  const latestMs = Date.parse(latest);
  const weightOf = (date) => {
    const age = (latestMs - Date.parse(date)) / 86400000;
    return Math.exp(-cfg.xi * Math.max(0, age));
  };

  // 按联赛分桶累计:联赛均值 + 每队 home/away 的 for/against 加权均值
  const leagues = {};
  for (const m of usable) {
    const L = (leagues[m.league] ??= {
      wHomeFor: 0, // Σw·主队主场获得角球
      wAwayFor: 0,
      wSum: 0,
      teams: {},
    });
    const w = weightOf(m.date);
    L.wHomeFor += w * m.corners.home;
    L.wAwayFor += w * m.corners.away;
    L.wSum += w;
    const HT = (L.teams[m.home] ??= blankTeam());
    const AT = (L.teams[m.away] ??= blankTeam());
    // 主队:主场 for=home角球, against=away角球
    HT.homeFor += w * m.corners.home;
    HT.homeAgainst += w * m.corners.away;
    HT.homeW += w;
    HT.n += 1;
    // 客队:客场 for=away角球, against=home角球
    AT.awayFor += w * m.corners.away;
    AT.awayAgainst += w * m.corners.home;
    AT.awayW += w;
    AT.n += 1;
  }

  const byLeague = {};
  for (const [name, L] of Object.entries(leagues)) {
    if (L.wSum < cfg.minLeagueMatches) continue; // 加权样本不足
    const leagueHomeAvg = L.wHomeFor / L.wSum; // 主场场均角球
    const leagueAwayAvg = L.wAwayFor / L.wSum; // 客场场均角球
    if (!(leagueHomeAvg > 0) || !(leagueAwayAvg > 0)) continue;
    const ratings = {};
    for (const [team, t] of Object.entries(L.teams)) {
      if (t.n < cfg.minMatchesPerTeam) continue;
      // 攻击力 = 该队该场地 for 均值 / 联赛该场地均值,按有效样本朝 1.0 收缩
      const attackHome = shrunkRatio(t.homeFor, t.homeW, leagueHomeAvg, cfg.shrink, cfg.clampAttack);
      const attackAway = shrunkRatio(t.awayFor, t.awayW, leagueAwayAvg, cfg.shrink, cfg.clampAttack);
      // 防守力 = 该队该场地 against 均值 / 联赛(对手该场地)均值。主队防守对的是客队获得=leagueAwayAvg
      const defenseHome = shrunkRatio(t.homeAgainst, t.homeW, leagueAwayAvg, cfg.shrink, cfg.clampAttack);
      const defenseAway = shrunkRatio(t.awayAgainst, t.awayW, leagueHomeAvg, cfg.shrink, cfg.clampAttack);
      ratings[team] = { attackHome, attackAway, defenseHome, defenseAway, n: t.n };
    }
    byLeague[name] = { leagueHomeAvg, leagueAwayAvg, ratings, sampleW: L.wSum };
  }

  function predict(home, away, league, { hcLines = [0, -1, 1], ouLines = [8.5, 9.5, 10.5, 11.5] } = {}) {
    const L = byLeague[league];
    if (!L) return null;
    const H = L.ratings[home];
    const A = L.ratings[away];
    if (!H || !A) return null;
    const lambdaHome = clamp(L.leagueHomeAvg * H.attackHome * A.defenseAway, [0.5, 14]);
    const lambdaAway = clamp(L.leagueAwayAvg * A.attackAway * H.defenseHome, [0.5, 14]);
    const expectedTotal = lambdaHome + lambdaAway;
    return {
      lambdaHome: round2(lambdaHome),
      lambdaAway: round2(lambdaAway),
      expectedTotal: round2(expectedTotal),
      overUnder: Object.fromEntries(
        ouLines.map((line) => [line, overUnderCorners(lambdaHome, lambdaAway, line)])
      ),
      handicap: Object.fromEntries(
        hcLines.map((line) => [line, handicapCorners(lambdaHome, lambdaAway, line)])
      ),
      sampleN: Math.min(H.n, A.n),
    };
  }

  return {
    usable: Object.keys(byLeague).length > 0,
    byLeague,
    teamsCovered: Object.values(byLeague).reduce((s, L) => s + Object.keys(L.ratings).length, 0),
    matchesUsed: usable.length,
    predict,
  };
}

function blankTeam() {
  return { homeFor: 0, homeAgainst: 0, homeW: 0, awayFor: 0, awayAgainst: 0, awayW: 0, n: 0 };
}

// 加权均值 / 基线,朝 1.0 收缩:有效权重 w 下,ratio*(w/(w+k)) + 1*(k/(w+k))
function shrunkRatio(weightedSum, weight, baseline, k, clampRange) {
  if (!(weight > 0) || !(baseline > 0)) return 1;
  const raw = weightedSum / weight / baseline;
  const lambda = weight / (weight + k);
  return clamp(raw * lambda + 1 * (1 - lambda), clampRange);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

export const __test = { poissonPmf, totalCornerDistribution, shrunkRatio };
