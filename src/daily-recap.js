import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { loadFixtures } from "./fixture-store.js";
import { syncAuthorizedFixturesAndResults } from "./authorized-fixtures.js";
import { syncFootballArtifacts } from "./artifact-sync.js";
import { writeXlsxWorkbook } from "./xlsx-writer.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");
const ledgerPath = join(exportDir, "recommendation-ledger.json");

export async function runDailyRecap(date, options = {}) {
  mkdirSync(exportDir, { recursive: true });
  const targetDate = normalizeDate(date ?? yesterdayInShanghai());
  const syncResults = [];
  if (options.syncResults !== false) {
    syncResults.push(await syncAuthorizedFixturesAndResults(targetDate, { strict: false, resultDate: targetDate }));
    syncResults.push(await syncAuthorizedFixturesAndResults(targetDate, { strict: false, resultDate: addDays(targetDate, 1) }));
  }
  const ledger = loadLedger();
  const fixtures = loadFixtures(targetDate).fixtures;
  const nextFixtures = loadFixtures(addDays(targetDate, 1)).fixtures;
  const fixturePool = [...fixtures, ...nextFixtures];
  const nextLedger = ledger.map((row) => (row.date === targetDate ? updateLedgerRow(row, fixturePool) : row));
  writeFileSync(ledgerPath, `${JSON.stringify(nextLedger, null, 2)}\n`, "utf8");
  const targetRows = nextLedger.filter((row) => row.date === targetDate);
  const summary = buildRecapSummary(targetDate, targetRows, syncResults);
  const detailRows = targetRows.map(toRecapDetailRow);
  const summaryPath = join(exportDir, `daily-recap-${targetDate}.json`);
  const masterPath = join(exportDir, "football-recap-master.xlsx");
  writeFileSync(summaryPath, `${JSON.stringify({ date: targetDate, generatedAt: new Date().toISOString(), summary, rows: targetRows }, null, 2)}\n`, "utf8");
  writeXlsxWorkbook(masterPath, [
    { name: "复盘汇总", rows: recapSummaryRows(summary) },
    { name: "复盘明细", rows: [recapDetailHeaders(), ...detailRows] },
    { name: "历史总表", rows: [recapDetailHeaders(), ...nextLedger.map(toRecapDetailRow)] }
  ]);
  const sync = options.syncArtifacts === false ? null : syncFootballArtifacts(targetDate);
  return { ok: true, date: targetDate, summary, paths: { summaryPath, masterPath, ledgerPath }, syncResults, sync };
}

function updateLedgerRow(row, fixtures) {
  const fixture = findFixtureForLedger(row, fixtures);
  if (!fixture?.result) return { ...row, actualStatus: "pending-result" };
  const actualCode = resultCode(fixture.result);
  const actualScore = `${fixture.result.home}-${fixture.result.away}`;
  const actualHalfFull = halfFullFromResult(fixture.result);
  return {
    ...row,
    actual: outcomeCodeToChinese(actualCode),
    actualCode,
    actualScore,
    actualHalfFull,
    actualStatus: "settled",
    hit: outcomeCode(row.primary) === actualCode,
    secondaryHit: outcomeCode(row.secondary) === actualCode,
    scoreHit: normalizeScore(row.scorePrimary) === actualScore,
    scoreSecondaryHit: normalizeScore(row.scoreSecondary) === actualScore,
    halfFullHit: normalizeHalfFull(row.halfFullPrimary) === actualHalfFull,
    halfFullSecondaryHit: normalizeHalfFull(row.halfFullSecondary) === actualHalfFull,
    settledAt: new Date().toISOString()
  };
}

function buildRecapSummary(date, rows, syncResults) {
  const settled = rows.filter((row) => row.actualStatus === "settled" || row.actual);
  const wdlPrimary = rate(settled, (row) => row.hit === true);
  const wdlCover = rate(settled, (row) => row.hit === true || row.secondaryHit === true);
  const scorePrimary = rate(settled, (row) => row.scoreHit === true);
  const scoreCover = rate(settled, (row) => row.scoreHit === true || row.scoreSecondaryHit === true);
  const halfFullPrimary = rate(settled, (row) => row.halfFullHit === true);
  const halfFullCover = rate(settled, (row) => row.halfFullHit === true || row.halfFullSecondaryHit === true);
  return {
    date,
    predictions: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    winDrawLossPrimary: wdlPrimary,
    winDrawLossCover: wdlCover,
    scorePrimary,
    scoreCover,
    halfFullPrimary,
    halfFullCover,
    sync: syncResults.map((item) => ({
      date: item.date,
      fetched: item.fetched,
      matched: item.matched,
      updated: item.updated,
      skipped: item.skipped ?? null,
      sources: item.sources?.map((source) => `${source.name}:${source.ok ? "ok" : source.error}`).join(" / ") ?? ""
    }))
  };
}

