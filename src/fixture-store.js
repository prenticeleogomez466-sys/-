import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataSubdir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const fixtureDir = getDataSubdir("fixtures");

export function loadFixtures(date = todayIso()) {
  ensureFixtureDir();
  const normalizedDate = safeDate(date);
  const filePath = join(fixtureDir, `${normalizedDate}.json`);
  if (!existsSync(filePath)) return { date: normalizedDate, source: "empty", importedAt: null, fixtures: [] };
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  return {
    date: safeDate(payload.date ?? normalizedDate),
    source: payload.source ?? "fixture-json",
    importedAt: payload.importedAt ?? null,
    fixtures: fixtures.map((fixture, index) => normalizeFixture(fixture, normalizedDate, index))
  };
}

export function saveFixtures(date, fixtures, metadata = {}) {
  ensureFixtureDir();
  const normalizedDate = safeDate(date);
  const filePath = join(fixtureDir, `${normalizedDate}.json`);
  const incoming = Array.isArray(fixtures) ? fixtures : [];

  // 数据保护:失败的同步(源返回 0)不得用空集覆盖已有非空赛事(会毁当天选票)。
  // 默认拒绝清空并保留旧数据;确需清空时显式传 metadata.allowEmpty=true。
  if (incoming.length === 0 && existsSync(filePath)) {
    let existing = [];
    try { const prev = JSON.parse(readFileSync(filePath, "utf8")); existing = Array.isArray(prev) ? prev : prev.fixtures ?? []; } catch { existing = []; }
    if (existing.length > 0 && !metadata.allowEmpty) {
      try { writeFileSync(`${filePath}.bak`, readFileSync(filePath, "utf8"), "utf8"); } catch {}
      return { date: normalizedDate, source: "preserved-existing", importedAt: null, fixtures: existing, refusedEmptyOverwrite: true };
    }
  }

  const payload = {
    date: normalizedDate,
    source: metadata.source ?? "manual",
    importedAt: new Date().toISOString(),
    fixtures: incoming.map((fixture, index) => normalizeFixture(fixture, normalizedDate, index))
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * 同一场比赛跨业务日文件的**稳定键**(2026-06-10 缺陷#10):
 * 同场在今天/昨天两个业务日文件里 id 不同(id 内嵌业务日,如 jc-2026-06-09-4001 vs
 * jc500-2026-06-10-4001),按 id 去重必失效。改用"真实赛日(kickoff 内嵌日期优先)+主客队"。
 */
export function stableFixtureKey(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  const matchDate = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0]
    ?? (String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "");
  return `${matchDate}|${String(fixture?.homeTeam ?? "").trim()}|${String(fixture?.awayTeam ?? "").trim()}`;
}

/**
 * 合并多个业务日的 fixtures 并按稳定键去重(先到先得,调用方把更新的业务日放前面)。
 * 用途:跨午夜开球场归前一业务日文件 → 首发盯防/临场捕获需今天+昨天合并视图;
 * 在售窗口重叠时同一场出现在两个文件,稳定键去重防双推/双捕。
 */
export function mergeFixtureLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const f of Array.isArray(list) ? list : []) {
      const key = stableFixtureKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

export function listFixtureDates() {
  ensureFixtureDir();
  return readdirSync(fixtureDir).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort().reverse();
}

export function normalizeFixture(fixture = {}, fallbackDate = todayIso(), index = 0) {
  const date = safeDate(fixture.date ?? fallbackDate);
  const homeTeam = String(fixture.homeTeam ?? fixture.home ?? fixture.host ?? "").trim();
  const awayTeam = String(fixture.awayTeam ?? fixture.away ?? fixture.guest ?? "").trim();
  if (!homeTeam || !awayTeam) throw new Error(`第 ${index + 1} 场缺少主队或客队`);
  return {
    id: fixture.id ?? fixture.fixtureId ?? makeFixtureId(date, homeTeam, awayTeam, index),
    date,
    kickoff: fixture.kickoff ?? fixture.time ?? "",
    competition: fixture.competition ?? fixture.league ?? "未知赛事",
    homeTeam,
    awayTeam,
    round: fixture.round ?? "",
    marketType: fixture.marketType ?? fixture.type ?? "daily",
    sequence: fixture.sequence ?? fixture.no ?? index + 1,
    tags: Array.isArray(fixture.tags) ? fixture.tags : [],
    notes: fixture.notes ?? "",
    source: fixture.source ?? "",
    officialStatus: fixture.officialStatus ?? "",
    officialFixtureId: fixture.officialFixtureId ?? null,
    result: normalizeResult(fixture.result),
    // 历史市场维(去 vig 隐含概率,非实时快照)。一等字段,供半全场/大小球/数据变化
    // 小模型自主读取。缺失则 null,小模型据此判 available,绝不编造。
    marketHistorical: normalizeMarketHistorical(fixture.marketHistorical)
  };
}

function normalizeMarketHistorical(mh) {
  if (!mh || typeof mh !== "object") return null;
  const probs = (p) => {
    if (!p || typeof p !== "object") return null;
    const h = Number(p.home), d = Number(p.draw), a = Number(p.away);
    return [h, d, a].every(Number.isFinite) ? { home: h, draw: d, away: a } : null;
  };
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const openProbs = probs(mh.openProbs);
  const closeProbs = probs(mh.closeProbs);
  const overProb = numOrNull(mh.overProb);
  const overProbClose = numOrNull(mh.overProbClose);
  const asian = mh.asian && typeof mh.asian === "object" ? mh.asian : null;
  // 全维皆空则不留壳
  if (!openProbs && !closeProbs && overProb == null && overProbClose == null && !asian) return null;
  return { openProbs, closeProbs, overProb, overProbClose, asian };
}

function normalizeResult(result) {
  if (!result) return null;
  const home = Number(result.home ?? result.homeGoals);
  const away = Number(result.away ?? result.awayGoals);
  const halfHome = Number(result.halfHome ?? result.htHome ?? result.halfTimeHome);
  const halfAway = Number(result.halfAway ?? result.htAway ?? result.halfTimeAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away, halfHome: Number.isFinite(halfHome) ? halfHome : null, halfAway: Number.isFinite(halfAway) ? halfAway : null };
}

function makeFixtureId(date, homeTeam, awayTeam, index) {
  return `${date}-${safeName(homeTeam)}-vs-${safeName(awayTeam)}-${index + 1}`;
}

function safeName(value) {
  return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function safeDate(value) {
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`无效日期：${value}`);
  return match[0];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function ensureFixtureDir() {
  mkdirSync(fixtureDir, { recursive: true });
}
