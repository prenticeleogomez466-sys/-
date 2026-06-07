// 大样本验证(攻最大增益):317场live复盘揭示"中信心客胜argmax系统反向主胜"。
// 用 walkforward 五大联赛万级样本复现生产最终概率(blend+fusion+cal),验证是否大样本也成立。
// 若弱优势客胜(中信心代理:away_prob 中低档)实际系统性是主胜→坐实可动决策核心(非317薄样本)。
// leak-safe:每测试日只用更早比赛拟合DC+装配context(同 walkforward)。
import { fitFromMatches, predictFromFitted, blendWithOdds } from "../src/dixon-coles-engine.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { buildFusionContext } from "../src/fusion-context-builder.js";
import { fuseSignals } from "../src/signal-fusion-layer.js";
import { calibrateProbabilities } from "../src/model-calibration.js";

const OUT = ["home", "draw", "away"];
const actualOutcome = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const argmax = (p) => OUT.reduce((x, y) => (p[y] > p[x] ? y : x), "home");

const TEST_DATES = Number(process.argv[2] ?? 200);
console.log(`加载 football-data 五大联赛... (testDates=${TEST_DATES})`);
const loaded = await loadFootballDataMatches({});
if (!loaded.ok) { console.log("加载失败(网络?):", loaded.reason); process.exit(1); }
const matches = loaded.matches.map((m) => ({ ...m, homeCanon: canonicalTeamName(m.home), awayCanon: canonicalTeamName(m.away) }));
const dates = [...new Set(matches.map((m) => m.date))].sort();
const testDates = dates.slice(-TEST_DATES);

// 按模型客胜概率分档(中信心代理=弱优势客胜)
const bands = [[0, 0.38], [0.38, 0.43], [0.43, 0.48], [0.48, 0.55], [0.55, 1]];
const stat = bands.map(() => ({ n: 0, aHome: 0, aDraw: 0, aAway: 0, dbl: 0 }));
let scanned = 0;

for (const date of testDates) {
  const prior = matches.filter((m) => m.date < date);
  if (prior.length < 300) continue;
  const fit = fitFromMatches(prior.slice(-1500), { referenceDate: date });
  if (!fit?.usable) continue;
  for (const m of matches.filter((x) => x.date === date)) {
    if (!m.odds) continue;
    const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities) continue;
    const fixture = { id: `${date}-${m.homeCanon}-${m.awayCanon}`, homeTeam: m.home, awayTeam: m.away, competition: m.league, date };
    const blendProbs = blendWithOdds(m.odds, pred, { competition: m.league }).probabilities ?? m.odds;
    const ctx = buildFusionContext(fixture, prior);
    const fusion = fuseSignals(blendProbs, fixture, {}, ctx);
    const P = calibrateProbabilities(fusion.probabilities, undefined, { fixture, hasMarketPrior: true }).probabilities ?? fusion.probabilities;
    if (argmax(P) !== "away") continue;          // 只看模型主推客胜
    scanned++;
    const bi = bands.findIndex(([lo, hi]) => P.away >= lo && P.away < hi);
    if (bi < 0) continue;
    const actual = actualOutcome(m.homeGoals, m.awayGoals);
    const s = stat[bi]; s.n++;
    if (actual === "home") s.aHome++; else if (actual === "draw") s.aDraw++; else s.aAway++;
    const second = OUT.filter((o) => o !== "away").reduce((x, y) => (P[y] > P[x] ? y : x));
    if (actual === "away" || actual === second) s.dbl++;     // 双选(客+次高)命中
  }
}

console.log(`\n五大联赛大样本·模型主推客胜 ${scanned} 场,按模型客胜概率分档(弱优势=中信心代理):`);
console.log(`away_prob档     n    实际客胜(=argmax命中)  实际主胜(反向)  实际平   双选(客+次)命中`);
bands.forEach(([lo, hi], i) => {
  const s = stat[i]; if (!s.n) { console.log(`  ${lo}-${hi}  n=0`); return; }
  const pc = (x) => `${(100 * x / s.n).toFixed(1)}%`;
  console.log(`  ${lo}-${hi}`.padEnd(14) + String(s.n).padStart(4) + `   ${pc(s.aAway)}`.padStart(10) + `         ${pc(s.aHome)}`.padStart(9) + `   ${pc(s.aDraw)}`.padStart(7) + `   ${pc(s.dbl)}`.padStart(9));
});
console.log(`\n判读: 若低档(<0.43~0.48)实际客胜率 < 实际主胜率(反向)且各档单调,与317live一致 → 大样本坐实"中信心客胜argmax系统错",可动决策核心做回拉/双选;`);
console.log(`      若低档实际客胜率≈argmax概率(校准良好、无反向) → live偏差是薄样本/域错配,守铁律不动核心(同 reference_recap_rootcause)。`);
