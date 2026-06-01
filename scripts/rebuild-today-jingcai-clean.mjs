/**
 * 干净重建今日竞彩(2026-06-01)——清掉多源合并的旧污染,只留 Playwright 实测的真实 6 场。
 * 数据 = 2026-06-01 夜 trade.500.com 竞彩 SPF/NSPF XML(浏览器实抓,updatetime 当晚)。
 * 覆盖式 saveFixtures + saveMarketSnapshots(去掉旧 shengfucai 残留 + 冲突快照),再出推荐。
 */
import { saveFixtures } from "../src/fixture-store.js";
import { saveMarketSnapshots } from "../src/market-data-store.js";
import { recommendFixtures } from "../src/prediction-engine.js";

const DATE = "2026-06-01";
const nowIso = new Date().toISOString();
// matchnum, home, away, 开盘 spf, 收盘 spf, 让球 nspf(收盘)
const M = [
  ["1001", "保加利亚", "黑山", [1.47, 3.75, 5.5], [1.36, 4.00, 6.95], [2.74, 2.65, 2.58]],
  ["1002", "挪威", "瑞典", [3.12, 3.45, 1.93], [3.15, 3.18, 2.01], [1.60, 3.43, 4.70]],
  ["1003", "土耳其", "北马其顿", [2.86, 3.85, 1.93], [2.72, 3.50, 2.10], [1.15, 5.60, 12.50]],
  ["1004", "奥地利", "突尼斯", [2.17, 3.30, 2.75], [2.24, 3.10, 2.78], [1.31, 4.35, 7.32]],
  ["1005", "哥伦比亚", "哥斯达黎加", [1.97, 3.80, 2.80], [1.97, 3.98, 2.70], null],
  ["1006", "加拿大", "乌兹别克斯坦", [2.67, 3.20, 2.27], [2.88, 3.07, 2.19], [1.50, 3.58, 5.45]],
];
const odds = (a) => ({ home: a[0], draw: a[1], away: a[2] });

const fixtures = M.map(([num, h, a]) => ({
  id: `jc-${DATE}-${num}-${h}-${a}`, sequence: num, date: DATE,
  homeTeam: h, awayTeam: a, competition: "国际赛", marketType: "jingcai",
  kickoff: `2026-06-02T02:45:00+08:00`,
}));
const snapshots = M.map(([num, h, a, open, close, nspf]) => ({
  id: `jc-${DATE}-${num}`, date: DATE, fixtureId: `jc-${DATE}-${num}-${h}-${a}`,
  sequence: num, marketType: "jingcai", competition: "国际赛", homeTeam: h, awayTeam: a,
  collectedAt: nowIso, source: "trade.500.com/jczq XML (Playwright 2026-06-01)",
  europeanOdds: { initial: odds(open), current: odds(close), final: odds(close) },
  handicapOdds: nspf ? { initial: odds(nspf), current: odds(nspf), final: odds(nspf) } : null,
}));

saveFixtures(DATE, fixtures, { source: "trade.500.com-jczq-clean (Playwright)" });
saveMarketSnapshots(DATE, snapshots, { source: "trade.500.com-jczq-clean (Playwright)" });
console.log(`干净重建:${fixtures.length} 场 fixtures + ${snapshots.length} 快照(覆盖旧污染)`);

const r = recommendFixtures(DATE);
console.log(`\n进推荐 ${r.predictions.length} 场 | unpredictable ${r.unpredictable?.length ?? 0} | 14场available=${r.fourteen?.available}`);
const dv = (o) => { const i = 1 / o.home + 1 / o.draw + 1 / o.away; return `主${(100 / o.home / i).toFixed(0)}/平${(100 / o.draw / i).toFixed(0)}/客${(100 / o.away / i).toFixed(0)}`; };
for (const p of r.predictions) {
  const f = p.fixture, pr = p.probabilities, sc = p.scorePicks, hf = p.halfFullPicks;
  const m = M.find((x) => x[1] === f.homeTeam);
  console.log(`\n【${f.homeTeam} vs ${f.awayTeam}】收盘赔率 ${m[4].join("/")} (市场${dv(odds(m[4]))})`);
  console.log(`  模型胜平负: ${p.pick?.label}  主${(pr.home * 100).toFixed(0)}/平${(pr.draw * 100).toFixed(0)}/客${(pr.away * 100).toFixed(0)}  [${p.provenance}]`);
  console.log(`  比分: ${sc?.primary}(${sc?.primaryProbability ? (sc.primaryProbability * 100).toFixed(1) + "%" : "-"}) 备${sc?.secondary} | 半全场: ${hf?.primary}(${hf?.primaryProbability ? (hf.primaryProbability * 100).toFixed(1) + "%" : "-"})`);
}
