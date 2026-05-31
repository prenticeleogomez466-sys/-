#!/usr/bin/env node
import { backfillHistorical } from "../src/historical-backfill.js";
import { ALL_LEAGUES } from "../src/footballdata-loader.js";

const args = process.argv.slice(2);
const getStr = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const getNum = (f, d) => { const v = getStr(f, null); return v != null ? Number(v) : d; };

// --fd-back N:从 2025-26(代码 2526)往前数 N 季,生成 football-data 赛季代码(如 2526,2425,...)。
//   扩 10 万场用:big-5 自 1993、扩展联赛各自起始年,results 必有;老季 AvgC 列可能缺则降级 B365/null。
function seasonCodesBack(n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const startYY = (25 - i + 100) % 100;          // 25,24,23,...
    const endYY = (startYY + 1) % 100;
    codes.push(`${String(startYY).padStart(2, "0")}${String(endYY).padStart(2, "0")}`);
  }
  return codes;
}
const fdBack = getNum("--fd-back", null);
const fdSeasonsCsv = getStr("--fd-seasons", null);
const footballDataSeasons = fdSeasonsCsv ? fdSeasonsCsv.split(",").map((s) => s.trim()).filter(Boolean)
  : fdBack ? seasonCodesBack(fdBack) : undefined; // undefined → loader DEFAULT_SEASONS(5 季)

const opts = {
  includeOpenfootball: !args.includes("--no-openfootball"),
  includeStatsbomb: !args.includes("--no-statsbomb"),
  // Z 档:--footballdata 开启 football-data.co.uk 扩展联赛(英冠/德乙/荷甲/葡超/土超等 13 个)
  includeFootballData: args.includes("--footballdata"),
  // --fd-all-leagues:big-5 + 扩展 13 = 18 联赛全收(big-5 老季 OpenFootball 不覆盖,去重防重复)
  footballDataLeagues: args.includes("--fd-all-leagues") ? ALL_LEAGUES : undefined,
  footballDataSeasons,
  // Z2 档:--espn 开启 ESPN 洲际联赛(美职/巴甲/日职/沙特/中超/阿甲/墨超/韩K)
  includeEspn: args.includes("--espn"),
  espnFrom: getStr("--espn-from", "2024-01-01"),
  espnTo: getStr("--espn-to", "2025-12-31")
};
if (footballDataSeasons) console.log(`football-data 赛季(${footballDataSeasons.length}):`, footballDataSeasons.join(","));
if (opts.footballDataLeagues) console.log(`football-data 联赛(${opts.footballDataLeagues.length}):`, opts.footballDataLeagues.join(","));
console.log("Starting historical backfill...");
const summary = await backfillHistorical(opts);
console.log("Done:");
console.log(`  OpenFootball matches loaded: ${summary.openfootball}`);
console.log(`  StatsBomb matches loaded:    ${summary.statsbomb}`);
console.log(`  football-data 扩展联赛:      ${summary.footballdata}`);
console.log(`  ESPN 洲际联赛:               ${summary.espn}`);
console.log(`  Fixtures written:            ${summary.written}`);
console.log(`  Skipped (already exist):     ${summary.skipped}`);
