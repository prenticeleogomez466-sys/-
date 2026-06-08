// 把已开售的世界杯单场(墨西哥vs南非/韩国vs捷克)追加为今日竞彩(jingcai),带500真实赔率+真实让球线。
// 合并不覆盖:保留当日全部既有 fixtures/snapshots,只 append。守真钱管线。
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";
import { loadMarketSnapshots, saveMarketSnapshots } from "../src/market-data-store.js";
import { buildDailyRecommendationPackage, simpleWldCell, simpleHandicapCell, simpleHalfFullCell } from "../src/daily-report.js";

const DATE = process.argv[2] || "2026-06-08";
const now = new Date().toISOString();
const od = (h, d, a) => ({ home: h, draw: d, away: a });

// [num,主,客,kickoff,胜平负(nspf主/平/客),让球(spf主/平/客),让球线]
const WC = [
  ["4001", "墨西哥", "南非", "2026-06-12 03:00", [1.34, 3.92, 7.85], [2.20, 3.28, 2.70], -1],
  ["4002", "韩国", "捷克", "2026-06-12 10:00", [2.43, 2.84, 2.74], [5.80, 4.05, 1.41], -1],
];

const existingF = loadFixtures(DATE).fixtures ?? [];
const existingS = loadMarketSnapshots(DATE).snapshots ?? [];
console.log(`既有 fixtures=${existingF.length}, snapshots=${existingS.length}`);

const newFixtures = WC.map(([n, h, a, kick]) => ({
  id: `jc-wc-${DATE}-${n}-${h}-${a}`, date: DATE, sequence: n, kickoff: kick,
  competition: "世界杯", homeTeam: h, awayTeam: a, marketType: "jingcai",
  tags: ["竞彩足球", "世界杯单场", "500.com-jczq"], source: "trade.500.com/jczq (Playwright 实时核, 让球线 DOM)",
  officialStatus: "scraped", notes: `世界杯单场竞彩;500让球线=主队${WC.find(w=>w[1]===h)[6]}`,
}));
const newSnaps = WC.map(([n, h, a, kick, spf, rang, line]) => ({
  id: `jc-wc-${DATE}-${n}`, date: DATE, fixtureId: `jc-wc-${DATE}-${n}-${h}-${a}`, sequence: n,
  marketType: "jingcai", competition: "世界杯", homeTeam: h, awayTeam: a, collectedAt: now,
  source: "trade.500.com/jczq XML+DOM (Playwright 实时, 胜平负/让球/让球线已核)",
  europeanOdds: { initial: od(...spf), current: od(...spf), final: od(...spf) },
  handicapOdds: { initial: od(...rang), current: od(...rang), final: od(...rang) },
  jingcaiHandicap: { line, source: "500.com-jczq-DOM" },
  // verified:该让球线已 Playwright 实时核对 trade.500.com/jczq DOM,授权 cron 重 ingest 后冻结保留
  //   (wc-handicap-line-persist-fix2,2026-06-08)。这是全仓库唯一允许写 verified:true 的位置(人工核实路径)。
  verified: true,
}));

// 去重:若已存在同 id 的 jingcai-wc 条目(重跑),先剔除
const fClean = existingF.filter((f) => !String(f.id).startsWith(`jc-wc-${DATE}`));
const sClean = existingS.filter((s) => !String(s.id).startsWith(`jc-wc-${DATE}`));
saveFixtures(DATE, [...fClean, ...newFixtures], { source: "merge-wc-singles" });
saveMarketSnapshots(DATE, [...sClean, ...newSnaps], { source: "merge-wc-singles" });
console.log(`合并后 fixtures=${fClean.length + newFixtures.length}, snapshots=${sClean.length + newSnaps.length}`);

// 重算并验证
const pkg = buildDailyRecommendationPackage(DATE, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const jc = preds.filter((p) => p.fixture?.marketType === "jingcai");
console.log(`\n=== 竞彩(jingcai)交付场数=${jc.length} (期望5) ===`);
for (const p of jc) {
  console.log(`【${p.fixture.homeTeam} vs ${p.fixture.awayTeam}/${p.fixture.competition}】`);
  console.log(`   胜负平:${simpleWldCell(p)}`);
  console.log(`   让球:${simpleHandicapCell(p)}`);
  console.log(`   半全场:${simpleHalfFullCell(p)}`);
}
// 验证14场(shengfucai)韩国/墨西哥是否被污染
const sf = preds.filter((p) => p.fixture?.marketType === "shengfucai" && /韩国|墨西哥/.test(p.fixture.homeTeam));
console.log(`\n=== 14场(shengfucai)同名场核污染(应仍合理) ===`);
for (const p of sf) console.log(`【${p.fixture.homeTeam} vs ${p.fixture.awayTeam}】胜负平:${simpleWldCell(p)} | 让球:${simpleHandicapCell(p)}`);
