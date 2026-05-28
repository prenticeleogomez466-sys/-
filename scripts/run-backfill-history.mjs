#!/usr/bin/env node
import { backfillHistorical } from "../src/historical-backfill.js";

const args = process.argv.slice(2);
const opts = {
  includeOpenfootball: !args.includes("--no-openfootball"),
  includeStatsbomb: !args.includes("--no-statsbomb")
};
console.log("Starting historical backfill...");
const summary = await backfillHistorical(opts);
console.log("Done:");
console.log(`  OpenFootball matches loaded: ${summary.openfootball}`);
console.log(`  StatsBomb matches loaded:    ${summary.statsbomb}`);
console.log(`  Fixtures written:            ${summary.written}`);
console.log(`  Skipped (already exist):     ${summary.skipped}`);
