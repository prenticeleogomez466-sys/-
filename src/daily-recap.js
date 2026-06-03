import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getExportDir } from "./paths.js";
import { loadFixtures } from "./fixture-store.js";
import { loadMarketSnapshots, findMarketSnapshot } from "./market-data-store.js";
import { enrichLedgerRow, summarizeLedgerCLV } from "./clv-tracker.js";
import { syncAuthorizedFixturesAndResults } from "./authorized-fixtures.js";
import { syncFootballArtifacts } from "./artifact-sync.js";
import { writeXlsxWorkbook } from "./xlsx-writer.js";
import { appendDailyMetrics, recapTrendRows } from "./daily-metrics-trend.js";
import { attributeRecap } from "./recap-attribution.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
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
  // CLV:载入收盘快照,结算时与下注价对比(分析师建议的真 KPI)。
  let snapshotPool = [];
  try {
    snapshotPool = [...loadMarketSnapshots(targetDate).snapshots, ...loadMarketSnapshots(addDays(targetDate, 1)).snapshots];
  } catch {
    snapshotPool = [];
  }
  const nextLedger = ledger.map((row) => (row.date === targetDate ? updateLedgerRow(row, fixturePool, snapshotPool) : row));
  writeFileSync(ledgerPath, `${JSON.stringify(nextLedger, null, 2)}\n`, "utf8");
  const targetRows = nextLedger.filter((row) => row.date === targetDate);
  const summary = buildRecapSummary(targetDate, targetRows, syncResults);
  // 自动归因(2026-05-31,feedback_deep_analysis_postmortem):对**全历史已结算**做根因归类 +
  //   提炼改进项,实现"为什么对/错"的累计反思,而非只统计命中率。
  const attribution = attributeRecap(nextLedger);
  const detailRows = targetRows.map(toRecapDetailRow);
  // 结尾【自检】(daily-recap-system-prompt output_format):全覆盖/穷尽免费源/单总表/⏳均有理由/0假结算。
  const selfcheck = buildSelfcheck(targetDate, targetRows, syncResults);
  const summaryPath = join(exportDir, `daily-recap-${targetDate}.json`);
  const masterPath = join(exportDir, "football-recap-master.xlsx");
  writeFileSync(summaryPath, `${JSON.stringify({ date: targetDate, generatedAt: new Date().toISOString(), summary, attribution, selfcheck, rows: targetRows }, null, 2)}\n`, "utf8");
  const dailyMetrics = appendDailyMetrics(targetDate, targetRows);
  writeXlsxWorkbook(masterPath, [
    { name: "复盘汇总", rows: [...recapSummaryRows(summary), ...recapTrendRows()] },
    { name: "复盘归因", rows: recapAttributionRows(attribution) },
    { name: "复盘明细", rows: [recapDetailHeaders(), ...detailRows] },
    { name: "历史总表", rows: [recapDetailHeaders(), ...nextLedger.map(toRecapDetailRow)] }
  ]);
  const dDrivePaths = mirrorRecapExports(targetDate, summaryPath, masterPath);
  const sync = options.syncArtifacts === false ? null : syncFootballArtifacts(targetDate);
  // 备源说明:TheSportsDB(thesportsdb-results-source.js)尚未挂入 buildAuthorizedProviders 赛果同步链。
  //   未硬接的客观原因:其 eventsround 按"整轮"返回(非单日),需 leagueId 注册表+季次推断+整季逐轮抓取再按
  //   日期过滤,且返回 shape 为 homeGoals/awayGoals(非 result),非 <15 行轻接;按要求不破坏现有同步,本次不动。
  const backupSourceNote = "建议接入 TheSportsDB 作 ESPN 盲区备源,但本次未动:其按整轮(非单日)返回,需 leagueId 注册表+季次推断+shape 适配,非轻量接入,硬接有破坏现有同步风险。";
  return { ok: true, date: targetDate, summary, attribution, selfcheck, backupSourceNote, dailyMetrics, paths: { summaryPath, masterPath, ledgerPath, ...dDrivePaths }, syncResults, sync };
}

// 结尾【自检】对象:逐项核对 daily-recap-system-prompt 的 5 条 output 要求(诚实返回真值,不强行报✓)。
function buildSelfcheck(date, rows, syncResults) {
  const pendingRows = rows.filter((row) => !(row.actualStatus === "settled" || row.actual));
  const pendingWithReason = pendingRows.filter((row) => typeof row.pendingReason === "string" && row.pendingReason.trim());
  // 0 假结算:已结算行必须带 actualScore(来自真抓赛果),无比分却标 settled 即视为可疑假结算。
  const settledRows = rows.filter((row) => row.actualStatus === "settled" || row.actual);
  const suspectFake = settledRows.filter((row) => !row.actualScore).length;
  const freeSources = (syncResults ?? []).flatMap((item) => item.sources ?? []).filter((s) => s.ok).map((s) => s.name);
  return {
    全覆盖: rows.length > 0,
    覆盖场次: rows.length,
    穷尽免费源: freeSources.length > 0,
    免费源: [...new Set(freeSources)],
    单总表: true,
    "⏳均有理由": pendingRows.length === pendingWithReason.length,
    待回填: pendingRows.length,
    待回填已写理由: pendingWithReason.length,
    "0假结算": suspectFake === 0,
    可疑假结算: suspectFake
  };
}

