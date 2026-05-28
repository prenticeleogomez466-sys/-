import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";
import { loadFixtures } from "./fixture-store.js";
import { buildMarketCoverageStatus } from "./market-data-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

const REQUIRED_FILES = [
  "package.json",
  "src/china-web-sources.js",
  "src/realtime-source-gate.js",
  "src/prediction-engine.js",
  "src/monte-carlo-simulator.js",
  "src/daily-report.js",
  "src/recommendation-audit.js",
  "src/evolution-backtest.js",
  "src/server.js",
  "src/wechat-channel.js",
  "src/wechat-delivery.js",
  "src/wechat-smoke.js",
  "WECHAT_CHANNEL_SECURITY.md",
  "scripts/run-football-automation.ps1",
  "scripts/install-football-automation-tasks.ps1"
];

const REQUIRED_SCRIPTS = [
  "crawler:realtime",
  "crawler:realtime:strict",
  "china:sources",
  "china:sources:sync",
  "daily",
  "daily:allow-missing",
  "advanced:sync",
  "model:top-tier-audit",
  "model:defect-audit",
  "model:stage-audit",
  "backtest:evolution",
  "auto:health",
  "auto:daily",
  "auto:install",
  "wechat:check",
  "test"
];

export function auditModelStructure(date = todayInShanghai()) {
  mkdirSync(exportDir, { recursive: true });
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const checks = [
    ...checkRequiredFiles(),
    ...checkPackageScripts(packageJson),
    ...checkDataLayer(date),
    ...checkRealtimeGate(date),
    ...checkOutputLayer(date),
    ...checkUserVisibleChinese()
  ];
  const errors = checks.filter((item) => item.level === "error");
  const warnings = checks.filter((item) => item.level === "warning");
  const result = {
    ok: errors.length === 0,
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      errors: errors.length,
      warnings: warnings.length,
      passed: checks.filter((item) => item.ok).length
    },
    checks
  };
  writeAudit(result);
  return result;
}

function checkRequiredFiles() {
  return REQUIRED_FILES.map((file) => {
    const path = join(rootDir, file);
    return check("结构层", `关键文件 ${file}`, existsSync(path), existsSync(path) ? "存在" : "缺失", existsSync(path) ? "ok" : "error");
  });
}

function checkPackageScripts(packageJson) {
  const scripts = packageJson.scripts ?? {};
  return REQUIRED_SCRIPTS.map((script) =>
    check("脚本层", `npm 脚本 ${script}`, Boolean(scripts[script]), scripts[script] ?? "缺失", scripts[script] ? "ok" : "error")
  );
}

function checkDataLayer(date) {
  // SOURCE_GATE_PARTIAL_MODE=1:webapi.sporttery.cn 反爬期间允许只跑 14 场流程,
  // 此时"竞彩场次"硬要求降级为 warning,避免 model audit 被同一根因二次阻断
  const partialMode = process.env.SOURCE_GATE_PARTIAL_MODE === "1";
  const checks = [];
  try {
    const fixtures = loadFixtures(date);
    const jingcai = fixtures.fixtures.filter((fixture) => fixture.marketType === "jingcai");
    const shengfucai = fixtures.fixtures.filter((fixture) => fixture.marketType === "shengfucai");
    checks.push(check("数据层", "赛程总量", fixtures.fixtures.length > 0, `${fixtures.fixtures.length} 场`, fixtures.fixtures.length > 0 ? "ok" : "error"));
    const jingcaiLevel = jingcai.length > 0 ? "ok" : (partialMode ? "warning" : "error");
    const jingcaiDetail = `${jingcai.length} 场${partialMode && jingcai.length === 0 ? "（partial-mode 软警告）" : ""}`;
    checks.push(check("数据层", "竞彩足球场次", jingcai.length > 0, jingcaiDetail, jingcaiLevel));
    checks.push(check("数据层", "14场完整性", shengfucai.length === 14, `${shengfucai.length}/14`, shengfucai.length === 14 ? "ok" : "error"));
    checks.push(check("数据层", "官方数据来源", fixtures.source?.includes("china-official-web"), fixtures.source ?? "缺失", fixtures.source?.includes("china-official-web") ? "ok" : "warning"));
  } catch (error) {
    checks.push(check("数据层", "赛程读取", false, error.message, "error"));
  }

  try {
    const market = buildMarketCoverageStatus(date);
    checks.push(check("赔率层", "市场快照", market.snapshots > 0, `${market.snapshots} 个快照`, market.snapshots > 0 ? "ok" : "warning"));
    checks.push(check("赔率层", "实时赔率覆盖", market.rows.some((row) => row.realTime), `${market.rows.filter((row) => row.realTime).length}/${market.fixtures}`, market.rows.some((row) => row.realTime) ? "ok" : "warning"));
  } catch (error) {
    checks.push(check("赔率层", "市场读取", false, error.message, "warning"));
  }
  return checks;
}

