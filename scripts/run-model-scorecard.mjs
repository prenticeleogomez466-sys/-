#!/usr/bin/env node
/**
 * npm run model:scorecard
 * 跑七维度自评 + 写报告.
 */
import { writeScorecardReport } from "../src/model-scorecard-cli.js";

const report = writeScorecardReport();
console.log(`Total: ${report.total}/100 (${report.grade})`);
console.log("");
console.log("By dimension:");
for (const d of report.breakdown) {
  console.log(`  ${d.dimension.padEnd(10)} ${String(d.score).padStart(6)} / ${d.max}`);
}
console.log("");
console.log(`Report: ${report.mdPath}`);
console.log(`JSON  : ${report.jsonPath}`);
