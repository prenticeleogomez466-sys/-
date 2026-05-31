/**
 * 彩票构造优化器(2026-05-31)—— 在注数预算内最大化整票联合命中。
 * ────────────────────────────────────────────────────────────
 * 现状:14场胆/双/全、任选9 单/双/全是 if-else 拍脑袋(drawProb≥0.30→三选全 之类),
 *   不是优化。同一批预测,**怎么排这张票**(哪几条单选搏胆、哪几条加保险)能在固定注数里
 *   把"整票全中"概率最大化——这是纯数学。
 *
 * 模型:每条腿 i 可覆盖 1/2/3 个结果。覆盖更多 → 该腿命中概率从 p1 升到 p1+p2 再到 1,
 *   但注数(成本)= Π(各腿覆盖数)随之翻倍。目标:
 *       max  Π_i coveredProb_i        (整票全中概率)
 *       s.t. Π_i count_i ≤ budget     (注数预算)
 *   取对数即背包:每个"升级"(1→2 或 2→3)价值=Δlog(coveredProb)、成本=Δlog(count)。
 *   按 价值/成本 比贪心(各腿升级单调、贪心近最优;腿数≤14×2 升级,规模小)。
 *
 * 用途:任选9(全9中)、14场(可设 requireAll 或留作覆盖建议)。返回每腿覆盖 + 联合命中 + 注数。
 * 不替用户弃赛:只在用户给的注数预算内给最优覆盖,玩不玩、几注由用户定。
 */

const EPS = 1e-12;
const logp = (x) => Math.log(Math.max(x, EPS));

/**
 * @param {Array<{probs:number[], codes:string[]}>} legs 每腿:probs 为该腿各结果概率(无需排序),codes 对应
 * @param {object} opts
 *   budget   注数上限(默认 100)。覆盖成本=Π 各腿覆盖数,须 ≤ budget。
 *   maxCover 单腿最多覆盖数(默认 3=胜平负全覆盖)
 * @returns {{legs:Array, jointHitProb:number, cost:number, baselineHitProb:number, baselineCost:number}}
 */
export function optimizeTicket(legs, opts = {}) {
  const budget = Math.max(1, Number(opts.budget ?? 100));
  const maxCover = Math.min(3, Math.max(1, Number(opts.maxCover ?? 3)));
  if (!Array.isArray(legs) || !legs.length) return { legs: [], jointHitProb: 0, cost: 0, baselineHitProb: 0, baselineCost: 0 };

  // 每腿按结果概率降序,预算覆盖前缀和
  const norm = legs.map((leg, i) => {
    const pairs = leg.probs.map((p, j) => ({ p: Number(p) || 0, code: leg.codes?.[j] ?? String(j) }))
      .sort((a, b) => b.p - a.p);
    const prefix = []; // coveredProb 覆盖前 k 个结果
    let s = 0;
    for (let k = 0; k < pairs.length; k++) { s += pairs[k].p; prefix.push(s); }
    return { i, pairs, prefix };
  });

  // 初始:全单选(每腿覆盖 1),成本 1
  const cover = norm.map(() => 1);
  let cost = 1; // Π count
  const baselineHitProb = norm.reduce((m, l) => m * (l.prefix[0] ?? 0), 1);

  // 候选升级:每腿 cover→cover+1,直到 maxCover。贪心按 Δlog(prob)/Δlog(count)。
  while (true) {
    let best = null;
    for (const l of norm) {
      const c = cover[l.i];
      if (c >= maxCover || c >= l.pairs.length) continue;
      const newCost = cost / c * (c + 1);
      if (newCost > budget + EPS) continue;
      const pOld = l.prefix[c - 1] ?? 0;
      const pNew = l.prefix[c] ?? pOld;
      const dProb = logp(pNew) - logp(pOld);       // ≥0
      const dCost = logp(c + 1) - logp(c);          // >0
      const ratio = dCost > EPS ? dProb / dCost : Infinity;
      if (!best || ratio > best.ratio) best = { leg: l, ratio, newCost };
    }
    if (!best) break;
    cover[best.leg.i] += 1;
    cost = best.newCost;
  }

  const outLegs = norm.map((l) => {
    const c = cover[l.i];
    const covered = l.pairs.slice(0, c);
    return {
      index: l.i,
      cover: c,
      type: c === 1 ? "胆" : c === 2 ? "双选" : "全选",
      codes: covered.map((x) => x.code),
      coveredProb: round(l.prefix[c - 1] ?? 0),
    };
  });
  const jointHitProb = outLegs.reduce((m, l) => m * l.coveredProb, 1);
  return {
    legs: outLegs,
    jointHitProb: round(jointHitProb),
    cost: Math.round(cost),
    baselineHitProb: round(baselineHitProb),  // 全单选(成本1)的整票命中,作对照
    baselineCost: 1,
    budget,
  };
}

function round(v) { return Math.round((Number(v) + Number.EPSILON) * 100000) / 100000; }
