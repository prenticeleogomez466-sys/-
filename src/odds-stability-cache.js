/**
 * Odds Stability Cache(赔率稳定缓存 — 消除"每次抓取效果都不一样")
 * ────────────────────────────────────────────────────────────────
 * 问题:竞彩/胜负彩盘口靠多个公开 HTML 源抓取,每个源都可能"这次成、下次挂"
 * (反爬节流、网络抖动、文章发现失败)。结果是同一批比赛连抓两次,覆盖的场次、
 * 拿到的盘口质量都不同 —— 用户看到的推荐随之漂移。
 *
 * 本模块提供一层 **单调(monotonic)last-good 缓存**:
 *   1. 每抓到一个"真实"市场值(欧赔/亚盘/竞彩让球线/让球胜平负),按
 *      日期+主客队 落盘存为该场该市场的 last-good,并打质量分。
 *   2. 下次抓取后,任何 **缺失或质量更低**(例:被派生 fallback 顶替)的市场,
 *      用缓存里质量更高的 last-good 回填。
 *
 * 效果:同一批比赛,只要历史上某次抓到过真实盘口,之后每次输出都 **复现**
 * 那份最高质量数据 —— 不再忽好忽坏。缓存只升不降(质量更高的新值才覆盖)。
 *
 * 安全性:纯加法。只回填"缺失或更差"的市场,绝不覆盖更优的实时值;
 * 可用 ODDS_STABILITY_CACHE_ENABLED="0" 整体关闭。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { normalizeMarketSnapshot } from "./market-data-store.js";

const CACHE_FILE = "stability-cache.json";

function cacheePath() {
  const dir = getDataSubdir("market");
  mkdirSync(dir, { recursive: true });
  return join(dir, CACHE_FILE);
}

function normKey(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9一-鿿]+/g, "");
}

/** 场次身份键:日期 + 主 + 客。日期隔离,避免把旧交锋的盘口漏进来。 */
export function fixtureCacheKey(snapshotOrFixture, date) {
  const d = String(snapshotOrFixture.date ?? date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? date ?? "";
  return `${d}__${normKey(snapshotOrFixture.homeTeam)}__${normKey(snapshotOrFixture.awayTeam)}`;
}

export function loadStabilityCache() {
  const path = cacheePath();
  if (!existsSync(path)) return { version: 1, updatedAt: null, entries: {} };
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return { version: payload.version ?? 1, updatedAt: payload.updatedAt ?? null, entries: payload.entries ?? {} };
  } catch {
    return { version: 1, updatedAt: null, entries: {} };
  }
}

function writeStabilityCache(cache, nowIso) {
  const path = cacheePath();
  writeFileSync(path, `${JSON.stringify({ version: 1, updatedAt: nowIso, entries: cache.entries }, null, 2)}\n`, "utf8");
}

// ── 质量评分:真实双向盘口 > 单向/派生 fallback > 无 ───────────────────────
function isFallbackSource(source) {
  return /fallback|派生|derive|model/i.test(String(source ?? ""));
}

function europeanQuality(market, source) {
  const cur = market?.current ?? market?.initial;
  if (!cur) return 0;
  // 主客赔率完全相等通常是派生/对称占位,非真实市场;质量降一档。
  const symmetric = Number(cur.home) === Number(cur.away);
  if (isFallbackSource(source) || symmetric) return 1;
  return market?.initial && market?.current ? 3 : 2;
}

function genericQuality(market, source) {
  if (!market) return 0;
  if (isFallbackSource(source)) return 1;
  return market?.initial && market?.current ? 3 : 2;
}

function jingcaiHandicapQuality(value, source) {
  if (!value || !Number.isFinite(Number(value.line))) return 0;
  return isFallbackSource(source) ? 1 : 3;
}

function totalsQuality(market, source) {
  const point = market?.current ?? market?.initial;
  if (!point || !Number.isFinite(Number(point.line))) return 0;
  if (isFallbackSource(source)) return 1;
  // 有真实大/小水位算满分,只有 line 算次一档(仍比派生强)。
  const hasWater = Number(point.over) > 1 || Number(point.under) > 1;
  return hasWater ? 3 : 2;
}

const MARKETS = [
  { field: "europeanOdds", quality: europeanQuality },
  { field: "asianHandicap", quality: genericQuality },
  { field: "handicapOdds", quality: genericQuality },
  { field: "jingcaiHandicap", quality: jingcaiHandicapQuality },
  { field: "totals", quality: totalsQuality }
];

/**
 * 用本批快照刷新缓存:每个市场,质量更高的真实值才覆盖 last-good。
 * @returns {{stored:number, cache:object}}
 */
