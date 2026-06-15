import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getDataDir, getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = getDataDir();
const exportDir = getExportDir();
const localEnvPath = join(dataDir, "local.env");

export const SOURCE_CREDENTIALS = [
  { key: "ODDS_API_KEY", name: "The Odds API 免费层", layer: "免费实时欧赔/盘口", secret: true, liveCheck: "the-odds-api", free: true },
  { key: "ODDS_API_IO_KEY", name: "Odds-API.io 免费层", layer: "免费实时欧赔/盘口", secret: true, liveCheck: "odds-api-io", free: true },
  { key: "API_FOOTBALL_KEY", name: "API-Football 免费层", layer: "免费赛程/赛果/部分赔率", secret: true, liveCheck: "api-football", free: true },
  { key: "FOOTBALL_DATA_ORG_TOKEN", name: "football-data.org 免费层", layer: "免费赛程/赛果/部分赛前赔率", secret: true, liveCheck: "football-data-org", free: true },
  { key: "FOOTBALL_DATA_CO_UK_ENABLED", name: "football-data.co.uk 免费 CSV", layer: "免费历史/赛前 CSV 赔率", secret: false, liveCheck: "football-data-co-uk", free: true },
  { key: "OPENLIGADB_ENABLED", name: "OpenLigaDB 免费公开 API", layer: "免费德语区赛程/赛果", secret: false, liveCheck: "openligadb", free: true },
  { key: "SCOREBAT_ENABLED", name: "ScoreBat 免费视频/资讯 API", layer: "免费比赛视频/资讯上下文", secret: false, liveCheck: "scorebat", free: true },
  { key: "STATSBOMB_OPEN_DATA_ENABLED", name: "StatsBomb Open Data", layer: "免费历史事件/xG训练数据", secret: false, liveCheck: "statsbomb-open-data", free: true },
  { key: "OPENFOOTBALL_DATA_ENABLED", name: "openfootball GitHub 数据", layer: "免费历史赛程/赛果", secret: false, liveCheck: "openfootball", free: true },
  { key: "INJURY_SOURCE_URL", name: "授权伤停 JSON 源", layer: "伤停/停赛", secret: false, liveCheck: "url", free: true },
  { key: "LINEUP_SOURCE_URL", name: "授权首发 JSON 源", layer: "预计/确认首发", secret: false, liveCheck: "url", free: true },
  { key: "XG_SOURCE_URL", name: "授权 xG JSON 源", layer: "xG/射门质量", secret: false, liveCheck: "url", free: true },
  { key: "ODDS_JSON_URL", name: "自有免费 JSON 赔率源", layer: "自有/公开许可 JSON 赔率", secret: false, liveCheck: "url", free: true },
  { key: "ODDS_CSV_URL", name: "自有免费 CSV 赔率源", layer: "自有/公开许可 CSV 赔率", secret: false, liveCheck: "url", free: true }
];

export function readLocalEnv(path = localEnvPath) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) env[parsed.key] = parsed.value;
  }
  return env;
}

export function validateProductionCredentials(env = process.env) {
  const freeOnly = env.FREE_ODDS_ONLY !== "0";
  const hasFreeOddsSource = Boolean(
    env.ODDS_API_KEY ||
      env.ODDS_API_IO_KEY ||
      env.API_FOOTBALL_KEY ||
      env.ODDS_JSON_URL ||
      env.ODDS_CSV_URL ||
      env.SINA_SFC_ODDS_ENABLED === "1" ||
      env.FOOTBALL_DATA_CO_UK_ENABLED === "1"
  );
  const hasFixturesResults = Boolean(env.API_FOOTBALL_KEY || env.FOOTBALL_DATA_ORG_TOKEN || env.FOOTBALL_DATA_CO_UK_ENABLED === "1" || env.CHINA_OFFICIAL_WEB_ENABLED === "1");
  const hasHandicapOdds = Boolean(env.ODDS_JSON_URL || env.ODDS_CSV_URL || env.API_FOOTBALL_KEY || env.ODDS_API_IO_KEY || env.FOOTBALL_DATA_CO_UK_ENABLED === "1" || env.SINA_SFC_ODDS_ENABLED === "1");
  const requireHandicap = freeOnly ? env.FREE_MODE_REQUIRE_HANDICAP === "1" : env.ODDS_REQUIRE_COMPLETE !== "0";
  const failures = [];

  if (!hasFreeOddsSource) failures.push("缺少免费赔率源：请配置 ODDS_API_KEY、ODDS_API_IO_KEY、API_FOOTBALL_KEY、ODDS_JSON_URL/CSV，或启用 FOOTBALL_DATA_CO_UK_ENABLED=1");
  if (requireHandicap && !hasHandicapOdds) failures.push("当前要求让球/盘口赔率，但免费源尚未提供可用让球数据");
  if (!hasFixturesResults) failures.push("缺少免费赛程/赛果源：请配置 API_FOOTBALL_KEY、FOOTBALL_DATA_ORG_TOKEN，或启用 FOOTBALL_DATA_CO_UK_ENABLED=1");

  return {
    ok: failures.length === 0,
    failures,
    mode: freeOnly ? "free-only" : "custom",
    requirements: {
      freeOddsSource: hasFreeOddsSource,
      handicapOdds: hasHandicapOdds,
      fixturesResults: hasFixturesResults,
      requireHandicap
    }
  };
}

