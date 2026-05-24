import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { validateProductionCredentials } from "./source-credentials.js";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

const SOURCES = [
  { name: "中国体彩网竞彩足球计算器（公开官方源）", priority: "P0", layers: ["fixtures-jingcai", "odds-win-draw-loss", "odds-handicap-win-draw-loss", "score-odds", "half-full-odds"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "竞彩网传统足彩公告（14场官方源）", priority: "P0", layers: ["fixtures-shengfucai", "issue-14", "announcement"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "竞彩网赛事公告（竞彩开售停售）", priority: "P0", layers: ["sales-window", "bulletin"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "The Odds API 免费层", priority: "P0", layers: ["odds-european", "odds-asian"], env: ["ODDS_API_KEY"], adapterStatus: "connected", freeDefault: true },
  { name: "Odds-API.io 免费层", priority: "P0", layers: ["odds-european", "odds-asian"], env: ["ODDS_API_IO_KEY"], adapterStatus: "connected", freeDefault: true },
  { name: "API-Football 免费层", priority: "P0", layers: ["fixtures", "results", "odds"], env: ["API_FOOTBALL_KEY"], adapterStatus: "connected", freeDefault: true },
  { name: "football-data.org 免费层", priority: "P1", layers: ["fixtures", "results"], env: ["FOOTBALL_DATA_ORG_TOKEN"], adapterStatus: "connected", freeDefault: true },
  { name: "football-data.co.uk 免费 CSV", priority: "P1", layers: ["historical-results", "historical-odds"], env: ["FOOTBALL_DATA_CO_UK_ENABLED"], adapterStatus: "connected", freeDefault: true },
  { name: "ClubElo 公共评级", priority: "P1", layers: ["team-elo", "team-strength"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "Open-Meteo 免费天气", priority: "P1", layers: ["weather", "geo-coding"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "GDELT DOC 新闻检索", priority: "P2", layers: ["news", "motivation-signal"], env: [], adapterStatus: "connected", freeDefault: true },
  { name: "OpenLigaDB 免费公开 API", priority: "P2", layers: ["fixtures", "results", "germany-leagues"], env: ["OPENLIGADB_ENABLED"], adapterStatus: "candidate", freeDefault: true },
  { name: "ScoreBat 免费视频/资讯 API", priority: "P3", layers: ["match-videos", "news-context"], env: ["SCOREBAT_ENABLED"], adapterStatus: "candidate", freeDefault: true },
  { name: "StatsBomb Open Data", priority: "P2", layers: ["historical-events", "historical-xg", "model-training"], env: ["STATSBOMB_OPEN_DATA_ENABLED"], adapterStatus: "candidate", freeDefault: true },
  { name: "openfootball GitHub 公共数据", priority: "P2", layers: ["historical-fixtures", "historical-results"], env: ["OPENFOOTBALL_DATA_ENABLED"], adapterStatus: "candidate", freeDefault: true },
  { name: "授权伤停 JSON 源", priority: "P0", layers: ["injuries"], env: ["INJURY_SOURCE_URL"], adapterStatus: "connected", freeDefault: true },
  { name: "授权首发 JSON 源", priority: "P0", layers: ["lineups"], env: ["LINEUP_SOURCE_URL"], adapterStatus: "connected", freeDefault: true },
  { name: "授权 xG JSON 源", priority: "P0", layers: ["xg", "shot-quality"], env: ["XG_SOURCE_URL"], adapterStatus: "connected", freeDefault: true },
  { name: "自有免费 JSON/CSV 赔率源", priority: "P0", layers: ["odds-european", "odds-asian", "odds-handicap"], env: ["ODDS_JSON_URL 或 ODDS_CSV_URL"], adapterStatus: "connected", freeDefault: true }
];

export async function auditFootballDataSources() {
  const policy = validateProductionCredentials(process.env);
  const rows = SOURCES.map((source) => {
    const configured = source.env.length === 0 || source.env.some((key) => isConfiguredKey(key));
    return {
      ...source,
      credential: configured ? "ok" : "missing-env",
      productionUsable: configured && source.freeDefault && source.adapterStatus === "connected",
      nextAction: configured ? (source.adapterStatus === "candidate" ? "候选源已登记，需按官网条款启用适配器" : "已接入免费模式每日健康检查") : `配置 ${source.env.join(", ")}`
    };
  });
  return {
    ok: policy.ok,
    generatedAt: new Date().toISOString(),
    defaultPolicy: "free-only",
    summary: {
      total: rows.length,
      production: rows.length,
      connected: rows.filter((row) => row.adapterStatus === "connected").length,
      needsCredential: rows.filter((row) => row.env.length).length
    },
    policy,
    rows
  };
}

export function writeFootballDataSourceAudit(audit) {
  mkdirSync(exportDir, { recursive: true });
  const jsonPath = join(exportDir, "football-data-source-audit.json");
  const markdownPath = join(exportDir, "football-data-source-matrix.md");
  writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  writeFileSync(
    markdownPath,
    [
      "# 足球数据源矩阵（默认免费模式）",
      "",
      `生产状态：${audit.ok ? "通过" : "未通过"}`,
      "",
      "| 数据源 | 层级 | 凭据 | 默认免费 | 状态 | 下一步 |",
      "|---|---|---|---|---|---|",
      ...audit.rows.map((row) => `| ${row.name} | ${row.layers.join(", ")} | ${row.credential} | ${row.freeDefault ? "是" : "否"} | ${row.adapterStatus} | ${row.nextAction} |`),
      ""
    ].join("\n"),
    "utf8"
  );
  return { jsonPath, markdownPath };
}

function isConfiguredKey(key) {
  if (key.includes("或")) return Boolean(process.env.ODDS_JSON_URL || process.env.ODDS_CSV_URL);
  if (key.endsWith("_ENABLED")) return process.env[key] === "1";
  return Boolean(process.env[key]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = await auditFootballDataSources();
  const paths = writeFootballDataSourceAudit(audit);
  console.log(JSON.stringify({ ok: audit.ok, summary: audit.summary, paths }, null, 2));
}