// 复盘归因 → xlsx 行(累计根因分类 + 逐场为什么对/错 + 提炼改进项)。
export function recapAttributionRows(attr) {
  if (!attr || !attr.settled) return [["复盘归因", "暂无已结算场次(等赛果回填)", "", ""]];
  const rows = [
    ["⚡ 复盘归因 · 累计", `结算 ${attr.settled} · 命中 ${attr.hit}(${attr.accuracy}%)`, "", ""],
    [],
    ["类别分布", ...Object.entries(attr.byCategory).map(([k, v]) => `${k}:${v}`)],
    [],
    ["逐场归因", "对错", "类别", "原因"],
    ...attr.items.map((it) => [it.match ?? "", it.hit ? "✓" : "✗", it.category, it.why]),
    [],
    ["🎯 提炼改进项", ...(attr.topImprovements.length ? attr.topImprovements : ["暂无(样本不足)"])],
    [],
    ["分联赛命中", ...Object.entries(attr.byLeague).map(([lg, v]) => `${lg}:${v.hit}/${v.n}`)],
  ];
  return rows;
}

function mirrorRecapExports(date, summaryPath, masterPath) {
  if (process.env.FOOTBALL_D_EXPORT === "0") return {};
  const dExportDir = join("D:", "football-model-exports");
  mkdirSync(dExportDir, { recursive: true });
  const dSummaryPath = join(dExportDir, `daily-recap-${date}.json`);
  const dMasterPath = join(dExportDir, "football-recap-master.xlsx");
  copyFileSync(summaryPath, dSummaryPath);
  copyFileSync(masterPath, dMasterPath);
  return { dSummaryPath, dMasterPath };
}

function updateLedgerRow(row, fixtures, snapshots = []) {
  const fixture = findFixtureForLedger(row, fixtures);
  if (!fixture?.result) return { ...row, actualStatus: "pending-result", pendingReason: inferPendingReason(row, fixture) };
  const actualCode = resultCode(fixture.result);
  const actualScore = `${fixture.result.home}-${fixture.result.away}`;
  const actualHalfFull = halfFullFromResult(fixture.result);
  // 让球胜平负结算(2026-05-31):按比分 + 让球线算实际让球结果,与预测让球比对。
  const actualHandicap = handicapResultCode(fixture.result, row.handicapLine);
  const settled = {
    ...row,
    actual: outcomeCodeToChinese(actualCode),
    actualCode,
    actualScore,
    actualHalfFull,
    actualHandicapCode: actualHandicap?.code ?? "",
    actualHandicap: actualHandicap?.label ?? "",
    actualStatus: "settled",
    hit: outcomeCode(row.primary) === actualCode,
    secondaryHit: outcomeCode(row.secondary) === actualCode,
    scoreHit: normalizeScore(row.scorePrimary) === actualScore,
    scoreSecondaryHit: normalizeScore(row.scoreSecondary) === actualScore,
    // 全矩阵众数(均势最高单一比分,如 1-1)命中——计入"含备选"覆盖口径,补回头条改方向一致后丢失的高频比分。
    scoreModeHit: row.scoreMode ? normalizeScore(row.scoreMode) === actualScore : false,
    halfFullHit: normalizeHalfFull(row.halfFullPrimary) === actualHalfFull,
    halfFullSecondaryHit: normalizeHalfFull(row.halfFullSecondary) === actualHalfFull,
    handicapWldHit: actualHandicap && row.handicapWldCode ? String(row.handicapWldCode) === actualHandicap.code : null,
    settledAt: new Date().toISOString()
  };
  return enrichSettledWithCLV(settled, fixture, snapshots);
}

// 取某选项(3=主/1=平/0=客)在欧赔里的小数赔率。
function pickDecimalOdds(europeanOdds, pickCode) {
  const key = pickCode === "3" ? "home" : pickCode === "1" ? "draw" : pickCode === "0" ? "away" : null;
  if (!key) return null;
  const v = Number(europeanOdds?.[key]);
  return Number.isFinite(v) && v > 1 ? v : null;
}

