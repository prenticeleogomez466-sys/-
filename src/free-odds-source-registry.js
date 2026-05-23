import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const registryPath = join(rootDir, "data", "free-odds-sources.json");
const exportDir = join(rootDir, "data", "exports");

export function loadFreeOddsSources(path = registryPath) {
  if (!existsSync(path)) throw new Error(`免费赔率源注册表不存在：${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function auditFreeOddsSources(env = process.env) {
  const registry = loadFreeOddsSources();
  const rows = registry.sources.map((source) => ({
    ...source,
    configured: source.env ? isConfigured(source.env, env[source.env]) : true,
    defaultAllowed: true,
    nextAction: source.env && !env[source.env] ? `配置 ${source.env}` : "已可用于免费模式"
  }));
  const hasLiveOdds = rows.some((row) => row.configured && row.layers.some((layer) => ["live-odds", "pre-match-odds", "odds"].includes(layer)));
  const hasHistorical = rows.some((row) => row.configured && row.layers.includes("historical-odds"));
  return {
    ok: hasLiveOdds || hasHistorical,
    generatedAt: new Date().toISOString(),
    policy: registry.defaultPolicy,
    summary: {
      total: rows.length,
      configured: rows.filter((row) => row.configured).length,
      freeOnly: true,
      hasLiveOdds,
      hasHistorical
    },
    rows
  };
}

function isConfigured(key, value) {
  if (key.endsWith("_ENABLED")) return String(value ?? "") === "1";
  return Boolean(value);
}

export function writeFreeOddsAudit(audit) {
  mkdirSync(exportDir, { recursive: true });
  const jsonPath = join(exportDir, "free-odds-source-audit.json");
  const markdownPath = join(exportDir, "free-odds-source-matrix.md");
  writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, buildMarkdown(audit), "utf8");
  return { jsonPath, markdownPath };
}

function buildMarkdown(audit) {
  const lines = [
    "# 免费赔率数据源矩阵",
    "",
    `生成时间：${audit.generatedAt}`,
    `默认策略：${audit.policy.freeOddsOnly ? "只用免费源" : "允许自定义"}`,
    "",
    "| 数据源 | 类型 | 环境变量 | 层级 | 免费额度 | 已配置 | 下一步 |",
    "|---|---|---|---|---|---|---|"
  ];
  for (const row of audit.rows) {
    lines.push(`| ${row.name} | ${row.type} | ${row.env || "无需"} | ${row.layers.join(", ")} | ${row.freeLimit} | ${row.configured ? "是" : "否"} | ${row.nextAction} |`);
  }
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = auditFreeOddsSources();
  const paths = writeFreeOddsAudit(audit);
  console.log(JSON.stringify({ ok: audit.ok, summary: audit.summary, paths }, null, 2));
}
