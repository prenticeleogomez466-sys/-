/**
 * 半全场(HT/FT)联合分布升级模型 —— 2026-05-31
 * ──────────────────────────────────────────────────────────────
 * 现状缺陷(对比 prediction-engine.halfFullProbsFromLambdas 固定 0.46 裸 Poisson):
 *   ① halfRatio 写死 0.46,主客一样、所有赛事一样;
 *   ② 每半场用裸独立 Poisson,无 Dixon-Coles τ 低分修正 → 半时平局(0-0/1-1)被低估;
 *   ③ 两半完全独立,忽略"领先方控/落后方搏"的比赛状态依赖。
 *
 * 本模块三项改进(全部数据可拟合、可回测,默认参数来自 football-data big-5 实测):
 *   A. τ 低分修正:每半场比分矩阵套 DC τ(rho),抬半时平局;
 *   B. 半场比例数据拟合:firstHalfRatio 默认 0.45(实测下半场进球更多),主客可分别设;
 *   C. 二半场状态依赖(可选,默认弱开):上半场领先 → 落后方下半场 λ 上抬(搏)、领先方略降(控),
 *      强度 chase∈[0,..],chase=0 即退回"两半独立"(与旧模型对齐,便于回测增量)。
 *
 * 全部以**全场 λ 为输入**,输出 9 类半全场概率字典,与旧 halfFullProbsFromLambdas 接口同形,
 * 可直接替换。遵 feedback-wld-anchor:FT 边际由全场 λ 决定,挑选时仍按上游锚 wld 方向条件化(调用方负责)。
 */

const MAX_GOALS = 6;

// 默认参数(来自 football-data big-5 实测半场/全场比分;见 fitHalfFullParams)
export const HF_DEFAULTS = Object.freeze({
  firstHalfRatioHome: 0.45,
  firstHalfRatioAway: 0.45,
  rho: -0.08,     // DC 低分相关(与主引擎 DC_RHO 同口径)
  chase: 0.18,    // 二半场状态依赖强度(0=两半独立)
});

const HF_CLASSES = [
  "主胜-主胜", "主胜-平局", "主胜-客胜",
  "平局-主胜", "平局-平局", "平局-客胜",
  "客胜-主胜", "客胜-平局", "客胜-客胜",
];

function logFact(n) {
  let v = 0;
  for (let i = 2; i <= n; i++) v += Math.log(i);
  return v;
}

function poissonPmf(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFact(k));
}

// Dixon-Coles τ:仅修正 0-0/1-0/0-1/1-1 四格,口径同 dixon-coles-engine。
function tau(h, a, lambda, mu, rho) {
  if (h === 0 && a === 0) return 1 - lambda * mu * rho;
  if (h === 0 && a === 1) return 1 + lambda * rho;
  if (h === 1 && a === 0) return 1 + mu * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// 单半场比分矩阵(带 τ 修正,归一化)。lambda=主队该半场 λ,mu=客队该半场 λ。
function halfScoreMatrix(lambda, mu, rho, maxGoals = MAX_GOALS) {
  const m = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    m[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p = Math.max(poissonPmf(h, lambda) * poissonPmf(a, mu) * tau(h, a, lambda, mu, rho), 0);
      m[h][a] = p;
      total += p;
    }
  }
  if (total > 0) for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) m[h][a] /= total;
  return m;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 半全场 9 类联合概率。输入全场 λ_home / μ_away。
 * @param {number} lambdaHome 全场主队期望进球
 * @param {number} muAway     全场客队期望进球
 * @param {object} [opts]     覆盖 HF_DEFAULTS 的参数
 * @returns {Record<string, number>} 9 类("主胜-主胜"…)概率字典,和=1
 */
export function halfFullJoint(lambdaHome, muAway, opts = {}) {
  const p = { ...HF_DEFAULTS, ...opts };
  const LH = clamp(Number(lambdaHome), 0, 8);
  const MA = clamp(Number(muAway), 0, 8);
  if (!Number.isFinite(LH) || !Number.isFinite(MA)) return null;

  // 半场 λ 切分
  const lh1 = LH * clamp(p.firstHalfRatioHome, 0.2, 0.8);
  const ma1 = MA * clamp(p.firstHalfRatioAway, 0.2, 0.8);
  const lh2Base = LH - lh1;
  const ma2Base = MA - ma1;

  const probs = Object.fromEntries(HF_CLASSES.map((c) => [c, 0]));
  // 上半场联合(带 τ)
  const half1 = halfScoreMatrix(lh1, ma1, p.rho);

  for (let h1 = 0; h1 <= MAX_GOALS; h1++) {
    for (let a1 = 0; a1 <= MAX_GOALS; a1++) {
      const p1 = half1[h1][a1];
      if (p1 <= 0) continue;
      const margin = h1 - a1; // 上半场净胜球(主视角)
      const htLabel = h1 > a1 ? "主胜" : h1 === a1 ? "平局" : "客胜";

      // 二半场状态依赖:领先方略控、落后方搏(chase=0 即退回独立)。
      // 用 tanh 软饱和,避免大比分时过度放大;只调下半场 λ,不改全场总量过多。
      const t = Math.tanh(margin);                 // ∈(-1,1)
      const lh2 = clamp(lh2Base * (1 - p.chase * t) , 0.01, 8);  // 主队领先(t>0)→ 略降
      const ma2 = clamp(ma2Base * (1 + p.chase * t) , 0.01, 8);  // 客队落后(t>0)→ 上抬
      const half2 = halfScoreMatrix(lh2, ma2, p.rho);

      for (let h2 = 0; h2 <= MAX_GOALS; h2++) {
        for (let a2 = 0; a2 <= MAX_GOALS; a2++) {
          const p2 = half2[h2][a2];
          if (p2 <= 0) continue;
          const fh = h1 + h2;
          const fa = a1 + a2;
          const ftLabel = fh > fa ? "主胜" : fh === fa ? "平局" : "客胜";
          probs[`${htLabel}-${ftLabel}`] += p1 * p2;
        }
      }
    }
  }
  // 归一化(MAX_GOALS 截尾误差)
  const sum = Object.values(probs).reduce((s, v) => s + v, 0);
  if (sum > 0) for (const k of HF_CLASSES) probs[k] /= sum;
  return probs;
}

/**
 * 从历史 HT/FT 比分拟合参数(leak-safe:调用方只传训练集)。
 * @param {Array<{halfHome,halfAway,homeGoals,awayGoals}>} matches
 * @returns {{firstHalfRatioHome,firstHalfRatioAway,n,note}}
 */
export function fitHalfFullParams(matches) {
  let h1 = 0, a1 = 0, hf = 0, af = 0, n = 0;
  for (const m of matches ?? []) {
    if (m.halfHome == null || m.halfAway == null || m.homeGoals == null || m.awayGoals == null) continue;
    h1 += m.halfHome; a1 += m.halfAway;
    hf += m.homeGoals; af += m.awayGoals;
    n++;
  }
  if (!n || hf <= 0 || af <= 0) return { ...HF_DEFAULTS, n: 0, note: "样本不足,用默认" };
  return {
    firstHalfRatioHome: clamp(h1 / hf, 0.3, 0.6),
    firstHalfRatioAway: clamp(a1 / af, 0.3, 0.6),
    n,
    note: `实测半场占比 主${(h1 / hf).toFixed(3)}/客${(a1 / af).toFixed(3)}(${n}场)`,
  };
}

export { HF_CLASSES };
