/**
 * 状态空间动态评级 state-space-ratings(在线泊松 Elo)
 * ────────────────────────────────────────────────────────────
 * 现状:DC 是周期性"批量重拟合"(一段窗内球队强度视为常数)。
 * 本模块:把球队 攻击力 a / 防守力 d 当作**时变隐状态**,每场赛后按泊松梯度在线更新,
 *   对最近表现反应更快、不需整窗重拟合。等价"Poisson Elo / 在线 Dixon-Coles"。
 *
 * 模型:λ主 = exp(μ + h + a[主] − d[客]),λ客 = exp(μ + a[客] − d[主])。
 *   赛后梯度(泊松对数似然 ∂/∂a[主] = g主 − λ主):
 *     a[主] += lr·(g主 − λ主);  d[客] −= lr·(g主 − λ主)
 *     a[客] += lr·(g客 − λ客);  d[主] −= lr·(g客 − λ客)
 *   lr = 学习率(=遗忘速度,越大越追近期)。a/d 朝 0 轻微收缩防漂移。
 *
 * 定位:候选核心,**先回测对比静态 DC,不赢不接**。纯 1X2/比分概率,不碰 picks 决策。
 */

const DEFAULTS = {
  lr: 0.06, // 学习率/遗忘速度
  decayToMean: 0.0008, // 每场朝 0 收缩(L2),防长期漂移
  homeAdv: 0.26, // log 域主场优势初值(在线微调)
  baseMu: 0.1, // log 域进球基线初值(≈exp(0.1)·... 配合 a/d≈0 时 λ≈1.3)
  maxRate: 6, // λ 上限
  rho: -0.05, // Dixon-Coles 低分修正(0-0/1-0/0-1/1-1),与主引擎同号
  maxGoals: 8,
};

function clampRate(x, max) {
  return Math.max(0.05, Math.min(max, x));
}
function poissonPmf(k, lambda) {
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}
// DC 低分相关修正 τ
function tau(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

/**
 * 在线训练 + 滚动预测。给定按时间升序的比赛,逐场"先预测后更新",
 * 返回每场的预测(leak-safe 自带:预测只用赛前状态)。
 * @param {Array} matches 需 {date,home,away,homeGoals,awayGoals,league}
 * @param {object} opts {lr,decayToMean,homeAdv,baseMu,rho, byLeague}
 *   byLeague:true → 每联赛独立一套状态(默认 true,跨联赛强度不可比)。
 * @returns {{predictions, state}}
 */
export function runStateSpaceRatings(matches, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const byLeague = opts.byLeague !== false;
  const sorted = [...(matches || [])]
    .filter((m) => m && m.home && m.away && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 每联赛(或全局)一组状态
  const books = {}; // league -> { a:{}, d:{}, mu, h, n }
  const bookOf = (league) => {
    const key = byLeague ? league || "_global" : "_global";
    return (books[key] ??= { a: {}, d: {}, mu: cfg.baseMu, h: cfg.homeAdv, n: 0 });
  };

  const predictions = [];
  for (const m of sorted) {
    const bk = bookOf(m.league);
    const ah = bk.a[m.home] ?? 0;
    const dh = bk.d[m.home] ?? 0;
    const aa = bk.a[m.away] ?? 0;
    const da = bk.d[m.away] ?? 0;
    const lh = clampRate(Math.exp(bk.mu + bk.h + ah - da), cfg.maxRate);
    const la = clampRate(Math.exp(bk.mu + aa - dh), cfg.maxRate);

    // 赛前预测(只在两队都见过 ≥ 个别场后才算"有效",但仍输出供回测过滤)
    const seenHome = bk.a[m.home] !== undefined;
    const seenAway = bk.a[m.away] !== undefined;
    predictions.push({
      date: m.date,
      league: m.league,
      home: m.home,
      away: m.away,
      lambdaHome: lh,
      lambdaAway: la,
      probs: outcomeProbs(lh, la, cfg.rho, cfg.maxGoals),
      warmed: seenHome && seenAway && bk.n >= 20,
      actual: { home: m.homeGoals, away: m.awayGoals },
    });

    // 赛后在线更新(泊松梯度)
    const eh = m.homeGoals - lh;
    const ea = m.awayGoals - la;
    bk.a[m.home] = (ah + cfg.lr * eh) * (1 - cfg.decayToMean);
    bk.d[m.away] = (da - cfg.lr * eh) * (1 - cfg.decayToMean);
    bk.a[m.away] = (aa + cfg.lr * ea) * (1 - cfg.decayToMean);
    bk.d[m.home] = (dh - cfg.lr * ea) * (1 - cfg.decayToMean);
    // 主场优势/基线缓动(全局信号,极小步长)
    bk.h += 0.002 * (eh - ea) * 0.5;
    bk.mu += 0.0008 * (eh + ea);
    bk.h = Math.max(0, Math.min(0.6, bk.h));
    bk.mu = Math.max(-0.5, Math.min(0.9, bk.mu));
    bk.n += 1;
  }

  return { predictions, state: books };
}

// 由两路 λ + ρ 出 1X2 概率(DC 低分修正)
export function outcomeProbs(lh, la, rho = DEFAULTS.rho, maxGoals = DEFAULTS.maxGoals) {
  let home = 0,
    draw = 0,
    away = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lh);
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph * poissonPmf(a, la) * tau(h, a, lh, la, rho);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const s = home + draw + away || 1;
  return { home: home / s, draw: draw / s, away: away / s };
}

export const __test = { poissonPmf, tau };
