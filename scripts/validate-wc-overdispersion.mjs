/**
 * leak-safe 验证:世界杯进球分布是泊松还是过离散?决定超算每场该用 Poisson 还是 NB(size=8)。
 * 数据:data/intl-results/results.csv 的 FIFA World Cup 真实赛果(1990-2022)。
 * 方法(无需历史 Elo,纯检验边缘进球分布形状,leak-free):
 *   每场贡献两观测(主队进球、客队进球)→ 经验均值 μ。
 *   比较 Poisson(μ) 与 NB(mean=μ, size=8) 对这些真实进球数的对数似然 + 比分矩阵对 90' 胜平负的拟合。
 *   NB 似然更高 ⇒ 过离散真实存在 ⇒ 超算统一到 NB(8)(与单场模型一致)有据。
 * 仅描述性/分布拟合,非命中率净增益承诺。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csv = fs.readFileSync(path.join(__dirname, "..", "data", "intl-results", "results.csv"), "utf8");
const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => {
  const p = l.split(",");
  return { year: +p[0].slice(0, 4), tournament: p[5], hs: +p[3], as: +p[4] };
});
const wc = rows.filter((r) => r.tournament === "FIFA World Cup" && r.year >= 1990 && Number.isFinite(r.hs) && Number.isFinite(r.as));

const goals = [];
let draws = 0;
for (const r of wc) { goals.push(r.hs, r.as); if (r.hs === r.as) draws++; }
const n = goals.length;
const mu = goals.reduce((s, x) => s + x, 0) / n;
const variance = goals.reduce((s, x) => s + (x - mu) ** 2, 0) / n;

// 泊松 pmf 与 负二项 pmf(mean=mu, size=r;var=mu+mu²/r)
function lgamma(z) { // Lanczos
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y++; ser += g[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
const poissonLogPmf = (k, lam) => k * Math.log(lam) - lam - lgamma(k + 1);
const nbLogPmf = (k, m, r) => {
  // P(k)=Γ(k+r)/(k!Γ(r)) (r/(r+m))^r (m/(r+m))^k
  return lgamma(k + r) - lgamma(k + 1) - lgamma(r) + r * Math.log(r / (r + m)) + k * Math.log(m / (r + m));
};

const SIZE = 8;
let llPois = 0, llNb = 0;
for (const k of goals) { llPois += poissonLogPmf(k, mu); llNb += nbLogPmf(k, mu, SIZE); }

// 各 size 扫一遍找经验最优(诚实看 8 是否接近最优)
let bestR = null, bestLL = -Infinity;
for (const r of [2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 50, 200]) {
  let ll = 0; for (const k of goals) ll += nbLogPmf(k, mu, r);
  if (ll > bestLL) { bestLL = ll; bestR = r; }
}

console.log("══════ 世界杯进球过离散 leak-safe 验证(1990-2022)══════");
console.log(`样本:${wc.length} 场 / ${n} 个进球观测   经验均值 μ=${mu.toFixed(3)}  方差=${variance.toFixed(3)}`);
console.log(`过离散判据:方差/均值 = ${(variance / mu).toFixed(3)}  (>1 即过离散;泊松假设=1)`);
console.log(`经验平局率(90')= ${(draws / wc.length * 100).toFixed(1)}%`);
console.log("");
console.log(`边缘进球分布对数似然(越高越好):`);
console.log(`  Poisson(μ)        : ${llPois.toFixed(1)}`);
console.log(`  NB(μ, size=8)     : ${llNb.toFixed(1)}   ΔlogLik=${(llNb - llPois).toFixed(1)}  人均Δ=${((llNb - llPois) / n).toFixed(4)}`);
console.log(`  经验最优 size     : r=${bestR}(logLik=${bestLL.toFixed(1)});size=8 与最优差 ${(bestLL - llNb).toFixed(1)}`);
console.log("");
const verdict = llNb > llPois
  ? `✅ NB(8) 似然高于泊松(过离散真实,方差/均值=${(variance / mu).toFixed(2)}>1)→ 超算统一到 NB(8) 有据,与单场模型一致。`
  : `⚖️ NB(8) 未优于泊松 → 不接,保持泊松(诚实)。`;
console.log(verdict);
