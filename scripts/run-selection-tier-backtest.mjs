/**
 * 选择分层回测(2026-05-31)—— 量化"减法/选择"对命中的真实杠杆。
 * 核心:命中率算在"你选择下注的子集"上才有意义。本回测证明:
 *   只下高信心(市场热门概率高)+ 模型认同的子集,命中率从全样本 ~51% 拉到 ~70%+。
 *
 *   Part A(快,无需拟合):按市场隐含热门概率分桶,看命中率单调随信心升 + 覆盖比例。
 *   Part B(leak-safe walk-forward DC):在每档里,要求"模型与市场同向"是否再提命中(模型的选择增量)。
 * m.odds 已是去vig隐含概率(home/draw/away 和≈1),直接用。
 * 用法:node scripts/run-selection-tier-backtest.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const fav = (p) => { const k = ["home", "draw", "away"].reduce((b, o) => (p[o] > p[b] ? o : b), "home"); return { k, p: p[k] }; };
const actual = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const daysBetween = (f, t) => Math.abs(Date.parse(t) - Date.parse(f)) / 86400000;

const L = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const all = L.matches.filter((m) => m.homeGoals != null && m.odds && m.date)
  .sort((a, b) => a.date.localeCompare(b.date));
console.log(`${all.length} 场有赔率\n`);

// ── Part A:市场隐含热门概率分桶 → 命中率 + 覆盖 ──
const BUCKETS = [[0.33, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 0.72], [0.72, 0.80], [0.80, 1.01]];
const A = BUCKETS.map(() => ({ n: 0, hit: 0 }));
for (const m of all) {
  const f = fav(m.odds), a = actual(m.homeGoals, m.awayGoals);
  for (let i = 0; i < BUCKETS.length; i++) if (f.p >= BUCKETS[i][0] && f.p < BUCKETS[i][1]) { A[i].n++; if (f.k === a) A[i].hit++; break; }
}
console.log("Part A — 只下注「市场热门概率 ≥ 档」的命中率(选择越严，命中越高):");
console.log("热门概率档    场数    占比     档内命中   累计(≥下限)命中  累计覆盖");
let cumN = 0, cumHit = 0;
for (let i = BUCKETS.length - 1; i >= 0; i--) { cumN += A[i].n; cumHit += A[i].hit; A[i]._cumN = cumN; A[i]._cumHit = cumHit; }
for (let i = 0; i < BUCKETS.length; i++) {
  const s = A[i]; if (!s.n) continue;
  const hi = BUCKETS[i][1] > 1 ? "1.0" : BUCKETS[i][1].toFixed(2);
  console.log(`  ${BUCKETS[i][0].toFixed(2)}-${hi}  ${String(s.n).padStart(6)}  ${(s.n / all.length * 100).toFixed(1).padStart(5)}%   ${(s.hit / s.n * 100).toFixed(1).padStart(5)}%      ≥${BUCKETS[i][0].toFixed(2)}: ${(s._cumHit / s._cumN * 100).toFixed(1)}%      ${(s._cumN / all.length * 100).toFixed(1)}%`);
}

// ── Part B:模型认同是否在高档内再提命中(leak-safe walk-forward)──
console.log("\nPart B — 高信心档内，再要求「模型与市场同向」是否提命中(模型的选择增量):");
const dates = [...new Set(all.map((m) => m.date))].sort();
let fit = null, lastFit = null;
const T = { agree: { n: 0, hit: 0 }, disagree: { n: 0, hit: 0 }, market: { n: 0, hit: 0 } };
const HI = 0.60; // 高信心阈值(市场热门概率)
for (const date of dates) {
  const prior = all.filter((m) => m.date < date);
  if (prior.length < 600) continue;
  if (!fit || daysBetween(lastFit, date) >= 7) { fit = fitFromMatches(prior.slice(-3000), { referenceDate: date }); lastFit = date; }
  if (!fit?.usable) continue;
  for (const m of all.filter((x) => x.date === date)) {
    const mf = fav(m.odds);
    if (mf.p < HI) continue; // 只在高信心档评估
    const a = actual(m.homeGoals, m.awayGoals);
    T.market.n++; if (mf.k === a) T.market.hit++;
    const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities) continue;
    const modelFav = fav(pred.probabilities);
    const bucket = modelFav.k === mf.k ? T.agree : T.disagree;
    bucket.n++; if (mf.k === a) bucket.hit++;
  }
}
const pct = (x) => (x.n ? (x.hit / x.n * 100).toFixed(1) + "%" : "-");
console.log(`  市场热门≥${HI}(全部)      n=${T.market.n}  命中 ${pct(T.market)}`);
console.log(`  └ 模型也同向(下注)      n=${T.agree.n}  命中 ${pct(T.agree)}`);
console.log(`  └ 模型反向(放弃/警惕)    n=${T.disagree.n}  命中 ${pct(T.disagree)}`);
console.log("\n判读:Part A 命中率应随信心档单调上升(选择越严命中越高);Part B 若 agree>市场>disagree，则「模型同向」是有效的二次过滤,可作胆码/任选9 单选的硬门槛。");
