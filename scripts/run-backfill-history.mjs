#!/usr/bin/env node
import { backfillHistorical } from "../src/historical-backfill.js";

const args = process.argv.slice(2);
const opts = {
  includeOpenfootball: !args.includes("--no-openfootball"),
  includeStatsbomb: !args.includes("--no-statsbomb"),
  // Z 档:--footballdata 开启 football-data.co.uk 扩展联赛(英冠/德乙/荷甲/葡超/土超等 13 个)
  includeFootballData: args.includes("--footballdata")
};
console.log("Starting historical backfill...");
const summary = await backfillHistorical(opts);
console.log("Done:");
console.log(`  OpenFootball matches loaded: ${summary.openfootball}`);
console.log(`  StatsBomb matches loaded:    ${summary.statsbomb}`);
console.log(`  football-data 扩展联赛:      ${summary.footballdata}`);
console.log(`  Fixtures written:            ${summary.written}`);
console.log(`  Skipped (already exist):     ${summary.skipped}`);
