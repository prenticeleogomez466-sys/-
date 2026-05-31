/**
 * 富集 fixture-store:给历史 fixture 补半场比分 + 去 vig 赔率隐含(开/收盘)+ 大小球/亚盘。
 * ──────────────────────────────────────────────────────────────────────
 * 背景:football-data.co.uk CSV 本就含 HTHG/HTAG(半场)+ Avg*(开盘)/AvgC*(收盘)赔率,
 *       但旧 historical-backfill 入库时只取了全场比分,丢掉半场+赔率 →
 *       fixture-store 带半场仅 1 场 / 带赔率 0 场,半全场·大小球·数据变化小模型无米下锅。
 *
 * 本脚本外科手术式补全(不重跑全量 backfill,不碰去重/openfootball,幂等):
 *   1. loadFootballDataMatches 重读 CSV(半场赔率的唯一来源)
 *   2. 按 date|规范化主队|规范化客队 建索引
 *   3. 遍历每个 fixture 文件,对缺半场或缺 marketHistorical 的场次查表补全
 *   4. 原 source 元数据存回(saveFixtures 经 normalizeFixture 已能保留新字段)
 *
 * 只补 football-data 来源能匹配上的场;匹配不上的(openfootball/ESPN/statsbomb)原样保留,绝不编造。
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { listFixtureDates, loadFixtures, saveFixtures } from "../src/fixture-store.js";

for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) delete process.env[k];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
const keyOf = (date, home, away) => `${date}|${norm(home)}|${norm(away)}`;

const t0 = Date.now();
console.log("读取 football-data CSV(半场+赔率源)…");
const fd = await loadFootballDataMatches({
  leagues: ALL_LEAGUES,
  seasons: ["2526", "2425", "2324", "2223", "2122"],
});
if (!fd.ok) { console.error("football-data 加载失败:", fd.error); process.exit(1); }
console.log(`  CSV 场次 ${fd.matches.length}`);

const idx = new Map();
for (const m of fd.matches) idx.set(keyOf(m.date, m.home, m.away), m);

const stats = { files: 0, scanned: 0, halfAdded: 0, oddsAdded: 0, alreadyOk: 0, noMatch: 0, filesWritten: 0 };

for (const date of listFixtureDates()) {
  const payload = loadFixtures(date);
  if (!payload.fixtures.length) continue;
  stats.files++;
  let dirty = false;

  const enriched = payload.fixtures.map((fx) => {
    stats.scanned++;
    const hasHalf = fx.result && fx.result.halfHome != null;
    const hasMkt = fx.marketHistorical && (fx.marketHistorical.openProbs || fx.marketHistorical.closeProbs || fx.marketHistorical.overProb != null);
    if (hasHalf && hasMkt) { stats.alreadyOk++; return fx; }

    const m = idx.get(keyOf(date, fx.homeTeam, fx.awayTeam));
    if (!m) { stats.noMatch++; return fx; }

    const next = { ...fx };
    if (!hasHalf && m.halfHome != null && fx.result) {
      next.result = { ...fx.result, halfHome: m.halfHome, halfAway: m.halfAway };
      stats.halfAdded++; dirty = true;
    }
    if (!hasMkt && (m.odds || m.oddsClose || m.overProb != null || m.asian)) {
      next.marketHistorical = {
        openProbs: m.odds ?? null,
        closeProbs: m.oddsClose ?? null,
        overProb: m.overProb ?? null,
        overProbClose: m.overProbClose ?? null,
        asian: m.asian ?? null,
      };
      stats.oddsAdded++; dirty = true;
    }
    return next;
  });

  if (dirty) {
    saveFixtures(date, enriched, { source: payload.source });
    stats.filesWritten++;
  }
}

console.log("富集汇总:", JSON.stringify(stats, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
