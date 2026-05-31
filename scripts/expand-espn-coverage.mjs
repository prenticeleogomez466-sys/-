/**
 * ESPN 洲际联赛增量扩充(2026-05-31)——回应"比赛不够多/数据不够多"。
 * ════════════════════════════════════════════════════════════════════
 * 现状:洲际(美职/巴甲/日职/沙特/中超/阿甲/墨超/韩K)在 store 仅千级,小联赛饿死。
 * ESPN 隐藏 API 免授权且实测活跃(2026-04~05 两月 5 联赛即 499 场)。
 *
 * 本脚本只做**增量合并**:按 date+规范化队名 判重,只把 store 里没有的新场加进去,
 * 合并保留原有 fixtures(不覆盖 football-data/openfootball/竞彩抓取),source 标 espn-expansion。
 * ESPN 无半场/赔率 → 这些维保持 null(诚实,不编造)。
 *
 * 用法:node scripts/expand-espn-coverage.mjs [fromISO] [toISO]
 */
import { loadEspnResults, ESPN_LEAGUES } from "../src/espn-results-source.js";
import { listFixtureDates, loadFixtures, saveFixtures } from "../src/fixture-store.js";

for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) delete process.env[k];

const from = process.argv[2] || "2022-01-01";
const to = process.argv[3] || "2026-05-31";
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
const keyOf = (h, a) => `${norm(h)}|${norm(a)}`;

const t0 = Date.now();
console.log(`ESPN 洲际扩充 ${from} ~ ${to},联赛 ${Object.values(ESPN_LEAGUES).join("/")}`);
const r = await loadEspnResults({ leagues: Object.keys(ESPN_LEAGUES), from, to });
if (!r.ok) { console.error("ESPN 拉取失败:", r.error); process.exit(1); }
console.log(`ESPN 返回 ${r.matches.length} 场 | byLeague ${JSON.stringify(r.byLeague)}`);

// 现有 store 的 (date -> Set(key)) 索引;投注日(含竞彩/胜负彩等 marketType≠historical)
// 整日跳过,绝不混入历史赛果污染投注赛程(对齐 historical-backfill 的保护)。
const existingByDate = new Map();
const bettingDates = new Set();
for (const d of listFixtureDates()) {
  const fx = loadFixtures(d).fixtures;
  if (fx.some((f) => f.marketType && f.marketType !== "historical")) { bettingDates.add(d); continue; }
  const set = new Set();
  for (const f of fx) set.add(keyOf(f.homeTeam, f.awayTeam));
  existingByDate.set(d, set);
}

// ESPN 新场按日期分组(去重:store 已有 + 本批内重复)
const addByDate = new Map();
let dup = 0;
for (const m of r.matches) {
  if (!m.date || m.homeGoals == null || m.awayGoals == null) continue;
  if (bettingDates.has(m.date)) { dup++; continue; } // 投注日整日跳过,不污染赛程
  const k = keyOf(m.home, m.away);
  const existSet = existingByDate.get(m.date);
  if (existSet && existSet.has(k)) { dup++; continue; }
  if (!addByDate.has(m.date)) addByDate.set(m.date, { list: [], keys: new Set() });
  const bucket = addByDate.get(m.date);
  if (bucket.keys.has(k)) { dup++; continue; }
  bucket.keys.add(k);
  bucket.list.push(m);
}

let added = 0, files = 0;
for (const [date, bucket] of addByDate) {
  const cur = loadFixtures(date);
  const base = cur.fixtures.slice();
  bucket.list.forEach((m, i) => {
    base.push({
      id: `espn-${date}-${base.length + i}-${norm(m.home)}-${norm(m.away)}`,
      date, homeTeam: m.home, awayTeam: m.away,
      competition: m.league, marketType: "historical",
      kickoff: `${date}T12:00:00+08:00`,
      result: { home: m.homeGoals, away: m.awayGoals, halfHome: null, halfAway: null },
      source: "espn",
    });
    added++;
  });
  saveFixtures(date, base, { source: cur.source && cur.source !== "empty" ? cur.source : "espn-expansion" });
  files++;
}

console.log(`新增 ${added} 场(已存在跳过 ${dup}),写 ${files} 个日期文件`);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
