#!/usr/bin/env node
import { backfillHistorical } from "../src/historical-backfill.js";

const args = process.argv.slice(2);
const getStr = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const opts = {
  includeOpenfootball: !args.includes("--no-openfootball"),
  includeStatsbomb: !args.includes("--no-statsbomb"),
  // Z 档:--footballdata 开启 football-data.co.uk 扩展联赛(英冠/德乙/荷甲/葡超/土超等 13 个)
  includeFootballData: args.includes("--footballdata"),
  // Z2 档:--espn 开启 ESPN 洲际联赛(美职/巴甲/日职/沙特/中超/阿甲/墨超/韩K)
  includeEspn: args.includes("--espn"),
  espnFrom: getStr("--espn-from", "2024-01-01"),
  espnTo: getStr("--espn-to", "2025-12-31")
};
console.log("Starting historical backfill...");
const summary = await backfillHistorical(opts);
console.log("Done:");
console.log(`  OpenFootball matches loaded: ${summary.openfootball}`);
console.log(`  StatsBomb matches loaded:    ${summary.statsbomb}`);
console.log(`  football-data 扩展联赛:      ${summary.footballdata}`);
console.log(`  ESPN 洲际联赛:               ${summary.espn}`);
console.log(`  Fixtures written:            ${summary.written}`);
console.log(`  Skipped (already exist):     ${summary.skipped}`);