function checkRealtimeGate(date) {
  const gatePath = join(exportDir, `realtime-source-gate-${date}.json`);
  if (!existsSync(gatePath)) return [check("闸门层", "实时数据源闸门", false, "缺少闸门文件", "error")];
  try {
    const payload = JSON.parse(readFileSync(gatePath, "utf8"));
    const gate = payload.gate ?? payload;
    const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(gate.generatedAt).getTime()) / 60000));
    return [
      check("闸门层", "实时数据源闸门", gate.ok, gate.ok ? "通过" : gate.failures?.join("；"), gate.ok ? "ok" : "error"),
      check("闸门层", "闸门新鲜度", ageMinutes <= Number(process.env.SOURCE_GATE_MAX_AGE_MINUTES ?? 30), `${ageMinutes} 分钟`, ageMinutes <= Number(process.env.SOURCE_GATE_MAX_AGE_MINUTES ?? 30) ? "ok" : "warning")
    ];
  } catch (error) {
    return [check("闸门层", "实时数据源闸门解析", false, error.message, "error")];
  }
}

function checkOutputLayer(date) {
  const files = [
    [`football-recommendations-${date}.xlsx`, "每日推荐 XLSX"],
    ["football-recap-master.xlsx", "复盘总表 XLSX"],
    ["wechat-outbox-latest.json", "微信 outbox"]
  ];
  return files.map(([file, label]) => {
    const path = join(exportDir, file);
    const ok = existsSync(path) && statSync(path).size > 0;
    return check("输出层", label, ok, ok ? `${statSync(path).size} bytes` : "缺失", ok ? "ok" : "warning");
  });
}

function checkUserVisibleChinese() {
  const files = ["src/prediction-engine.js", "src/daily-report.js", "src/recommendation-audit.js", "src/wechat-channel.js", "src/wechat-smoke.js", "WECHAT_CHANNEL_SECURITY.md", "package.json"];
  const badPattern = /涓|绔|璧|鎺|鍦|姣|瀹|骞|鍚|妫|鏃|鐞|棣|鍗|椋|淇|�/;
  return files.map((file) => {
    const text = readFileSync(join(rootDir, file), "utf8");
    const ok = !badPattern.test(text);
    return check("中文层", `用户可见中文 ${file}`, ok, ok ? "正常中文" : "疑似乱码", ok ? "ok" : "warning");
  });
}

function check(layer, name, ok, detail, level = "ok") {
  return {
    layer,
    name,
    ok: Boolean(ok),
    level: ok ? "ok" : level,
    detail: String(detail ?? "")
  };
}

function writeAudit(result) {
  const jsonPath = join(exportDir, `model-structure-audit-${result.date}.json`);
  const markdownPath = join(exportDir, `model-structure-audit-${result.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
}

function renderMarkdown(result) {
  return [
    `# 足球大模型结构审计 ${result.date}`,
    "",
    `状态：${result.ok ? "通过" : "失败"}`,
    `生成时间：${result.generatedAt}`,
    "",
    "| 层级 | 检查项 | 状态 | 说明 |",
    "|---|---|---:|---|",
    ...result.checks.map((item) => `| ${item.layer} | ${item.name} | ${item.ok ? "通过" : item.level === "warning" ? "警告" : "失败"} | ${item.detail} |`),
    ""
  ].join("\n");
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? todayInShanghai();
  const result = auditModelStructure(date);
  console.log(JSON.stringify({ ok: result.ok, summary: result.summary, path: join(exportDir, `model-structure-audit-${date}.json`) }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
