/**
 * 收缩锚:Elo 先验 vs 中性1.0 · 留出回测(2026-05-31 学习轮 18,clubelo 第三步收尾)
 * ─────────────────────────────────────────────────────────────
 * 决定是否真改善:fit 收缩(轮8,K=2)向 1.0 vs 向 ClubElo 先验,样本外 Brier/LogLoss/命中,
 * 尤其赛季初(小样本处 Elo 锚应最有用)。优才接生产,否则诚实记录保留为可选。
 * 用法:node scripts/run-elo-shrink-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { fetchClubEloSnapshot, buildEloPriors } from "../src/clubelo-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12, TEST_FROM = "2025-01-01";
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const monthKey = (d) => d.slice(0, 7);
const isEarly = (d) => ["08", "09"].includes(d.slice(5, 7));

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.date);
const test = all.filter((m) => m.date >= TEST_FROM);
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();
console.log(`big-5 ${all.length} 场;测试期 ${test.length} 场 / ${months.length} 月块\n`);

// 预取各月块 Elo 快照(月初1号,clubelo-loader 有缓存)
const snapByMonth = new Map();
for (const mk of months) { const s = await fetchClubEloSnapshot(`${mk}-01`); if (s.ok) snapByMonth.set(mk, s.byClub); }

const SCALE = Number(process.env.ELO_SCALE ?? 0.0009);
function run(useElo) {
  let b = 0, l = 0, n = 0, hit = 0, eb = 0, el = 0, en = 0, matchedTeams = 0, totalTeams = 0;
  for (const mk of months) {
    const mm = test.filter((m) => monthKey(m.date) === mk);
    const monthStart = mm[0].date;
    const history = all.filter((m) => m.date < monthStart);
    if (history.length < 200) continue;
    let eloPriors = null;
    if (useElo && snapByMonth.has(mk)) {
      const teamNames = new Set();
      for (const m of history) { teamNames.add(m.home); teamNames.add(m.away); }
      const teamList = [...teamNames].map((raw) => ({ fitKey: canonicalTeamName(raw), rawName: raw }));
      const built = buildEloPriors(snapByMonth.get(mk), teamList, { scale: SCALE });
      eloPriors = built.priors; matchedTeams += built.matched; totalTeams += built.total;
    }
    const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: monthStart, shrinkageK: 2, eloPriors });
    if (!fitted?.usable) continue;
    for (const m of mm) {
      const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away })?.probabilities;
      if (!p || !Number.isFinite(p.home)) continue;
      const y = outcome(m);
      const bb = (p.home - (y === "home")) ** 2 + (p.draw - (y === "draw")) ** 2 + (p.away - (y === "away")) ** 2;
      const ll = -Math.log(Math.max(EPS, p[y]));
      b += bb; l += ll; n++;
      const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
      if (pick === y) hit++;
      if (isEarly(m.date)) { eb += bb; el += ll; en++; }
    }
  }
  return { b: b / n, l: l / n, acc: hit / n, n, eb: en ? eb / en : null, el: en ? el / en : null, en, cov: totalTeams ? matchedTeams / totalTeams : null };
}

const neutral = run(false);
const elo = run(true);
console.log(`Elo 队名覆盖率: ${elo.cov != null ? (elo.cov * 100).toFixed(1) + "%" : "—"}\n`);
console.log("收缩锚    | 全样本Brier | LogLoss | 命中率 | 赛季初Brier | 赛季初LogLoss(场)");
console.log(`  向1.0(轮8) | ${neutral.b.toFixed(4)}    | ${neutral.l.toFixed(4)} | ${(neutral.acc * 100).toFixed(1)}% | ${neutral.eb?.toFixed(4) ?? "—"}     | ${neutral.el?.toFixed(4) ?? "—"} (${neutral.en})`);
console.log(`  向Elo先验  | ${elo.b.toFixed(4)}    | ${elo.l.toFixed(4)} | ${(elo.acc * 100).toFixed(1)}% | ${elo.eb?.toFixed(4) ?? "—"}     | ${elo.el?.toFixed(4) ?? "—"} (${elo.en})`);
const dAll = ((neutral.l - elo.l) / neutral.l) * 100;
const dEarly = neutral.el && elo.el ? ((neutral.el - elo.el) / neutral.el) * 100 : 0;
console.log(`\n全样本 LogLoss 变化 ${dAll >= 0 ? "+" : ""}${dAll.toFixed(2)}%、赛季初 ${dEarly >= 0 ? "+" : ""}${dEarly.toFixed(2)}%(正=Elo锚更优)`);
const better = elo.b <= neutral.b + 1e-5 && elo.acc >= neutral.acc - 0.003 && (dEarly > 0.3 || dAll > 0.1);
console.log(better
  ? `→ Elo 收缩锚更优(尤其赛季初)且不劣化 → 建议接生产默认(fitFromFixtureStore 运行时抓快照建priors,scale=${SCALE})。`
  : `→ Elo 锚未显著优于向1.0(或有劣化)→ 诚实记录:收缩向1.0已够,Elo锚保留为可选(opts.eloPriors),不接默认。`);
