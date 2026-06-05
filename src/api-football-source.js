/**
 * API-Football(api-sports.io)免费层接入 —— 球队"近期状态/主客场打法"特征源(2026-06-02)。
 * ════════════════════════════════════════════════════════════════════
 * 用户要求接入免费球队特点源(优先 API-Football:官方 REST、**无反爬**、免费 100 req/天)。
 * 见 [[reference-free-team-data-sources]]。
 *
 * 设计取舍(诚实、不踩坑):
 *  - 不用 /teams/statistics(需 league+season,国家队赛难定 league);改用 端点 /fixtures(team,last)
 *    —— league-agnostic,国家队/俱乐部都能拿近 N 场真实赛果,据此算 状态/进失球/主客拆分。
 *  - 第一版**只做描述性增强**:产出存进 advancedData.fixtures[].data.**apiFootball**(独立键,
 *    NOT data.form —— data.form 会被 adjustProbabilitiesWithAdvancedData 动概率方向)。
 *    只喂情景层(scenario-synthesizer)做"近期状态"维度,**不改 pick/概率**。
 *    要把它接进概率调整,必须先回测证增益(遵 feedback-hitrate-closed-loop),不在本版。
 *  - team id 解析(/teams?search=)结果落盘缓存,省 100/天预算。
 *  - 无 key 优雅降级:apiFootballConfigured()=false,所有取数返回 null,模型照常诚实跑(数据缺失单列)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { readLocalEnv } from "./source-credentials.js";

const BASE = "https://v3.football.api-sports.io";
const cacheDir = getDataSubdir("api-football");
const teamCachePath = join(cacheDir, "team-id-cache.json");

export function apiFootballKey(env = process.env) {
  if (env.API_FOOTBALL_KEY) return env.API_FOOTBALL_KEY;
  // local.env 文件兜底只在使用默认 process.env 时启用;显式注入 env(测试)不读文件,保证可隔离可注入。
  if (env === process.env) return readLocalEnv()[`API_FOOTBALL_KEY`] || "";
  return "";
}
export function apiFootballConfigured(env = process.env) {
  return Boolean(apiFootballKey(env));
}

/* ── 低层请求(带 key header + 速率剩余感知)── */
export async function apiFootballGet(path, params = {}, opts = {}) {
  const env = opts.env ?? process.env;
  const key = apiFootballKey(env);
  if (!key) return { ok: false, reason: "no-key", response: [] };
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no-fetch", response: [] };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetchImpl(url, { headers: { "x-apisports-key": key, "User-Agent": "football-ai-copilot/api-football" } });
    const remaining = Number(res.headers?.get?.("x-ratelimit-requests-remaining"));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, errors: body?.errors, response: [], remaining };
    // api-sports 在 200 里用 errors 字段报配额/参数错
    const errs = body?.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
      return { ok: false, reason: "api-errors", errors: errs, response: [], remaining };
    }
    return { ok: true, response: body?.response ?? [], remaining, results: body?.results };
  } catch (e) {
    return { ok: false, reason: e.message, response: [] };
  }
}

/* ── team id 解析(落盘缓存)── */
function loadTeamCache() {
  try { return existsSync(teamCachePath) ? JSON.parse(readFileSync(teamCachePath, "utf8")) : {}; }
  catch { return {}; }
}
function saveTeamCache(cache) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(teamCachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}
const normName = (s) => String(s ?? "").trim().toLowerCase();

export async function resolveTeamId(name, opts = {}) {
  const cache = opts.cache ?? loadTeamCache();
  const k = normName(name);
  if (!k) return null;
  if (cache[k] != null) return cache[k]; // 命中缓存(含负缓存 0/null 占位)
  const r = await apiFootballGet("/teams", { search: name }, opts);
  if (!r.ok || !r.response.length) { cache[k] = null; if (!opts.cache) saveTeamCache(cache); return null; }
  // 取完全/最接近匹配
  const exact = r.response.find((x) => normName(x.team?.name) === k);
  const chosen = exact ?? r.response[0];
  const id = chosen?.team?.id ?? null;
  cache[k] = id;
  cache[`__name__${id}`] = chosen?.team?.name ?? name;
  if (!opts.cache) saveTeamCache(cache);
  return id;
}

