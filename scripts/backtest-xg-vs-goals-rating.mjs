/**
 * xG 评级 vs 进球评级 预测力对比(通宵 cycle7,Understat 真实 xG)。
 * 经典 xG 价值检验:用历史 xG 建队攻防评级 是否比用 实际进球 更能预测未来真实赛果(噪声更小)。
 * EPL 2025/26 全季 380 场,date 升序 walk-forward(每场只用此前比赛建评级,leak-safe)。
 * 对比 1X2 命中/RPS + 比分 logloss。用法:node scripts/backtest-xg-vs-goals-rating.mjs
 */
import { readFileSync } from "node:fs";
const G = 8, EPS = 1e-12;
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const poi = (k, l) => (l > 0 ? Math.exp(k * Math.log(l) - l - lg(k)) : (k === 0 ? 1 : 0));
function probs1x2(lh, la) { let h = 0, d = 0, a = 0; for (let i = 0; i <= G; i++)for (let j = 0; j <= G; j++) { const p = poi(i, lh) * poi(j, la); if (i > j) h += p; else if (i === j) d += p; else a += p; } const t = h + d + a; return { home: h / t, draw: d / t, away: a / t }; }
const rps = (p, y) => { const c1 = p.home - (y === "home" ? 1 : 0); const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0); return 0.5 * (c1 * c1 + c2 * c2); };
const top = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const scoreLL = (lh, la, gh, ga) => -Math.log(Math.max(poi(Math.min(gh, G), lh) * poi(Math.min(ga, G), la), EPS));

const rows = readFileSync("D:/football-model-data/understat/EPL-2025-26.tsv", "utf8").trim().split("\n").map((l) => { const [date, h, a, gh, ga, xgh, xga] = l.split("\t"); return { date, h, a, gh: +gh, ga: +ga, xgh: +xgh, xga: +xga }; });
rows.sort((x, y) => x.date.localeCompare(y.date));
console.log(`EPL 2025/26 ${rows.length} 场`);

// 增量评级:用 metric(goals 或 xg)。每队 累计 for/against(主客分开会样本不足,这里合并 + 小 homeAdv)。
function run(useXg) {
  const F = {}, A = {}, N = {}; let sumFor = 0, games = 0; // 全联盟均值
  let hit = 0, sr = 0, sll = 0, n = 0;
  const HOMEADV = 1.25;
  for (const m of rows) {
    const haveH = (N[m.h] ?? 0) >= 3, haveA = (N[m.a] ?? 0) >= 3, lgAvg = games > 0 ? sumFor / games : 1.35;
    if (haveH && haveA && lgAvg > 0) {
      const attH = (F[m.h] / N[m.h]) / lgAvg, defH = (A[m.h] / N[m.h]) / lgAvg;
      const attA = (F[m.a] / N[m.a]) / lgAvg, defA = (A[m.a] / N[m.a]) / lgAvg;
      const lh = lgAvg * attH * defA * HOMEADV, la = lgAvg * attA * defH / HOMEADV;
      const p = probs1x2(lh, la); const y = m.gh > m.ga ? "home" : m.gh === m.ga ? "draw" : "away";
      if (top(p) === y) hit++; sr += rps(p, y); sll += scoreLL(lh, la, m.gh, m.ga); n++;
    }
    // 用真实赛果或 xG 更新评级
    const fh = useXg ? m.xgh : m.gh, fa = useXg ? m.xga : m.ga;
    F[m.h] = (F[m.h] ?? 0) + fh; A[m.h] = (A[m.h] ?? 0) + fa; N[m.h] = (N[m.h] ?? 0) + 1;
    F[m.a] = (F[m.a] ?? 0) + fa; A[m.a] = (A[m.a] ?? 0) + fh; N[m.a] = (N[m.a] ?? 0) + 1;
    sumFor += m.gh + m.ga; games += 2;
  }
  return { hit: hit / n, rps: sr / n, sll: sll / n, n };
}
const goals = run(false), xg = run(true);
console.log(`\n评级源    样本   1X2命中   1X2_RPS   比分LL`);
console.log(`实际进球  ${goals.n}   ${(goals.hit * 100).toFixed(1)}%   ${goals.rps.toFixed(4)}   ${goals.sll.toFixed(4)}`);
console.log(`xG        ${xg.n}   ${(xg.hit * 100).toFixed(1)}%   ${xg.rps.toFixed(4)}   ${xg.sll.toFixed(4)}`);
console.log(`\nΔ(xG−进球): 命中 ${((xg.hit - goals.hit) * 100).toFixed(1)}pp / RPS ${(goals.rps - xg.rps).toFixed(4)} / 比分LL ${(goals.sll - xg.sll).toFixed(4)}`);
console.log((goals.rps - xg.rps) > 0.003 || (goals.sll - xg.sll) > 0.01 ? "→ xG 评级显著更能预测真实赛果(噪声更小)→ 值得全量抓 Understat xG 建 xG-DC" : "→ 单季样本小,xG 未显著胜出(需多季确认);但方向/可行性已验证");
