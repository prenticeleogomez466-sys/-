/**
 * 授权数据源统一接入框架
 * ──────────────────────────────────────────────────
 * 给 INJURY/LINEUP/XG 等"顶级就绪缺口"提供:
 *
 *   1. URL 模板:支持 {date}, {fixtureId}, {homeTeam}, {awayTeam}, {homeTeamAlias}, {awayTeamAlias}
 *      占位符,用户可以配置 https://api.x.com/injuries/{fixtureId}.json 这种 per-fixture URL,
 *      也可以配置 https://api.x.com/injuries/{date}.json 这种 bulk URL。
 *
 *   2. 共享 canonicalTeamName:用 team-aliases 做球队归一,提高 bulk URL 的匹配率。
 *
 *   3. 本地缓存:同一 layer + date + fixture 的请求会在 TTL 内复用,
 *      减少 API 配额消耗;TTL 默认 360 分钟,可用 AUTHORIZED_SOURCE_TTL_MINUTES 覆盖。
 *
 *   4. 不抛错:任何 fetch / parse 失败都返回 ok=false + warning,不阻断 daily 流程。
 *      上游 advanced-data-runner 的 derivedXxxLayer 会继续兜底。
 *
 * 用法(在 advanced-data-runner.js 里):
 *
 *   import { fetchAuthorizedFixtureLayer } from "./authorized-source-fetcher.js";
 *
 *   const injuries = await fetchAuthorizedFixtureLayer({
 *     layerKey: "injuries",
 *     envKey: "INJURY_SOURCE_URL",
 *     date, fixtures, fetchImpl, env,
 *     extractRows: (payload) => Array.isArray(payload) ? payload : payload.injuries ?? payload.data ?? []
 *   });
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { canonicalTeamName } from "./team-aliases.js";

const DEFAULT_TTL_MINUTES = 360;

export async function fetchAuthorizedFixtureLayer(opts) {
  const {
    layerKey,
    envKey,
    date,
    fixtures,
    fetchImpl,
    env = process.env,
    extractRows = defaultExtractRows,
    headers,
  } = opts;

  const url = env[envKey];
  if (!url) return skipped(layerKey, `缺 ${envKey}`);
  if (typeof fetchImpl !== "function") return skipped(layerKey, "fetch 不可用");

  const ttlMinutes = Number(env.AUTHORIZED_SOURCE_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
  const requestHeaders = resolveHeaders(envKey, headers, env);
  const isPerFixture = /\{(fixtureId|homeTeam|awayTeam|homeTeamAlias|awayTeamAlias)\}/.test(url);

  const fixtureData = {};
  const errors = [];

  if (isPerFixture) {
    // Per-fixture 模式:为每场单独请求,带缓存
    await Promise.all(fixtures.map(async (fixture) => {
      const targetUrl = expandUrlTemplate(url, { date, fixture });
      const cacheKey = `${layerKey}-${date}-${shortKey(fixture.id || `${fixture.homeTeam}-${fixture.awayTeam}`)}`;
      try {
        const payload = await fetchCached(cacheKey, ttlMinutes, () => fetchJson(fetchImpl, targetUrl, requestHeaders));
        if (payload) fixtureData[fixture.id] = payload;
      } catch (error) {
        errors.push({ fixtureId: fixture.id, error: error.message });
      }
    }));
  } else {
    // Bulk URL 模式:一次拿全量,用 canonicalTeamName 匹配
    const expanded = expandUrlTemplate(url, { date });
    const cacheKey = `${layerKey}-${date}-bulk`;
    try {
      const payload = await fetchCached(cacheKey, ttlMinutes, () => fetchJson(fetchImpl, expanded, requestHeaders));
      const rows = extractRows(payload) ?? [];
      for (const fixture of fixtures) {
        const matched = rows.find((row) => matchesFixture(row, fixture));
        if (matched) fixtureData[fixture.id] = matched;
      }
    } catch (error) {
      errors.push({ scope: "bulk", error: error.message });
    }
  }

  const count = Object.keys(fixtureData).length;
  const warningParts = [];
  if (!count && errors.length) warningParts.push(`授权源访问失败 ${errors.length} 次,见 errors`);
  if (!count && !errors.length) warningParts.push("源已配置但未匹配今日赛程");

  return {
    ok: count > 0,
    source: url,
    count,
    fixtureData,
    errors: errors.length ? errors : undefined,
    warning: warningParts.length ? warningParts.join("; ") : null,
    cacheStrategy: isPerFixture ? "per-fixture" : "bulk",
    ttlMinutes,
  };
}

export function expandUrlTemplate(template, { date, fixture }) {
  let url = String(template).replaceAll("{date}", encodeURIComponent(date ?? ""));
  if (fixture) {
    url = url
      .replaceAll("{fixtureId}", encodeURIComponent(fixture.id ?? ""))
      .replaceAll("{homeTeam}", encodeURIComponent(fixture.homeTeam ?? ""))
      .replaceAll("{awayTeam}", encodeURIComponent(fixture.awayTeam ?? ""))
      .replaceAll("{homeTeamAlias}", encodeURIComponent(canonicalTeamName(fixture.homeTeam) ?? ""))
      .replaceAll("{awayTeamAlias}", encodeURIComponent(canonicalTeamName(fixture.awayTeam) ?? ""));
  }
  return url;
}

export function matchesFixture(row, fixture) {
  const rowHome = canonicalTeamName(row.homeTeam ?? row.home ?? row.HomeTeam ?? row.host ?? "");
  const rowAway = canonicalTeamName(row.awayTeam ?? row.away ?? row.AwayTeam ?? row.guest ?? "");
  if (!rowHome || !rowAway) return false;
  const fixHome = canonicalTeamName(fixture.homeTeam);
  const fixAway = canonicalTeamName(fixture.awayTeam);
  return rowHome === fixHome && rowAway === fixAway;
}

// ───── 缓存层 ─────

function cacheDir() {
  return getDataSubdir("authorized-cache");
}

function cachePath(key) {
  return join(cacheDir(), `${key}.json`);
}

async function fetchCached(key, ttlMinutes, fetcher) {
  const path = cachePath(key);
  if (existsSync(path)) {
    const ageMinutes = (Date.now() - statSync(path).mtimeMs) / 60000;
    if (ageMinutes < ttlMinutes) {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* fall through to refetch */ }
    }
  }
  const fresh = await fetcher();
  if (fresh != null) {
    mkdirSync(cacheDir(), { recursive: true });
    try { writeFileSync(path, `${JSON.stringify(fresh)}\n`, "utf8"); } catch { /* cache write best-effort */ }
  }
  return fresh;
}

// ───── 内部工具 ─────

function defaultExtractRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.fixtures ?? payload?.data ?? payload?.injuries ?? payload?.lineups ?? payload?.results ?? [];
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "football-ai-copilot/authorized-source", Accept: "application/json", ...headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 140)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function resolveHeaders(envKey, override, env) {
  const fromEnv = {};
  // 约定:对应 envKey 同名 + _AUTH_HEADER 的环境变量是 "Header-Name: value" 形式
  // 例如 INJURY_SOURCE_URL 配 INJURY_SOURCE_AUTH_HEADER="Authorization: Bearer abc"
  const authHeaderRaw = env[`${envKey.replace(/_URL$/, "")}_AUTH_HEADER`];
  if (authHeaderRaw) {
    const idx = authHeaderRaw.indexOf(":");
    if (idx > 0) {
      const name = authHeaderRaw.slice(0, idx).trim();
      const value = authHeaderRaw.slice(idx + 1).trim();
      if (name && value) fromEnv[name] = value;
    }
  }
  return { ...fromEnv, ...(override ?? {}) };
}

function shortKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function skipped(source, reason) {
  return { ok: false, source, count: 0, fixtureData: {}, skipped: true, warning: reason };
}
