import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fourteenSelectionRules, recommendFixtures, validatePredictionConsistency } from "./prediction-engine.js";
import { canonicalTeamName } from "./team-aliases.js";
import { jingcaiWeekdayLabel, sequenceWeekdayPrefix } from "./jingcai-business-day.js";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

export function auditRecommendations(recommendations) {
  const checks = [];
  for (const prediction of recommendations.predictions) {
    const fixture = prediction.fixture;
    if (!fixture.homeTeam || !fixture.awayTeam) checks.push({ level: "error", message: "比赛缺少主队或客队" });
    if (!["3", "1", "0"].includes(prediction.pick.code)) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 胜平负编码非法` });
    // 实时赔率快照只对竞彩(in-play)场次硬要求:
    //   - 14 场胜负彩(shengfucai)期号停售后赔率永久锁定,赔率从 Sina 跨日抓取即可,不需要实时快照
    //   - 国际/参考赛(无 marketType 或其他)不强制
    // 这条修复了 jingcai 反爬 567 时,14 场推荐审计被 14/14 全错阻断的问题
    if (fixture.marketType === "jingcai" && !prediction.marketSnapshot) {
      checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 缺少实时赔率快照` });
    }
    if (!Number.isFinite(prediction.confidence) || prediction.confidence < 0 || prediction.confidence > 100) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 信心值越界：${prediction.confidence}` });
    if (Math.abs(Object.values(prediction.probabilities ?? {}).reduce((sum, value) => sum + Number(value || 0), 0) - 1) > 0.02) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 胜平负概率未归一` });
    if (!prediction.scorePicks?.primary || !prediction.halfFullPicks?.primary) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} 缺少比分或半全场派生` });
    for (const message of validatePredictionConsistency(prediction)) checks.push({ level: "error", message: `${fixture.homeTeam} 对 ${fixture.awayTeam} ${message}` });
  }
  // 竞彩与 14 场实质审核(2026-05-30 hard rule:每次出表前实质校验,不只查结构)
  const jingcaiPreds = recommendations.predictions.filter((p) => p.fixture.marketType === "jingcai");
  // ① 限业务日:竞彩编号 周X 前缀必须与业务日一致,杜绝次日(周日)混入当日单
  const targetLabel = jingcaiWeekdayLabel(recommendations.date);
  if (targetLabel) {
    const offDay = jingcaiPreds.filter((p) => {
      const prefix = sequenceWeekdayPrefix(p.fixture.sequence);
      return prefix && prefix !== targetLabel;
    });
    if (offDay.length) {
      checks.push({ level: "error", message: `竞彩混入非业务日(应为${targetLabel})场次 ${offDay.length} 场：${offDay.map((p) => p.fixture.sequence).join("、")}` });
    }
  }
  // ② 跨源去重:同一场(canonical 队名相同)不得重复出现(Playwright 周六001 与 XML 6001 同场)
  const identityCounts = new Map();
  for (const p of jingcaiPreds) {
    const key = `${canonicalTeamName(p.fixture.homeTeam)}__${canonicalTeamName(p.fixture.awayTeam)}`;
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }
  const dupGroups = [...identityCounts.values()].filter((n) => n > 1).length;
  if (dupGroups) {
    checks.push({ level: "error", message: `竞彩重复场次 ${dupGroups} 组(跨源未去重)` });
  }
  // ③ 14 场:存在即必须恰 14 腿
  if (recommendations.fourteen?.available && recommendations.fourteen.count !== 14) {
    checks.push({ level: "error", message: `14 场腿数异常:${recommendations.fourteen.count}/14` });
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
