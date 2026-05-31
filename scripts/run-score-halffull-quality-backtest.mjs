// 比分 + 半全场 模型质量回测(过夜轮11)——在 football-data **真实 HT 比分**上量模型命中率。
// ───────────────────────────────────────────────────────────────────────────
// 价值:ledger 半全场结算盲区(actualHalfFull 空,轮6 发现)→ 改用 football-data(带 HTHG/HTAG)在
//   ground truth 上诚实量「比分 top-1 命中」「半全场命中」,并比 naive 基线,给逐联赛自知。
// 方法:leak-safe 月度重拟合 DC → topScores[0]=比分选 / argmax halfFullJoint(λ)=半全场选 vs 真实赛果。
// 诚实上限(记忆):比分 ~12-15% / 半全场 28-35%。打到区间=正常,别夸大。
// 跑法:node scripts/run-score-halffull-quality-backtest.mjs
import { loadFootballDataMatches, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullJoint, fitHalfFullParams } from "../src/halftime-fulltime-model.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && Number.isFinite(m.halfHome) && Number.isFinite(m.halfAway))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场(带 FT+HT 比分)`);

const wld = (h, a) => (h > a ? "主胜" : h === a ? "平局" : "客胜");
const hfOf = (m) => `${wld(m.halfHome, m.halfAway)}-${wld(m.homeGoals, m.awayGoals)}`;

const agg = { score: { n: 0, hit: 0 }, scoreTop3: { n: 0, hit: 0 }, hf: { n: 0, hit: 0 }, baseScore: { n: 0, hit: 0 }, baseHf: { n: 0, hit: 0 } };
const byLeague = {}; // lg → {scoreN,scoreHit,hfN,hfHit}

let curYm = null, fit = null, hfParams = null;
for (let i = 0; i < usable.length; i++) {
  const m = usable[i];
  const ym = String(m.date).slice(0, 7);
  if (ym !== curYm) {
    const prior = usable.slice(0, i);
    if (prior.length >= minTrain) {
      const train = prior.slice(-maxTrain);
      const f = fitFromMatches(train, { referenceDate: m.date });
      if (f?.usable) fit = f;
      hfParams = fitHalfFullParams(train); // leak-safe:只用训练集拟合 HT 切分比例
    }
    curYm = ym;
  }
  if (!fit) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.topScores?.length || !pred.expectedGoals) continue;
  const actualScore = `${m.homeGoals}-${m.awayGoals}`;
  const actualHf = hfOf(m);

  // 比分
  const top1 = pred.topScores[0].score;
  const top3 = pred.topScores.slice(0, 3).map((s) => s.score);
  agg.score.n++; if (top1 === actualScore) agg.score.hit++;
  agg.scoreTop3.n++; if (top3.includes(actualScore)) agg.scoreTop3.hit++;
  agg.baseScore.n++; if (actualScore === "1-1") agg.baseScore.hit++; // naive 最常见比分

  // 半全场
  const joint = halfFullJoint(pred.expectedGoals.home, pred.expectedGoals.away, hfParams ?? {});
  if (joint) {
    const hfPick = Object.entries(joint).sort((a, b) => b[1] - a[1])[0][0];
    agg.hf.n++; if (hfPick === actualHf) agg.hf.hit++;
    agg.baseHf.n++; if (actualHf === "主胜-主胜") agg.baseHf.hit++; // naive 最常见半全场
  }

  const lg = m.league;
  (byLeague[lg] ??= { scoreN: 0, scoreHit: 0, hfN: 0, hfHit: 0 });
  byLeague[lg].scoreN++; if (top1 === actualScore) byLeague[lg].scoreHit++;
  if (joint) { byLeague[lg].hfN++; const hp = Object.entries(joint).sort((a, b) => b[1] - a[1])[0][0]; if (hp === actualHf) byLeague[lg].hfHit++; }
}

const pct = (h, n) => (n ? `${(100 * h / n).toFixed(1)}%` : "—");
console.log("\n=== 模型 vs naive 基线(ground truth)===");
console.log(`比分 top-1: 模型 ${pct(agg.score.hit, agg.score.n)}(n=${agg.score.n}) vs naive 1-1 ${pct(agg.baseScore.hit, agg.baseScore.n)} | 诚实上限 ~12-15%`);
console.log(`比分 top-3: 模型 ${pct(agg.scoreTop3.hit, agg.scoreTop3.n)}`);
console.log(`半全场:    模型 ${pct(agg.hf.hit, agg.hf.n)}(n=${agg.hf.n}) vs naive 主胜-主胜 ${pct(agg.baseHf.hit, agg.baseHf.n)} | 诚实上限 28-35%`);

console.log("\n=== 逐联赛(样本≥300)===");
const rows = Object.entries(byLeague).filter(([, v]) => v.scoreN >= 300).sort((a, b) => b[1].scoreN - a[1].scoreN);
for (const [lg, v] of rows) {
  console.log(`  ${LEAGUE_LABELS[lg] ?? lg}: 比分 ${pct(v.scoreHit, v.scoreN)} · 半全场 ${pct(v.hfHit, v.hfN)} (n=${v.scoreN})`);
}
console.log("\n诚实判读:模型比分/半全场显著高于 naive + 落诚实上限区间 = 模型有真区分度;低于 naive = 退化需查。");