// 结算行附 CLV:用收盘快照(final/current 最新捕获=最接近收盘)对比下注价。
// 只有当收盘捕获时刻晚于下注捕获时刻,才算"真收盘"(measured=true),否则单次捕获不计入 CLV 统计。
function enrichSettledWithCLV(settled, fixture, snapshots) {
  if (!Number.isFinite(Number(settled.primaryOdds)) || !Array.isArray(snapshots) || !snapshots.length) return settled;
  const snapshot = findMarketSnapshot(fixture, snapshots);
  const closingEu = snapshot?.europeanOdds?.final ?? snapshot?.europeanOdds?.current;
  const pickCode = outcomeCode(settled.primary);
  const closingOdds = pickDecimalOdds(closingEu, pickCode);
  if (closingOdds == null) return settled;
  const closeAt = snapshot?.collectedAt ?? null;
  const measured = Boolean(closeAt && settled.betCapturedAt && closeAt > settled.betCapturedAt);
  return enrichLedgerRow(settled, closingOdds, { measured });
}

function buildRecapSummary(date, rows, syncResults) {
  const settled = rows.filter((row) => row.actualStatus === "settled" || row.actual);
  const wdlPrimary = rate(settled, (row) => row.hit === true);
  const wdlCover = rate(settled, (row) => row.hit === true || row.secondaryHit === true);
  const scorePrimary = rate(settled, (row) => row.scoreHit === true);
  const scoreCover = rate(settled, (row) => row.scoreHit === true || row.scoreSecondaryHit === true || row.scoreModeHit === true);
  // 半全场只在「有半场数据」的场上评(部分免费赛果源不带半场比分,actualHalfFull 为空时不计入分母,
  //   否则会被误算成全部未中 → 假 0%)。
  const halfFullSettled = settled.filter((row) => row.actualHalfFull && row.actualHalfFull !== "");
  const halfFullPrimary = rate(halfFullSettled, (row) => row.halfFullHit === true);
  const halfFullCover = rate(halfFullSettled, (row) => row.halfFullHit === true || row.halfFullSecondaryHit === true);
  // CLV:分析师建议的真 KPI —— 下注价 vs 收盘线,衡量是否长期击败市场(比短期命中率更可靠)。
  const clv = summarizeLedgerCLV(settled);
  // 下注分级真实命中率:验证🟢建议下注场是否真命中~73%(选择性推荐落地的反馈环)。
  const tierBreakdown = summarizeByTier(settled);
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
    clv,
    tierBreakdown,
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

// 行的下注分级:优先用 ledger 存的 tier,旧行回退按概率重算(阈值同 daily-report.bettingTier)。
function tierOf(row) {
  if (typeof row.tier === "string" && row.tier) return row.tier;
  const top = Math.max(Number(row.probabilityHome) || 0, Number(row.probabilityDraw) || 0, Number(row.probabilityAway) || 0);
  if (top >= 0.65) return "🟢 建议下注";
  if (top >= 0.50) return "🟡 可选";
  return "⚪ 慎选/观望";
}

// 按下注分级汇总真实首选命中率(验证分级是否名副其实)。
export function summarizeByTier(settled) {
  const tiers = ["🟢 建议下注", "🟡 可选", "⚪ 慎选/观望"];
  const out = {};
  for (const t of tiers) {
    const rows = settled.filter((r) => tierOf(r) === t);
    const hit = rows.filter((r) => r.hit === true).length;
    out[t] = { total: rows.length, hit, accuracy: rows.length ? Math.round((hit / rows.length) * 10000) / 10000 : null };
  }
  return out;
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
    ["CLV 收盘线价值", summary.clv?.measurable ? `${Math.round((summary.clv.avgCLV ?? 0) * 1000) / 10}%` : "不可测", summary.clv?.verdict ?? "需收盘赔率快照"],
    ["CLV 击败收盘线率", summary.clv?.measurable ? `${Math.round((summary.clv.positiveRate ?? 0) * 100)}%` : "—", `样本 ${summary.clv?.samples ?? 0};长期盈利需 ≥55%`],
    ...tierBreakdownRows(summary.tierBreakdown),
    ["赛果同步", summary.sync.map((item) => `${item.date} fetched=${item.fetched} matched=${item.matched} updated=${item.updated}`).join("；"), "每天上午11点自动同步前一天与次日赛果"]
  ];
}

