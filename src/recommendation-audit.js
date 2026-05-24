import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fourteenSelectionRules, recommendFixtures, validatePredictionConsistency } from "./prediction-engine.js";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

export function auditRecommendations(recommendations) {
  const checks = [];
  for (const prediction of recommendations.predictions) {
    const fixture = prediction.fixture;
    if (!fixture.homeTeam || !fixture.awayTeam) checks.push({ level: "error", message: "比赛缺少主队或客队" });
    if (!["3", "1", "0"].includes(prediction.pick.code)) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 胜平负编码非法` });
    if (!prediction.marketSnapshot) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 缺少实时赔率快照` });
    if (!Number.isFinite(prediction.confidence) || prediction.confidence < 0 || prediction.confidence > 100) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 信心值越界：${prediction.confidence}` });
    if (Math.abs(Object.values(prediction.probabilities ?? {}).reduce((sum, value) => sum + Number(value || 0), 0) - 1) > 0.02) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 胜平负概率未归一` });
    if (!prediction.scorePicks?.primary || !prediction.halfFullPicks?.primary) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 缺少比分或半全场派生` });
    for (const message of validatePredictionConsistency(prediction)) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} ${message}` });
  }
  const rules = fourteenSelectionRules();
  const bankerCount = (recommendations.fourteen?.selections ?? []).filter((selection) => selection.type === "胆").length;
  if (bankerCount > rules.maxBankers) checks.push({ level: "error", message: `14场定胆过多：${bankerCount}/${rules.maxBankers}` });
  for (const selection of recommendations.fourteen?.selections ?? []) {
    if (selection.type === "胆" && selection.risk === "高") checks.push({ level: "error", message: `14场高风险场次禁止定胆：${selection.index} ${selection.match}` });
  }
  const errors = checks.filter((item) => item.level === "error");
  const warnings = checks.filter((item) => item.level === "warning");
  return {
    ok: errors.length === 0,
    summary: {
      totalChecks: recommendations.predictions.length,
      errors: errors.length,
      warnings: warnings.length,
      predictions: recommendations.predictions.length,
      fourteen: recommendations.fourteen.count,
      fourteenBankers: bankerCount,
      fourteenMaxBankers: rules.maxBankers
    },
    checks,
    errors
  };
}

export function writeRecommendationAudit(date, audit) {
  mkdirSync(exportDir, { recursive: true });
  const path = join(exportDir, `recommendation-audit-${date}.json`);
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? new Date().toISOString().slice(0, 10);
  const recommendations = recommendFixtures(date);
  const audit = auditRecommendations(recommendations);
  const path = writeRecommendationAudit(date, audit);
  console.log(JSON.stringify({ ok: audit.ok, summary: audit.summary, path }, null, 2));
  if (!audit.ok) process.exitCode = 1;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
