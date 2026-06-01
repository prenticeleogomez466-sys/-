/**
 * xG-DC vs 进球-DC 多季回测(通宵 cycle8,Understat 4 季 EPL=1520 场)。
 * 每季内 walk-forward(评级只用本季此前比赛,leak-safe),对比用 xG vs 实际进球 建队攻防评级
 *   预测真实赛果:1X2 命中/RPS + 比分 logloss(τ修正) + 大小球2.5 Brier。
 * 4 季池化 → ~1400 测试场,比单季稳健。用法:node scripts/backtest-xg-dc-multiseason.mjs
 */
import { readFileSync } from "node:fs";
const G = 8, EPS = 1e-12, RHO = -0.08;
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const poi = (k, l) => (l > 0 ? Math.exp(k * Math.log(l) - l - lg(k)) : (k === 0 ? 1 : 0));
const tau = (h, a, l, m) => h === 0 && a === 0 ? 1 - l * m * RHO : h === 0 && a === 1 ? 1 + l * RHO : h === 1 && a === 0 ? 1 + m * RHO : h === 1 && a === 1 ? 1 - RHO : 1;
function probs(lh, la) { let h = 0, d = 0, a = 0, sLL = null; const M = []; let t = 0; for (let i = 0; i <= G; i++){M[i]=[];for (let j = 0; j <= G; j++){const p=poi(i,lh)*poi(j,la)*tau(i,j,lh,la);M[i][j]=p;t+=p;if(i>j)h+=p;else if(i===j)d+=p;else a+=p;}} const ts=h+d+a; return {one:{home:h/ts,draw:d/ts,away:a/ts},M,t}; }
const rps = (p, y) => { const c1 = p.home - (y === "home" ? 1 : 0); const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0); return 0.5 * (c1 * c1 + c2 * c2); };
const top = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");

const seasons = ["EPL-2022", "EPL-2023", "EPL-2024", "EPL-2025-26"].map((f) =>
  readFileSync("D:/football-model-data/understat/" + f + ".tsv", "utf8").trim().split("\n").map((l) => { const [date, h, a, gh, ga, xgh, xga] = l.split("\t"); return { date, h, a, gh: +gh, ga: +ga, xgh: +xgh, xga: +xga }; }));

function run(useXg) {
  let hit = 0, sr = 0, sll = 0, br = 0, n = 0;
  const HA = 1.2;
  for (const rows of seasons) {
    rows.sort((x, y) => x.date.localeCompare(y.date));
    const F = {}, A = {}, N = {}; let sumFor = 0, games = 0;
    for (const m of rows) {
      const lgAvg = games > 0 ? sumFor / games : 1.4;
      if ((N[m.h] ?? 0) >= 4 && (N[m.a] ?? 0) >= 4 && lgAvg > 0) {
        const lh = lgAvg * ((F[m.h] / N[m.h]) / lgAvg) * ((A[m.a] / N[m.a]) / lgAvg) * HA;
        const la = lgAvg * ((F[m.a] / N[m.a]) / lgAvg) * ((A[m.h] / N[m.h]) / lgAvg) / HA;
        const pr = probs(lh, la), y = m.gh > m.ga ? "home" : m.gh === m.ga ? "draw" : "away";
        if (top(pr.one) === y) hit++; sr += rps(pr.one, y);
        sll += -Math.log(Math.max(pr.M[Math.min(m.gh, G)][Math.min(m.ga, G)] / pr.t, EPS));
        // P(over2.5)
        let pu = 0; for (let i = 0; i <= G; i++)for (let j = 0; j <= G; j++) if (i + j <= 2) pu += pr.M[i][j] / pr.t;
        const yO = (m.gh + m.ga) > 2.5 ? 1 : 0; br += ((1 - pu) - yO) ** 2;
        n++;
      }
      const fh = useXg ? m.xgh : m.gh, fa = useXg ? m.xga : m.ga;
      F[m.h] = (F[m.h] ?? 0) + fh; A[m.h] = (A[m.h] ?? 0) + fa; N[m.h] = (N[m.h] ?? 0) + 1;
      F[m.a] = (F[m.a] ?? 0) + fa; A[m.a] = (A[m.a] ?? 0) + fh; N[m.a] = (N[m.a] ?? 0) + 1;
      sumFor += m.gh + m.ga; games += 2;
    }
  }
  return { hit: hit / n, rps: sr / n, sll: sll / n, br: br / n, n };
}
const goals = run(false), xg = run(true);
console.log(`4 季 EPL 池化 walk-forward(${goals.n} 测试场)`);
console.log(`\n评级源    1X2命中   1X2_RPS   比分LL    大小球Brier`);
console.log(`实际进球  ${(goals.hit * 100).toFixed(1)}%   ${goals.rps.toFixed(4)}   ${goals.sll.toFixed(4)}   ${goals.br.toFixed(4)}`);
console.log(`xG        ${(xg.hit * 100).toFixed(1)}%   ${xg.rps.toFixed(4)}   ${xg.sll.toFixed(4)}   ${xg.br.toFixed(4)}`);
console.log(`\nΔ(xG−进球): 命中 ${((xg.hit - goals.hit) * 100).toFixed(1)}pp | RPS ${(goals.rps - xg.rps).toFixed(4)} | 比分LL ${(goals.sll - xg.sll).toFixed(4)} | 大小球Brier ${(goals.br - xg.br).toFixed(4)}`);
const win = (goals.rps - xg.rps > 0.002) + (goals.sll - xg.sll > 0.005) + (goals.br - xg.br > 0.002);
console.log(win >= 2 ? "→ xG-DC 多季稳健胜出(≥2项显著)→ 强力支持建 xG-DC 接生产(EPL等Understat联赛)" : win >= 1 ? "→ xG 部分指标胜出,方向正但增益有限" : "→ 多季未稳健胜出,诚实记录");