function recapSummaryRows(summary) {
  return [
    ["指标", "数值", "说明"],
    ["预测日期", summary.date, "复盘对象为前一天生成的预测"],
    ["预测场次", summary.predictions, ""],
    ["已完赛场次", summary.settled, ""],
    ["待赛果场次", summary.pending, ""],
    ["胜平负首选命中率", pct(summary.winDrawLossPrimary.accuracy), `${summary.winDrawLossPrimary.hit}/${summary.winDrawLossPrimary.total}`],
    ["胜平负含备选命中率", pct(summary.winDrawLossCover.accuracy), `${summary.winDrawLossCover.hit}/${summary.winDrawLossCover.total}`],
    ["比分首选命中率", pct(summary.scorePrimary.accuracy), `${summary.scorePrimary.hit}/${summary.scorePrimary.total}`],
    ["比分含备选命中率", pct(summary.scoreCover.accuracy), `${summary.scoreCover.hit}/${summary.scoreCover.total}`],
    ["半全场首选命中率", pct(summary.halfFullPrimary.accuracy), `${summary.halfFullPrimary.hit}/${summary.halfFullPrimary.total}`],
    ["半全场含备选命中率", pct(summary.halfFullCover.accuracy), `${summary.halfFullCover.hit}/${summary.halfFullCover.total}`],
    ["赛果同步", summary.sync.map((item) => `${item.date} fetched=${item.fetched} matched=${item.matched} updated=${item.updated}`).join("；"), "每天上午11点自动同步前一天与次日赛果"]
  ];
}

function recapDetailHeaders() {
  return [
    "日期",
    "场次",
    "赛事",
    "比赛",
    "胜平负首选",
    "胜平负备选",
    "比分首选",
    "比分备选",
    "半全场首选",
    "半全场备选",
    "实际胜平负",
    "实际比分",
    "实际半全场",
    "胜平负首选命中",
    "胜平负含备选命中",
    "比分首选命中",
    "比分含备选命中",
    "半全场首选命中",
    "半全场含备选命中",
    "风险",
    "信心",
    "资金决策",
    "EV",
    "复盘状态",
    "推荐理由"
  ];
}

function toRecapDetailRow(row) {
  return [
    row.date,
    row.sequence,
    row.competition,
    row.match,
    row.primary,
    row.secondary,
    row.scorePrimary,
    row.scoreSecondary,
    row.halfFullPrimary,
    row.halfFullSecondary,
    row.actual,
    row.actualScore,
    row.actualHalfFull ?? "",
    boolText(row.hit),
    boolText(row.hit === true || row.secondaryHit === true),
    boolText(row.scoreHit),
    boolText(row.scoreHit === true || row.scoreSecondaryHit === true),
    boolText(row.halfFullHit),
    boolText(row.halfFullHit === true || row.halfFullSecondaryHit === true),
    row.risk,
    row.confidence,
    row.bankrollDecision,
    row.ev ?? "",
    row.actualStatus ?? (row.actual ? "settled" : "pending-result"),
    row.reason
  ];
}

function findFixtureForLedger(row, fixtures) {
  const [home, away] = splitMatch(row.match);
  return fixtures.find((fixture) => {
    const sequenceMatch = String(fixture.sequence) === String(row.sequence);
    const teamMatch = sameTeam(fixture.homeTeam, home) && sameTeam(fixture.awayTeam, away);
    return teamMatch || (sequenceMatch && fixture.competition === row.competition);
  });
}

function splitMatch(match) {
  const parts = String(match ?? "").split(/\s+对\s+|\s+vs\s+|\s+VS\s+/);
  return [parts[0] ?? "", parts[1] ?? ""];
}

function outcomeCode(value) {
  const text = String(value ?? "").trim();
  if (["3", "主胜", "胜", "home"].includes(text)) return "3";
  if (["1", "平局", "平", "draw"].includes(text)) return "1";
  if (["0", "客胜", "负", "away"].includes(text)) return "0";
  return "";
}

function outcomeCodeToChinese(code) {
  if (code === "3") return "主胜";
  if (code === "1") return "平局";
  if (code === "0") return "客胜";
  return "";
}

function resultCode(result) {
  if (result.home > result.away) return "3";
  if (result.home === result.away) return "1";
  return "0";
}

function halfFullFromResult(result) {
  if (!Number.isFinite(result.halfHome) || !Number.isFinite(result.halfAway)) return "";
  return `${outcomeCodeToChinese(resultCode({ home: result.halfHome, away: result.halfAway }))}-${outcomeCodeToChinese(resultCode(result))}`;
}

function normalizeScore(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").replace(":", "-");
}

function normalizeHalfFull(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").replace(/[\/_]/g, "-");
}

function boolText(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  return "";
}

function rate(rows, predicate) {
  const total = rows.length;
  const hit = rows.filter(predicate).length;
  return { hit, total, accuracy: total ? round(hit / total) : null };
}

function pct(value) {
  return value === null || value === undefined ? "" : `${Math.round(value * 1000) / 10}%`;
}

function sameTeam(left, right) {
  const l = normalizeName(left);
  const r = normalizeName(right);
  return l === r || l.includes(r) || r.includes(l);
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function loadLedger() {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function normalizeDate(value) {
  const match = String(value ?? "").match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`无效日期：${value}`);
  return match[0];
}

function yesterdayInShanghai() {
  return addDays(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), -1);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = await runDailyRecap(readArg("--date"), {
    syncResults: !args.includes("--no-result-sync"),
    syncArtifacts: !args.includes("--no-sync")
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
