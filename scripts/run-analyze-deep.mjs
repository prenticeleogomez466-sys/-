#!/usr/bin/env node
/**
 * npm run analyze:deep -- --date=YYYY-MM-DD [--fixture=N]
 * 演示完整 18+ 步 deep pipeline 在指定 fixture 上的输出.
 */
import { loadFixtures } from "../src/fixture-store.js";
import { loadMarketSnapshots } from "../src/market-data-store.js";
import { loadAdvancedData } from "../src/advanced-data-store.js";
import { bootstrapRatings } from "../src/ratings-bootstrap.js";
import { createDeepPipeline } from "../src/integrated-deep-pipeline.js";

const args = process.argv.slice(2);
const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1];
const fixtureSeqArg = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];

if (!dateArg) {
  console.error("Usage: npm run analyze:deep -- --date=YYYY-MM-DD [--fixture=001]");
  process.exit(1);
}

const fs = loadFixtures(dateArg);
if (!fs.fixtures.length) {
  console.error(`No fixtures for ${dateArg}`);
  process.exit(1);
}

const fixtures = fixtureSeqArg
  ? fs.fixtures.filter((f) => String(f.sequence) === String(fixtureSeqArg) || f.id === fixtureSeqArg)
  : fs.fixtures;

if (!fixtures.length) {
  console.error(`Fixture ${fixtureSeqArg} not found in ${dateArg}`);
  process.exit(1);
}

const snapshots = loadMarketSnapshots(dateArg).snapshots;
const advanced = loadAdvancedData(dateArg);
const bootstrap = bootstrapRatings();
const pipeline = createDeepPipeline({ ratingsBootstrap: bootstrap });

console.log(`Deep analysis for ${dateArg} (${fixtures.length} fixture${fixtures.length > 1 ? "s" : ""}):\n`);

for (const f of fixtures) {
  const snap = snapshots.find((s) => s.fixtureId === f.id);
  const adv = advanced?.fixtures?.find((x) => x.fixtureId === f.id)?.data ?? {};
  const result = pipeline.analyze(f, snap, adv);
  console.log("─".repeat(60));
  console.log(`#${f.sequence} ${f.homeTeam} VS ${f.awayTeam} (${f.competition})`);
  console.log(`  Base probabilities: home ${pct(result.steps.base?.home)} draw ${pct(result.steps.base?.draw)} away ${pct(result.steps.base?.away)}`);
  if (result.steps.sharpener) {
    console.log(`  Multi-source sharpener: ${result.steps.sharpener.sources} sources, ${result.steps.sharpener.consensus}, vig ${pct(result.steps.sharpener.avgVig)}`);
  }
  if (result.steps.lineMovement) {
    console.log(`  Line movement: ${result.steps.lineMovement.interpretation}`);
  }
  if (result.steps.ensemble) {
    console.log(`  Ensemble: home ${pct(result.steps.ensemble.home)} draw ${pct(result.steps.ensemble.draw)} away ${pct(result.steps.ensemble.away)}`);
  }
  if (result.steps.calibrated) {
    console.log(`  Calibrated: home ${pct(result.steps.calibrated.home)} draw ${pct(result.steps.calibrated.draw)} away ${pct(result.steps.calibrated.away)}`);
  }
  if (result.steps.bestPick) {
    const bp = result.steps.bestPick;
    console.log(`  Best pick: ${bp.outcome} @ ${bp.odds} (prob ${pct(bp.probability)}, EV ${pct(bp.ev)}, Kelly ${bp.kellyStake})`);
  }
  if (result.steps.sensitivity) {
    console.log(`  Sensitivity: ${result.steps.sensitivity.narrative}`);
  }
  console.log(`  Decision: ${result.decision.action} - ${result.decision.reason ?? ""}`);
}

function pct(v) {
  if (!Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}
