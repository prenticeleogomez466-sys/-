/**
 * xG-DC vs 市场 关键验证(通宵 cycle9)——xG 能否在市场之外加增量?
 * Understat EPL 4季 xG-DC(walk-forward)join 到 store football-data 英超带收盘赔率的场,
 * 比 市场收盘 / xG-DC / 融合(0.5) 的 1X2 RPS+命中 + 比分LL。
 * 公开 xG 大概率已被市场定价 → 预期 blend≈市场;诚实记。用法:node scripts/backtest-xg-vs-market.mjs
 */
import { readFileSync } from "node:fs";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { canonicalTeamName } from "../src/team-aliases.js";

const G = 8, EPS = 1e-12, RHO = -0.08, HA = 1.2;
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const poi = (k, l) => (l > 0 ? Math.exp(k * Math.log(l) - l - lg(k)) : (k === 0 ? 1 : 0));
const tau = (h, a, l, m) => h === 0 && a === 0 ? 1 - l * m * RHO : h === 0 && a === 1 ? 1 + l * RHO : h === 1 && a === 0 ? 1 + m * RHO : h === 1 && a === 1 ? 1 - RHO : 1;
function pr(lh, la) { const M = []; let t = 0, h = 0, d = 0, a = 0; for (let i = 0; i <= G; i++){M[i]=[];for (let j = 0; j <= G; j++){const p=poi(i,lh)*poi(j,la)*tau(i,j,lh,la);M[i][j]=p;t+=p;if(i>j)h+=p;else if(i===j)d+=p;else a+=p;}} return {one:{home:h/t,draw:d/t,away:a/t},M,t}; }
const rps = (p, y) => { const c1 = p.home - (y === "home" ? 1 : 0); const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0); return 0.5 * (c1 * c1 + c2 * c2); };
const top = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
const cano = (t) => canonicalTeamName(t) || t;

// store 英超带收盘赔率 → 索引 date|canoH|canoA
const store = new Map();
for (const m of collectHistoricalMatches(4000)) {
  if (m.league !== "英超" || !m.marketHistorical?.closeProbs) continue;
  store.set(`${m.date}|${norm(cano(m.home))}|${norm(cano(m.away))}`, m.marketHistorical.closeProbs);
}
console.log(`store 英超带收盘赔率 ${store.size} 场`);

const seasons = ["EPL-2022", "EPL-2023", "EPL-2024", "EPL-2025-26"].map((f) =>
  readFileSync("D:/football-model-data/understat/" + f + ".tsv", "utf8").trim().split("\n").map((l) => { const [date, h, a, gh, ga, xgh, xga] = l.split("\t"); return { date, h, a, gh: +gh, ga: +ga, xgh: +xgh, xga: +xga }; }));

const arms = { market: { sr: 0, hit: 0, sll: 0 }, xg: { sr: 0, hit: 0, sll: 0 }, blend: { sr: 0, hit: 0, sll: 0 } };
let n = 0, joined = 0;
for (const rows of seasons) {
  rows.sort((x, y) => x.date.localeCompare(y.date));
  const F = {}, A = {}, N = {}; let sumFor = 0, games = 0;
  for (const m of rows) {
    const lgAvg = games > 0 ? sumFor / games : 1.4;
    if ((N[m.h] ?? 0) >= 4 && (N[m.a] ?? 0) >= 4) {
      const key = `${m.date}|${norm(cano(m.h))}|${norm(cano(m.a))}`;
      const mkt = store.get(key);
      if (mkt) {
        joined++;
        const lh = lgAvg * ((F[m.h] / N[m.h]) / lgAvg) * ((A[m.a] / N[m.a]) / lgAvg) * HA;
        const la = lgAvg * ((F[m.a] / N[m.a]) / lgAvg) * ((A[m.h] / N[m.h]) / lgAvg) / HA;
        const xgP = pr(lh, la); const y = m.gh > m.ga ? "home" : m.gh === m.ga ? "draw" : "away";
        const bl = { home: 0.5 * mkt.home + 0.5 * xgP.one.home, draw: 0.5 * mkt.draw + 0.5 * xgP.one.draw, away: 0.5 * mkt.away + 0.5 * xgP.one.away };
        const blS = bl.home + bl.draw + bl.away; bl.home /= blS; bl.draw /= blS; bl.away /= blS;
        for (const [k, p] of [["market", mkt], ["xg", xgP.one], ["blend", bl]]) { arms[k].sr += rps(p, y); if (top(p) === y) arms[k].hit++; }
        // 比分 LL 仅 xg 有矩阵(市场无比分分布)
        arms.xg.sll += -Math.log(Math.max(xgP.M[Math.min(m.gh, G)][Math.min(m.ga, G)] / xgP.t, EPS));
        n++;
      }
    }
    F[m.h] = (F[m.h] ?? 0) + m.xgh; A[m.h] = (A[m.h] ?? 0) + m.xga; N[m.h] = (N[m.h] ?? 0) + 1;
    F[m.a] = (F[m.a] ?? 0) + m.xga; A[m.a] = (A[m.a] ?? 0) + m.xgh; N[m.a] = (N[m.a] ?? 0) + 1;
    sumFor += m.gh + m.ga; games += 2;
  }
}
console.log(`join 成功 ${n} 场(Understat∩store英超收盘赔率)\n`);
console.log("臂          1X2命中   1X2_RPS");
for (const k of ["market", "xg", "blend"]) console.log(`${k.padEnd(10)} ${(arms[k].hit / n * 100).toFixed(1)}%   ${(arms[k].sr / n).toFixed(4)}`);
const mR = arms.market.sr / n, bR = arms.blend.sr / n;
console.log(`\n融合 vs 市场:RPS Δ${(mR - bR).toFixed(4)} ${bR < mR - 0.001 ? "✓ xG 在市场之外加了增量(罕见!值得融进生产)" : "✗ 未超市场(公开xG已被定价,预期内)→ xG价值在比分/半全场质量+无盘口路,非市场1X2"}`);