export async function buildCredentialStatus(options = {}) {
  const env = { ...process.env, ...readLocalEnv(options.path ?? localEnvPath), ...(options.env ?? {}) };
  const rows = SOURCE_CREDENTIALS.map((credential) => ({
    key: credential.key,
    name: credential.name,
    layer: credential.layer,
    free: credential.free,
    configured: isConfigured(credential.key, env[credential.key]),
    value: isConfigured(credential.key, env[credential.key]) ? maskCredentialValue(env[credential.key], credential.secret) : "",
    live: { checked: false, ok: null, status: "未执行联网检查" }
  }));
  const policy = validateProductionCredentials(env);
  if (options.live) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    await Promise.all(rows.map(async (row) => {
      const credential = SOURCE_CREDENTIALS.find((item) => item.key === row.key);
      row.live = await checkCredentialLive(credential, env, fetchImpl);
    }));
  }
  return { ok: policy.ok, generatedAt: new Date().toISOString(), policy, rows };
}

function isConfigured(key, value) {
  if (key.endsWith("_ENABLED")) return String(value ?? "") === "1";
  return Boolean(value);
}

export function writeCredentialStatus(status) {
  mkdirSync(exportDir, { recursive: true });
  const jsonPath = join(exportDir, "football-credential-status.json");
  const markdownPath = join(exportDir, "football-credential-status.md");
  writeFileSync(jsonPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, credentialMarkdown(status), "utf8");
  return { jsonPath, markdownPath };
}

export function maskCredentialValue(value, secret = true) {
  const text = String(value ?? "");
  if (!text) return "";
  if (!secret) return text.length > 80 ? `${text.slice(0, 60)}...` : text;
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}${"*".repeat(Math.min(12, text.length - 8))}${text.slice(-4)}`;
}

async function checkCredentialLive(credential, env, fetchImpl) {
  if (!env[credential.key]) return { checked: false, ok: false, status: "未配置" };
  if (typeof fetchImpl !== "function") return { checked: true, ok: false, status: "当前 Node 环境不支持 fetch" };
  try {
    if (credential.liveCheck === "url") return await checkUrl(fetchImpl, env[credential.key]);
    if (credential.liveCheck === "the-odds-api") return await checkEndpoint(fetchImpl, `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(env[credential.key])}`);
    if (credential.liveCheck === "odds-api-io") return await checkEndpoint(fetchImpl, `https://api.odds-api.io/v3/events?apiKey=${encodeURIComponent(env[credential.key])}&sport=football`);
    if (credential.liveCheck === "api-football") return await checkEndpoint(fetchImpl, "https://v3.football.api-sports.io/status", { "x-apisports-key": env[credential.key] });
    if (credential.liveCheck === "football-data-org") return await checkEndpoint(fetchImpl, "https://api.football-data.org/v4/competitions", { "X-Auth-Token": env[credential.key] });
    if (credential.liveCheck === "football-data-co-uk") return await checkEndpoint(fetchImpl, "https://www.football-data.co.uk/matches.php");
    if (credential.liveCheck === "openligadb") return await checkEndpoint(fetchImpl, "https://api.openligadb.de/getavailableleagues");
    if (credential.liveCheck === "scorebat") return await checkEndpoint(fetchImpl, "https://www.scorebat.com/video-api/v3/");
    if (credential.liveCheck === "statsbomb-open-data") return await checkEndpoint(fetchImpl, "https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json");
    if (credential.liveCheck === "openfootball") return await checkEndpoint(fetchImpl, "https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json");
    return { checked: false, ok: null, status: "未定义检查器" };
  } catch (error) {
    return { checked: true, ok: false, status: error.message };
  }
}

async function checkUrl(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "football-ai-copilot/credential-check" } });
  return { checked: true, ok: response.ok, status: `HTTP ${response.status}` };
}

async function checkEndpoint(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "football-ai-copilot/credential-check", ...headers } });
  const text = await response.text();
  return { checked: true, ok: response.ok, status: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}: ${text.slice(0, 120)}` };
}

function credentialMarkdown(status) {
  const lines = ["# 足球大模型免费数据源凭据检查", "", `生成时间：${status.generatedAt}`, "", `模式：${status.policy.mode}`, `生产状态：${status.ok ? "通过" : "未通过"}`, ""];
  if (status.policy.failures.length) {
    lines.push("## 阻塞项", "");
    for (const failure of status.policy.failures) lines.push(`- ${failure}`);
    lines.push("");
  }
  lines.push("## 免费源清单", "", "| 数据源 | 环境变量 | 免费 | 已配置 | 检查 | 说明 |", "|---|---|---|---|---|---|");
  for (const row of status.rows) lines.push(`| ${row.name} | ${row.key} | ${row.free ? "是" : "否"} | ${row.configured ? "是" : "否"} | ${row.live.status} | ${row.layer} |`);
  return `${lines.join("\n")}\n`;
}

function parseEnvLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const index = trimmed.indexOf("=");
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  return /^[A-Z_][A-Z0-9_]*$/i.test(key) ? { key, value } : null;
}
