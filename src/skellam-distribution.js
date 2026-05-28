/**
 * Skellam 分布(两个独立 Poisson 之差)
 * ──────────────────────────────────────────────────
 * 用于直接建模 home_goals - away_goals(进球差).
 * P(D=k) = e^{-(λ1+λ2)} (λ1/λ2)^(k/2) I_|k|(2 sqrt(λ1*λ2))
 * 其中 I_n 是第一类修正贝塞尔函数.
 *
 * 用途:
 *   - 让球胜平负玩法直接算:P(D > line) = sum over D > line
 *   - 比 DC 矩阵更紧凑(一维 vs 二维)
 *   - 跟 Markov / DC 结果互相验证
 */

const MAX_K = 10;
const BESSEL_TERMS = 30;

/**
 * Bessel function of first kind, modified, integer order
 * I_n(x) = sum_{k=0..∞} (x/2)^(2k+n) / (k! (k+n)!)
 */
export function besselI(n, x) {
  const absN = Math.abs(n);
  let sum = 0;
  for (let k = 0; k < BESSEL_TERMS; k++) {
    const num = Math.pow(x / 2, 2 * k + absN);
    const den = factorial(k) * factorial(k + absN);
    const term = num / den;
    if (!Number.isFinite(term)) break;
    sum += term;
    if (term < 1e-15 && k > 5) break;
  }
  return sum;
}

const _factCache = [1, 1];
function factorial(n) {
  if (n < 0) return Infinity;
  if (n < _factCache.length) return _factCache[n];
  let v = _factCache[_factCache.length - 1];
  for (let i = _factCache.length; i <= n; i++) { v *= i; _factCache[i] = v; }
  return _factCache[n];
}

/**
 * Skellam PMF: P(D=k) for D = X - Y where X~Po(λ1), Y~Po(λ2)
 */
export function skellamPMF(k, lambda1, lambda2) {
  if (!Number.isFinite(lambda1) || !Number.isFinite(lambda2) || lambda1 < 0 || lambda2 < 0) return 0;
  if (lambda1 === 0 && lambda2 === 0) return k === 0 ? 1 : 0;
  const factor = Math.exp(-(lambda1 + lambda2));
  const ratio = lambda2 > 0 ? Math.pow(lambda1 / lambda2, k / 2) : Math.pow(lambda1, k);
  const bessel = besselI(k, 2 * Math.sqrt(lambda1 * lambda2));
  return factor * ratio * bessel;
}

/**
 * 全分布:返回 [-MAX_K .. MAX_K] 的概率字典
 */
export function skellamDistribution(lambda1, lambda2) {
  const dist = {};
  let sum = 0;
  for (let k = -MAX_K; k <= MAX_K; k++) {
    const p = skellamPMF(k, lambda1, lambda2);
    dist[k] = p;
    sum += p;
  }
  // 归一化(截尾损失)
  if (sum > 0) for (const k of Object.keys(dist)) dist[k] /= sum;
  return dist;
}

/**
 * 让球胜平负玩法:给一个让球数 line(负值=主队让 line 球),返回 {主胜,平,客胜}
 *   主胜 = D > -line
 *   平 = D == -line
 *   客胜 = D < -line
 */
export function asianHandicapFromSkellam(lambda1, lambda2, line = 0) {
  const dist = skellamDistribution(lambda1, lambda2);
  let home = 0, draw = 0, away = 0;
  const threshold = -line;
  for (const k of Object.keys(dist)) {
    const v = Number(k);
    const p = dist[k];
    if (v > threshold) home += p;
    else if (v === threshold) draw += p;
    else away += p;
  }
  return { home: round(home), draw: round(draw), away: round(away) };
}

/**
 * 大小球:总进球 = X + Y(不是差,Skellam 不直接给出);
 * 仍走 Poisson 之和(也是 Poisson(λ1+λ2)).
 */
export function overUnderFromSkellam(lambda1, lambda2, line = 2.5) {
  const total = lambda1 + lambda2;
  let over = 0;
  for (let k = 0; k < 15; k++) {
    if (k > line) over += poissonPMF(k, total);
  }
  return { over: round(over), under: round(1 - over) };
}

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - Math.log(factorial(k)));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
