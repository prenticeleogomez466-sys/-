import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { loadFixtures } from "./fixture-store.js";
import { getDataSubdir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const marketDir = getDataSubdir("market");

export function loadMarketSnapshots(date) {
  mkdirSync(marketDir, { recursive: true });
  const filePath = join(marketDir, `${date}.json`);
  if (!existsSync(filePath)) return { date, source: "empty", snapshots: [] };
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const snapshots = Array.isArray(payload) ? payload : payload.snapshots ?? [];
  return { date: payload.date ?? date, source: payload.source ?? "market-json", snapshots: snapshots.map((snapshot, index) => normalizeMarketSnapshot(snapshot, date, index)) };
}

export function saveMarketSnapshots(date, snapshots, metadata = {}) {
  mkdirSync(marketDir, { recursive: true });
  const payload = { date, source: metadata.source ?? "manual", importedAt: new Date().toISOString(), snapshots: snapshots.map((snapshot, index) => normalizeMarketSnapshot(snapshot, date, index)) };
  const path = join(marketDir, `${date}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { ...payload, path };
}

export function findMarketSnapshot(fixture, snapshotsOrDate = fixture?.date) {
  const snapshots = Array.isArray(snapshotsOrDate) ? snapshotsOrDate : loadMarketSnapshots(snapshotsOrDate ?? fixture.date).snapshots;
  // 同一场可能有多源快照(主路径 Playwright 胜平负/让球 + 兜底注入器 比分/半全场/总进球)。
  // 数据完整性铁律(2026-06-06 用户"所有数据都要抓全·不能缺",feedback_fetch_all_then_audit):
  //   不再只返回首个匹配,而是【合并所有匹配快照的各赔种字段】——哪个源有该赔种就补进来,保证完整。
  // 按 fixtureId 或 队名 都算同一场(多源快照常 fixtureId 不同:主路径 id vs 兜底 jc500-id)。
  const sameMatch = (s) => s.fixtureId === fixture.id || (normalizeName(s.homeTeam) === normalizeName(fixture.homeTeam) && normalizeName(s.awayTeam) === normalizeName(fixture.awayTeam));
  const matches = snapshots.filter(sameMatch);
  if (!matches.length) return null;
  // 基准优先取 fixtureId 精确匹配的(保官方/主路径基本盘),再用各源补全赔种字段。
  const base = { ...(matches.find((s) => s.fixtureId === fixture.id) ?? matches[0]) };
  const hasData = (v) => v != null && !(Array.isArray(v?.top) && v.top.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  const ODDS_FIELDS = ["europeanOdds", "handicapOdds", "asianHandicap", "totals", "scoreOdds", "halfFullOdds", "totalGoalsOdds", "jingcaiHandicap", "jingcaiLetqiu", "handicapOddsLetqiu"];
  for (const f of ODDS_FIELDS) {
    if (!hasData(base[f])) { const donor = matches.find((s) => hasData(s[f])); if (donor) base[f] = donor[f]; }
  }
  return base;
}

export function buildMarketCoverageStatus(date) {
  const fixtureSet = loadFixtures(date);
  const marketSet = loadMarketSnapshots(date);
  const rows = fixtureSet.fixtures.map((fixture) => {
    const snapshot = findMarketSnapshot(fixture, marketSet.snapshots);
    const completeness = snapshot ? assessSnapshotCompleteness(snapshot, fixture) : { usable: false, complete: false, missing: ["赔率快照"] };
    const freshness = snapshot ? assessSnapshotFreshness(snapshot) : { realTime: false, status: "未接入真实赔率源", collectedAt: null };
    return { fixtureId: fixture.id, sequence: fixture.sequence, match: `${fixture.homeTeam} 对 ${fixture.awayTeam}`, hasSnapshot: Boolean(snapshot), realTime: freshness.realTime, freshness: freshness.status, collectedAt: freshness.collectedAt, usable: completeness.usable, complete: completeness.complete, missing: completeness.missing };
  });
  return {
    date: fixtureSet.date,
    fixtures: fixtureSet.fixtures.length,
    snapshots: marketSet.snapshots.length,
    usable: rows.filter((row) => row.usable).length,
    complete: rows.filter((row) => row.complete).length,
    missing: rows.filter((row) => !row.usable).length,
    coverage: fixtureSet.fixtures.length ? round(rows.filter((row) => row.usable).length / fixtureSet.fixtures.length) : 0,
    completeCoverage: fixtureSet.fixtures.length ? round(rows.filter((row) => row.complete).length / fixtureSet.fixtures.length) : 0,
    rows
  };
}

export function checkMarketRequirements(status, options = {}) {
  const requireAllFixtures = options.requireAllFixtures ?? true;
  const requireCompleteOdds =
    options.requireCompleteOdds ??
    (process.env.FREE_ODDS_ONLY !== "0" ? process.env.FREE_MODE_REQUIRE_HANDICAP === "1" : process.env.ODDS_REQUIRE_COMPLETE !== "0");
  const requireRealTime = options.requireRealTime ?? process.env.ODDS_REQUIRE_REALTIME !== "0";
  const failures = [];
  if (requireAllFixtures && status.fixtures > 0 && status.usable !== status.fixtures) failures.push(`真实赔率覆盖不完整：${status.usable}/${status.fixtures}`);
    if (requireCompleteOdds && status.fixtures > 0 && status.complete !== status.fixtures) failures.push(`玩法赔率不完整：${status.complete}/${status.fixtures}，竞彩足球需欧洲赔率、亚洲盘口、让球胜平负；14场需欧洲赔率、亚洲盘口`);
  if (requireRealTime) {
    const realTimeCount = status.rows.filter((row) => row.realTime).length;
    if (status.fixtures > 0 && realTimeCount !== status.fixtures) failures.push(`实时赔率不完整：${realTimeCount}/${status.fixtures}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    missingRows: status.rows.filter((row) => !row.usable || (requireCompleteOdds && !row.complete) || (requireRealTime && !row.realTime)),
    policy: { requireAllFixtures, requireCompleteOdds, requireRealTime, freeOddsOnly: process.env.FREE_ODDS_ONLY !== "0" }
  };
}

export function assertMarketRequirements(status, options = {}) {
  const check = checkMarketRequirements(status, options);
  if (!check.ok) {
    const examples = check.missingRows.slice(0, 5).map((row) => `${row.match}（${row.missing.join("、") || row.freshness}）`).join("；");
    throw new Error(`赔率硬门槛未通过：${check.failures.join("；")}。示例缺口：${examples || "无"}`);
  }
  return check;
}

export function normalizeMarketSnapshot(snapshot = {}, fallbackDate, index = 0) {
  const date = String(snapshot.date ?? fallbackDate).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? fallbackDate;
  const homeTeam = String(snapshot.homeTeam ?? snapshot.home ?? "").trim();
  const awayTeam = String(snapshot.awayTeam ?? snapshot.away ?? "").trim();
  const fixtureId = String(snapshot.fixtureId ?? snapshot.fixture_id ?? "").trim();
  if (!fixtureId && (!homeTeam || !awayTeam)) throw new Error(`赔率快照 #${index + 1} 需要 fixtureId 或主客队`);
  return {
    id: snapshot.id ?? `${date}-${fixtureId || normalizeName(`${homeTeam}-${awayTeam}`)}-${index + 1}`,
    date,
    fixtureId,
    sequence: snapshot.sequence ?? "",
    marketType: snapshot.marketType ?? "",
    competition: snapshot.competition ?? "",
    homeTeam,
    awayTeam,
    collectedAt: snapshot.collectedAt ?? snapshot.updatedAt ?? new Date().toISOString(),
    europeanOdds: normalizeOutcomeSet(snapshot.europeanOdds ?? snapshot.euro ?? snapshot.europe),
    asianHandicap: normalizeAsianSet(snapshot.asianHandicap ?? snapshot.asian ?? snapshot.handicap),
    // 竞彩官方让球线(整数,主队视角):保留 500.com 抓到的真实盘口,供让球玩法用真实线而非默认 0。
    jingcaiHandicap: normalizeJingcaiHandicap(snapshot.jingcaiHandicap),
    handicapOdds: normalizeOutcomeSet(snapshot.handicapOdds ?? snapshot.rangqiu ?? snapshot.letBall),
    scoreOdds: normalizeScoreSet(snapshot.scoreOdds ?? snapshot.scoreTop ?? snapshot.correctScoreOdds),
    halfFullOdds: normalizeHalfFullSet(snapshot.halfFullOdds ?? snapshot.halfFullTop ?? snapshot.hafuOdds),
    // 大小球总进球盘(line + 大/小水位)。之前大小球玩法全靠模型派生,接 ESPN 真实盘后有据可依。
    totals: normalizeTotalsSet(snapshot.totals ?? snapshot.overUnder ?? snapshot.ou),
    source: snapshot.source ?? ""
  };
}

export function assessSnapshotCompleteness(snapshot, fixture = null) {
  const missing = [];
  const european = hasInitialAndLatest(snapshot.europeanOdds);
  const asian = hasInitialAndLatest(snapshot.asianHandicap);
  const handicap = hasInitialAndLatest(snapshot.handicapOdds);
  if (!european) missing.push("欧洲赔率");
  if (!asian) missing.push("亚洲盘口");
  const requiresHandicapOdds = (fixture?.marketType ?? snapshot.marketType) !== "shengfucai";
  if (requiresHandicapOdds && !handicap) missing.push("让球胜平负");
  return { usable: european || asian || handicap, complete: european && asian && (!requiresHandicapOdds || handicap), missing };
}

export function assessSnapshotFreshness(snapshot) {
  // 14 场胜负彩(shengfucai)赔率有特殊性:
  //   - 期号停售后赔率永久锁定,不会再变(没有 in-play),
  //   - Sina 等公开源用文章发布时间填 collectedAt,跨日复盘时
  //     即使快照"几小时前",对推荐也仍然有效。
  //   - 因此默认 max age 给 1440 分钟(24 小时),既覆盖跨日多场赛事,
  //     又避免 daily 误报"实时赔率不足"。可用 SFC_ODDS_MAX_AGE_MINUTES 覆盖。
  // 竞彩 jingcai 走 in-play,严格 180 分钟。
  const maxAgeMinutes = Number(snapshot?.marketType === "shengfucai"
    ? process.env.SFC_ODDS_MAX_AGE_MINUTES ?? 1440
    : process.env.ODDS_MAX_AGE_MINUTES ?? 180);
  const collectedAt = snapshot?.collectedAt ? new Date(snapshot.collectedAt) : null;
  if (!collectedAt || Number.isNaN(collectedAt.getTime())) return { realTime: false, status: "赔率采集时间缺失", collectedAt: snapshot?.collectedAt ?? null };
  const ageMinutes = Math.max(0, Math.round((Date.now() - collectedAt.getTime()) / 60000));
  return {
    realTime: ageMinutes <= maxAgeMinutes,
    status: ageMinutes <= maxAgeMinutes ? `实时赔率有效（${ageMinutes}分钟前）` : `赔率已过期（${ageMinutes}分钟前）`,
    ageMinutes,
    maxAgeMinutes,
    collectedAt: snapshot.collectedAt,
  };
}

function normalizeJingcaiHandicap(value) {
  const line = Number(value?.line);
  if (!Number.isFinite(line)) return null;
  return { line, source: value?.source ?? "500.com-jczq" };
}

function normalizeOutcomeSet(value = {}) {
  const initial = normalizeOutcome(value.initial ?? value.open ?? value.start);
  const current = normalizeOutcome(value.current ?? value.live ?? value.now);
  const final = normalizeOutcome(value.final ?? value.close ?? value.latest);
  return initial || current || final ? { initial, current, final } : null;
}

function normalizeOutcome(value = {}) {
  const home = Number(value.home ?? value.h ?? value.win);
  const draw = Number(value.draw ?? value.d ?? value.tie);
  const away = Number(value.away ?? value.a ?? value.loss);
  return [home, draw, away].every((item) => Number.isFinite(item) && item > 1) ? { home, draw, away } : null;
}

function normalizeAsianSet(value = {}) {
  const initial = normalizeAsian(value.initial ?? value.open ?? value.start);
  const current = normalizeAsian(value.current ?? value.live ?? value.now);
  const final = normalizeAsian(value.final ?? value.close ?? value.latest);
  return initial || current || final ? { initial, current, final } : null;
}

function normalizeAsian(value = {}) {
  const line = Number(value.line ?? value.handicap);
  const homeWater = Number(value.homeWater ?? value.home);
  const awayWater = Number(value.awayWater ?? value.away);
  return [line, homeWater, awayWater].some(Number.isFinite) ? { line, homeWater, awayWater } : null;
}

function normalizeScoreSet(value = {}) {
  const rows = Array.isArray(value) ? value : Array.isArray(value.top) ? value.top : [];
  const top = rows
    .map((row) => ({ score: String(row.score ?? row.name ?? "").trim().replace(":", "-"), odds: Number(row.odds ?? row.value) }))
    .filter((row) => /^\d+\s*-\s*\d+$/.test(row.score) && Number.isFinite(row.odds) && row.odds > 1)
    .sort((left, right) => left.odds - right.odds)
    .slice(0, 12);
  return top.length ? { top } : null;
}

function normalizeHalfFullSet(value = {}) {
  const rows = Array.isArray(value) ? value : Array.isArray(value.top) ? value.top : [];
  const top = rows
    .map((row) => ({ halfFull: String(row.halfFull ?? row.name ?? "").trim(), odds: Number(row.odds ?? row.value) }))
    .filter((row) => row.halfFull && Number.isFinite(row.odds) && row.odds > 1)
    .sort((left, right) => left.odds - right.odds)
    .slice(0, 12);
  return top.length ? { top } : null;
}

function normalizeTotalsSet(value = {}) {
  if (value == null) return null;
  // 允许直接传 { line, over, under }(无 initial/current 包裹)。
  const flat = value.line != null && value.initial == null && value.current == null ? { initial: value, current: value } : value;
  const initial = normalizeTotalsPoint(flat.initial ?? flat.open);
  const current = normalizeTotalsPoint(flat.current ?? flat.close ?? flat.latest);
  return initial || current ? { initial, current } : null;
}

function normalizeTotalsPoint(value = {}) {
  if (value == null) return null;
  const line = Number(value.line ?? value.total ?? value.ou);
  if (!Number.isFinite(line)) return null;
  const over = Number(value.over ?? value.overWater ?? value.overOdds);
  const under = Number(value.under ?? value.underWater ?? value.underOdds);
  return { line, over: Number.isFinite(over) && over > 1 ? over : null, under: Number.isFinite(under) && under > 1 ? under : null };
}

function hasInitialAndLatest(value) {
  return Boolean(value?.initial && (value.current || value.final));
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
