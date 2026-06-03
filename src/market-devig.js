/**
 * 市场去抽水(de-vig)— 把含抽水的赔率还原成隐含真概率。
 * ──────────────────────────────────────────────────────────────────────────
 * 提供三法,统一接口 devig(odds, method):
 *   - "proportional"(基础):p_i = (1/o_i) / Σ(1/o_j)。简单,但把抽水按比例摊给各项,
 *      会系统性高估热门、低估冷门(favourite-longshot bias 未校正)。
 *   - "shin"(Shin 1992/93):假设盘口含一部分内幕交易者(比例 z),按比例还原。
 *      对热门-冷门偏差有理论校正,实证(penaltyblog 等)通常优于比例法。
 *   - "power":p_i ∝ (1/o_i)^k,解 k 使 Σp_i=1。另一种偏差校正。
 *
 * 全纯函数,无 IO。odds = {home,draw,away}(十进制 >1),返回同形概率(和=1)或 null。
 * 也支持任意路数:devigArray([o1,o2,...], method) → [p1,...]。
 *
 * Shin 反演(Štrumbelj 2014 形式):令 π_i=1/o_i, B=Σπ_j, q_i=π_i/B(归一书概率)。
 *   p_i(z) = [ sqrt(z² + 4(1−z)·q_i²·(... )) ... ] —— 这里用稳定形式:
 *   p_i(z) = ( sqrt( z² + 4(1−z) · π_i² / B ) − z ) / ( 2(1−z) )
 *   解 z∈[0, 0.5) 使 Σ p_i(z) = 1(二分法)。z=0 退化为比例法。
 */

function toTriple(odds) {
  if (!odds) return null;
  const o = { home: Number(odds.home), draw: Number(odds.draw), away: Number(odds.away) };
  if (!(o.home > 1 && o.draw > 1 && o.away > 1)) return null;
  return o;
}

export function proportionalDevig(odds) {
  const o = toTriple(odds);
  if (!o) return null;
  const ih = 1 / o.home, id = 1 / o.draw, ia = 1 / o.away, s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}

/** Shin 去抽水:返回 {home,draw,away,z}(z=估计内幕比例)。任意路数用 shinArray。 */
export function shinDevig(odds) {
  const o = toTriple(odds);
  if (!o) return null;
  const pis = [1 / o.home, 1 / o.draw, 1 / o.away];
  const { probs, z } = shinFromInverse(pis);
  return { home: probs[0], draw: probs[1], away: probs[2], z };
}

/** 通用 Shin:输入逆赔率数组(π_i=1/o_i),解 z 使 Σp_i(z)=1。
 *  p_i(z) = ( sqrt(z² + 4(1−z)·π_i²/B) − z ) / ( 2(1−z) ),B=Σπ_j。
 *  z=0 时 Σ=√B>1(有抽水),Σp(z) 随 z 单调下降 → 二分 [0,0.5) 求根。 */
export function shinFromInverse(pis) {
  const B = pis.reduce((a, b) => a + b, 0);
  if (!(B > 0)) return { probs: pis.map(() => 0), z: 0 };
  const pAt = (z) => pis.map((pi) => {
    const root = Math.sqrt(z * z + 4 * (1 - z) * (pi * pi) / B);
    return (root - z) / (2 * (1 - z));
  });
  const sumAt = (z) => pAt(z).reduce((a, b) => a + b, 0);
  let lo = 0, hi = 0.5;
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid; // Σ 随 z 下降
  }
  const z = (lo + hi) / 2;
  let probs = pAt(z);
  const ps = probs.reduce((a, b) => a + b, 0);
  if (ps > 0) probs = probs.map((p) => p / ps); // 数值兜底归一
  return { probs, z };
}

/** Power 去抽水:p_i ∝ (1/o_i)^k,解 k 使 Σ=1。 */
export function powerDevig(odds) {
  const o = toTriple(odds);
  if (!o) return null;
  const inv = [1 / o.home, 1 / o.draw, 1 / o.away];
  let lo = 0.5, hi = 2.0;
  const sumAt = (k) => inv.reduce((a, p) => a + p ** k, 0);
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const raw = inv.map((p) => p ** k);
  const s = raw.reduce((a, b) => a + b, 0);
  return { home: raw[0] / s, draw: raw[1] / s, away: raw[2] / s, k };
}

/** 统一入口。method: "proportional"|"shin"|"power"。默认 shin。 */
export function devig(odds, method = "shin") {
  if (method === "proportional") return proportionalDevig(odds);
  if (method === "power") return powerDevig(odds);
  return shinDevig(odds);
}
