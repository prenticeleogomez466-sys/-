import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recommendFixtures } from "./prediction-engine.js";
import { auditRecommendations } from "./recommendation-audit.js";
import { assertLatestRealtimeSourceGate } from "./realtime-source-gate.js";
import { auditModelStructure } from "./model-structure-audit.js";
import { buildMarketCoverageStatus, checkMarketRequirements } from "./market-data-store.js";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

const STANDARD = {
  baselineDate: "2026-05-15",
  baselineTimezone: "Asia/Shanghai",
  requireFreshRealtimeGate: true,
  requireMarketCoverageRatio: 1,
  requireCompleteCoverageRatio: 1,
  requireRealtimeCoverageRatio: 1,
  requireRecommendationErrors: 0,
  requireRecommendationWarnings: 0,
  requireModelErrors: 0,
  jingcaiRequiredLayers: ["europeanOdds", "asianHandicap", "handicapOdds"],
  shengfucaiRequiredLayers: ["europeanOdds", "asianHandicap"]
};

const date = readArg("--date") ?? todayInShanghai();

try {
  const gateResult = assertLatestRealtimeSourceGate(date);
  const market = buildMarketCoverageStatus(date);
  const marketRequirement = checkMarketRequirements(market, {
    requireAllFixtures: true,
    requireCompleteOdds: true,
    requireRealTime: true
  });
  const recommendations = recommendFixtures(date);
  const recommendationAudit = auditRecommendations(recommendations);
  const modelAudit = auditModelStructure(date);
  const realtimeRows = market.rows.filter((row) => row.realTime).length;
  const checks = [
    check("fresh-realtime-gate", gateResult.ok, `ageMinutes=${gateResult.ageMinutes}`),
    check("market-usable-coverage", market.usable === market.fixtures, `${market.usable}/${market.fixtures}`),
    check("market-complete-coverage", market.complete === market.fixtures, `${market.complete}/${market.fixtures}`),
    check("market-realtime-coverage", realtimeRows === market.fixtures, `${realtimeRows}/${market.fixtures}`),
    check("market-missing-zero", market.missing === 0, `missing=${market.missing}`),
    check("market-requirements", marketRequirement.ok, marketRequirement.failures.join("; ") || "ok"),
    check("recommendation-errors-zero", recommendationAudit.summary.errors === 0, `errors=${recommendationAudit.summary.errors}`),
    check("recommendation-warnings-zero", recommendationAudit.summary.warnings === 0, `warnings=${recommendationAudit.summary.warnings}`),
    check("recommendation-count-matches-fixtures", recommendationAudit.summary.predictions === market.fixtures, `${recommendationAudit.summary.predictions}/${market.fixtures}`),
    check("model-errors-zero", modelAudit.summary.errors === 0, `errors=${modelAudit.summary.errors}`)
  ];
  const result = {
    ok: checks.every((item) => item.ok),
    date,
    generatedAt: new Date().toISOString(),
    standard: STANDARD,
    summary: {
      fixtures: market.fixtures,
      snapshots: market.snapshots,
      usable: market.usable,
      complete: market.complete,
      realtime: realtimeRows,
      recommendationErrors: recommendationAudit.summary.errors,
      recommendationWarnings: recommendationAudit.summary.warnings,
      modelErrors: modelAudit.summary.errors
    },
    checks
  };
  mkdirSync(exportDir, { recursive: true });
  const path = join(exportDir, `data-completeness-standard-${date}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: result.ok, summary: result.summary, path }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail ?? "") };
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