/* ── 近 N 场赛果 → 球队近期状态/打法特征 ── */
export function normalizeRecentForm(teamId, fixtures, opts = {}) {
  const finished = (fixtures ?? []).filter((f) => ["FT", "AET", "PEN"].includes(f?.fixture?.status?.short));
  if (!finished.length) return null;
  // 时间倒序,取最近 N
  finished.sort((a, b) => new Date(b.fixture?.date ?? 0) - new Date(a.fixture?.date ?? 0));
  const recent = finished.slice(0, opts.n ?? 10);
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  let homeN = 0, homeGf = 0, homeGa = 0, awayN = 0, awayGf = 0, awayGa = 0;
  let cleanSheet = 0, failedToScore = 0;
  const formChars = [];
  for (const f of recent) {
    const isHome = f.teams?.home?.id === teamId;
    const my = isHome ? f.goals?.home : f.goals?.away;
    const opp = isHome ? f.goals?.away : f.goals?.home;
    if (!Number.isFinite(my) || !Number.isFinite(opp)) continue;
    gf += my; ga += opp;
    if (my > opp) { w++; formChars.push("W"); } else if (my === opp) { d++; formChars.push("D"); } else { l++; formChars.push("L"); }
    if (opp === 0) cleanSheet++;
    if (my === 0) failedToScore++;
    if (isHome) { homeN++; homeGf += my; homeGa += opp; } else { awayN++; awayGf += my; awayGa += opp; }
  }
  const n = w + d + l;
  if (!n) return null;
  const avg = (x, c) => (c > 0 ? Math.round((x / c) * 100) / 100 : null);
  // 状态分 0..1:近场加权(最近权重高),W=1/D=0.5/L=0
  let wsum = 0, wtot = 0;
  formChars.forEach((c, i) => { const wgt = recent.length - i; wtot += wgt; wsum += (c === "W" ? 1 : c === "D" ? 0.5 : 0) * wgt; });
  const formScore = wtot > 0 ? Math.round((wsum / wtot) * 1000) / 1000 : null;
  return {
    teamId,
    matches: n,
    form: formChars.join(""),          // 最近在前,如 "WWDLW"
    formScore,                          // 0..1 加权近期状态
    record: { w, d, l },
    goalsForAvg: avg(gf, n),
    goalsAgainstAvg: avg(ga, n),
    homeGoalsForAvg: avg(homeGf, homeN),
    homeGoalsAgainstAvg: avg(homeGa, homeN),
    awayGoalsForAvg: avg(awayGf, awayN),
    awayGoalsAgainstAvg: avg(awayGa, awayN),
    cleanSheetRate: Math.round((cleanSheet / n) * 100) / 100,
    failedToScoreRate: Math.round((failedToScore / n) * 100) / 100,
  };
}

export async function fetchTeamRecentForm(teamId, opts = {}) {
  if (!teamId) return null;
  const r = await apiFootballGet("/fixtures", { team: teamId, last: opts.last ?? 10 }, opts);
  if (!r.ok) return null;
  return normalizeRecentForm(teamId, r.response, { n: opts.last ?? 10 });
}

/* ── 把一场两队特征拼成 advancedData 的 per-fixture data.apiFootball ── */
export function buildFixtureTeamTraits(homeTrait, awayTrait) {
  if (!homeTrait && !awayTrait) return null;
  const out = { home: homeTrait ?? null, away: awayTrait ?? null, source: "api-football" };
  if (homeTrait && awayTrait && Number.isFinite(homeTrait.formScore) && Number.isFinite(awayTrait.formScore)) {
    out.formDiff = Math.round((homeTrait.formScore - awayTrait.formScore) * 1000) / 1000; // +主队近况更好
  }
  return out;
}