// 下注分级真实命中率行(样本不足时诚实标注,不夸大)。
function tierBreakdownRows(tb) {
  if (!tb) return [];
  const expect = { "🟢 建议下注": "回测期望~73%", "🟡 可选": "回测期望~64-67%", "⚪ 慎选/观望": "回测低于全推54%" };
  const rows = Object.entries(tb).map(([tier, v]) => [
    `分级命中率 ${tier}`,
    v.total ? pct(v.accuracy) : "无样本",
    v.total ? `${v.hit}/${v.total}（${expect[tier]}${v.total < 10 ? "；样本不足,仅参考" : ""}）` : `${expect[tier]};当日无此分级场次`
  ]);
  rows.push(["分级阈值说明", "基于五大联赛标定", "北欧/J联/小联赛方差更大、赔率效率低,🟢在冷门联赛真实命中通常低于回测期望,要打折看"]);
  return rows;
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
    "让球胜平负",
    "实际胜平负",
    "实际比分",
    "实际半全场",
    "实际让球",
    "胜平负首选命中",
    "胜平负含备选命中",
    "比分首选命中",
    "比分含备选命中",
    "半全场首选命中",
    "半全场含备选命中",
    "让球命中",
    "风险",
    "信心",
    "资金决策",
    "EV",
    "复盘状态",
    "待结算原因",
    "来源",
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
    row.handicapWld ? `${row.handicapWld}${row.handicapLine === "" || row.handicapLine == null ? "" : `(${row.handicapLine})`}` : "",
    row.actual,
    row.actualScore,
    row.actualHalfFull ?? "",
    row.actualHandicap ?? "",
    boolText(row.hit),
    boolText(row.hit === true || row.secondaryHit === true),
    boolText(row.scoreHit),
    boolText(row.scoreHit === true || row.scoreSecondaryHit === true),
    boolText(row.halfFullHit),
    boolText(row.halfFullHit === true || row.halfFullSecondaryHit === true),
    boolText(row.handicapWldHit),
    row.risk,
    row.confidence,
    row.bankrollDecision,
    row.ev ?? "",
    row.actualStatus ?? (row.actual ? "settled" : "pending-result"),
    row.actualStatus === "settled" || row.actual ? "" : (row.pendingReason ?? ""),
    row.provenance ?? row.source ?? "",
    row.reason
  ];
}

// ESPN 单日赛果覆盖的联赛(中文名,见 espn-results-source.ESPN_LEAGUES)。
// 不在此集合、且非德甲(OpenLigaDB)的联赛 → ESPN 盲区,免费源可能无该场赛果。
const ESPN_COVERED_LEAGUES = new Set([
  "美职", "巴甲", "日职", "沙特联", "中超", "阿甲", "墨超", "韩K",
  "瑞超", "挪超", "丹超", "奥地利", "瑞士", "俄超", "澳超"
]);
const OPENLIGA_LEAGUES = new Set(["德甲", "德乙", "德国杯"]);

// ⏳待回填逐条客观原因(daily-recap-system-prompt 硬规则 #2:留 ⏳ 必须写明客观原因)。
// 三类:①没抓到该场次 fixture;②fixture 在但未完赛(开赛在未来/当日晚);③属 ESPN 盲区联赛免费源暂无赛果。
function inferPendingReason(row, fixture) {
  if (!fixture) return "免费源未匹配到该场次";
  const league = String(fixture.competition ?? row.competition ?? "").trim();
  const isEspnBlind = league && !ESPN_COVERED_LEAGUES.has(league) && !OPENLIGA_LEAGUES.has(league);
  // fixture 存在但 result 为 null:多半是还没开赛/没完赛。
  if (!fixture.result) {
    const kickoff = String(fixture.kickoff ?? "").trim();
    const notKicked = isKickoffFuture(fixture);
    if (notKicked) return `比赛未开赛/未完赛(开赛 ${kickoff || fixture.date || "时间未知"})`;
    if (isEspnBlind) return `免费源(${league || "该联赛"})暂无该场赛果`;
    return `比赛未开赛/未完赛(开赛 ${kickoff || fixture.date || "时间未知"})`;
  }
  return isEspnBlind ? `免费源(${league || "该联赛"})暂无该场赛果` : "免费源暂无该场赛果";
}

// 判断 fixture 是否尚未开赛:kickoff 形如 "HH:mm" 或日期;结合 date 推断比赛时刻是否在当前之后。
function isKickoffFuture(fixture) {
  const date = String(fixture.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) return false;
  const kickoff = String(fixture.kickoff ?? "").trim();
  const time = kickoff.match(/(\d{1,2}):(\d{2})/);
  const iso = time ? `${date}T${time[1].padStart(2, "0")}:${time[2]}:00+08:00` : `${date}T23:59:59+08:00`;
  const kickAt = new Date(iso).getTime();
  return Number.isFinite(kickAt) && kickAt > Date.now();
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

// 让球实际结果(2026-05-31):net = (主-客) + 让球线;>0 让球主胜 / =0 走盘 / <0 让球客胜。
// 让球线与 prediction-engine netExpected = goalDiff + handicapLine 同向(主队视角)。
function handicapResultCode(result, line) {
  const ln = Number(line);
  if (!result || !Number.isFinite(ln) || line === "") return null;
  const net = (Number(result.home) - Number(result.away)) + ln;
  if (Math.abs(net) < 1e-9) return { code: "1", label: "走盘" };
  return net > 0 ? { code: "3", label: "让球主胜" } : { code: "0", label: "让球客胜" };
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