export function updateStabilityCache(date, snapshots, nowIso = new Date().toISOString()) {
  const cache = loadStabilityCache();
  let stored = 0;
  for (const snapshot of snapshots ?? []) {
    if (!snapshot?.homeTeam || !snapshot?.awayTeam) continue;
    const key = fixtureCacheKey(snapshot, date);
    const entry = cache.entries[key] ?? { homeTeam: snapshot.homeTeam, awayTeam: snapshot.awayTeam, date: snapshot.date ?? date, markets: {} };
    for (const { field, quality } of MARKETS) {
      const value = snapshot[field];
      const q = quality(value, snapshot.source);
      if (q <= 0) continue;
      const prev = entry.markets[field];
      if (!prev || q >= prev.quality) {
        entry.markets[field] = { value, quality: q, source: snapshot.source ?? "", collectedAt: snapshot.collectedAt ?? nowIso, storedAt: nowIso };
        stored += 1;
      }
    }
    cache.entries[key] = entry;
  }
  if (stored) writeStabilityCache(cache, nowIso);
  return { stored, cache };
}

/**
 * 用缓存回填:对每个 fixture,缺失或质量更低的市场,用 last-good 顶上。
 * 绝不覆盖质量 ≥ 缓存的实时值。
 * @returns {{snapshots:Array, backfilled:number, details:Array}}
 */
export function backfillFromStabilityCache(date, snapshots, fixtures, nowIso = new Date().toISOString()) {
  const cache = loadStabilityCache();
  const byKeyFixture = new Map(fixtures.map((fixture) => [fixtureCacheKey(fixture, date), fixture]));
  const result = [];
  const details = [];
  let backfilled = 0;
  const indexByFixtureId = new Map();
  for (const snapshot of snapshots) indexByFixtureId.set(snapshot.fixtureId || `${snapshot.homeTeam}-${snapshot.awayTeam}`, snapshot);

  // 1) 在已有快照上回填缺/弱市场
  for (const snapshot of snapshots) {
    const key = fixtureCacheKey(snapshot, date);
    const entry = cache.entries[key];
    const patched = { ...snapshot };
    if (entry) {
      for (const { field, quality } of MARKETS) {
        const cached = entry.markets[field];
        if (!cached) continue;
        const liveQ = quality(snapshot[field], snapshot.source);
        if (cached.quality > liveQ) {
          patched[field] = cached.value;
          patched.collectedAt = snapshot.collectedAt ?? cached.collectedAt;
          patched.source = mergeSource(snapshot.source, `稳定缓存(${cached.source || "last-good"})`);
          backfilled += 1;
          details.push({ fixtureId: snapshot.fixtureId, market: field, from: "stability-cache", quality: cached.quality, replacedQuality: liveQ });
        }
      }
    }
    result.push(patched);
  }

  // 2) 完全没有快照的 fixture,若缓存里有,凭缓存造一条
  for (const [key, fixture] of byKeyFixture) {
    const already = result.some((snapshot) => snapshot.fixtureId === fixture.id);
    if (already) continue;
    const entry = cache.entries[key];
    if (!entry || !Object.keys(entry.markets).length) continue;
    const base = {
      date: fixture.date ?? date,
      fixtureId: fixture.id,
      sequence: fixture.sequence,
      marketType: fixture.marketType,
      competition: fixture.competition,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      collectedAt: nowIso,
      source: "稳定缓存(last-good 整场回填)"
    };
    let oldest = nowIso;
    for (const { field } of MARKETS) {
      const cached = entry.markets[field];
      if (!cached) continue;
      base[field] = cached.value;
      if (cached.collectedAt && cached.collectedAt < oldest) oldest = cached.collectedAt;
    }
    base.collectedAt = oldest;
    result.push(normalizeMarketSnapshot(base, date));
    backfilled += 1;
    details.push({ fixtureId: fixture.id, market: "*", from: "stability-cache-full", quality: 0, replacedQuality: -1 });
  }

  return { snapshots: result, backfilled, details };
}

function mergeSource(...sources) {
  const parts = [];
  for (const source of sources) {
    for (const piece of String(source ?? "").split("+")) {
      const trimmed = piece.trim();
      if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
    }
  }
  return parts.join("+");
}

export function stabilityCacheStats() {
  const cache = loadStabilityCache();
  const entries = Object.values(cache.entries);
  const byMarket = {};
  for (const entry of entries) {
    for (const [field, market] of Object.entries(entry.markets ?? {})) {
      byMarket[field] = byMarket[field] ?? { count: 0, real: 0 };
      byMarket[field].count += 1;
      if ((market.quality ?? 0) >= 2) byMarket[field].real += 1;
    }
  }
  return { fixtures: entries.length, updatedAt: cache.updatedAt, byMarket };
}
