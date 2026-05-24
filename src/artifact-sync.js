import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { getDataDir, getExportDir, rootDir } from "./paths.js";

const dataDir = getDataDir();
const exportDir = getExportDir();

export function syncFootballArtifacts(date, options = {}) {
  const result = {
    date,
    generatedAt: new Date().toISOString(),
    obsidian: null,
    git: null,
    ok: false
  };
  if (options.obsidian !== false) result.obsidian = syncToObsidian(date, options);
  if (options.git !== false) result.git = syncToGit(date, options);
  result.ok = [result.obsidian, result.git].filter(Boolean).every((item) => item.ok);
  return result;
}

export function syncToObsidian(date, options = {}) {
  const vaultDir = resolveObsidianVault(options.obsidianVaultDir);
  if (!vaultDir) return { ok: false, skipped: true, error: "未找到 Obsidian vault；请设置 OBSIDIAN_VAULT_DIR" };
  const noteDir = join(vaultDir, "Football Model", "日报");
  const attachmentDir = join(vaultDir, "Football Model", "附件", date);
  mkdirSync(noteDir, { recursive: true });
  mkdirSync(attachmentDir, { recursive: true });
  const attachments = artifactPaths(date).filter((file) => existsSync(file));
  const copied = attachments.map((file) => {
    const target = join(attachmentDir, file.split(/[\\/]/).at(-1));
    copyFileSync(file, target);
    return { source: file, target };
  });
  const notePath = join(noteDir, `${date} 足球大模型日报.md`);
  writeFileSync(notePath, buildObsidianNote(date, vaultDir, copied), "utf8");
  return { ok: true, vaultDir, notePath, copied: copied.length };
}

export function syncToGit(date, options = {}) {
  try {
    const remote = git(["remote", "get-url", "origin"]).trim();
    if (!isInsideWorkspace(dataDir) || !isInsideWorkspace(exportDir)) {
      return { ok: true, remote, committed: false, pushed: false, skipped: true, message: "生成内容已按策略落到 D 盘，跳过 C 盘仓库内数据提交" };
    }
    const artifactSpecs = [
      "data/advanced",
      "data/china-web",
      "data/crawler",
      "data/exports",
      "data/fixtures",
      "data/market",
      "data/*.json"
    ];
    git(["add", "-A", "--", ...artifactSpecs]);
    const changed = git(["status", "--porcelain", "--", ...artifactSpecs]).trim();
    if (!changed) return { ok: true, remote, committed: false, pushed: false, message: "无新的生成内容" };
    const message = options.commitMessage ?? `Sync football model artifacts ${date}`;
    git(["commit", "-m", message]);
    try {
      git(["pull", "--rebase", "--autostash", "origin", currentBranch()]);
    } catch {
      git(["rebase", "--abort"], { allowFailure: true });
      throw new Error("远端有冲突，自动 rebase 失败；请手动处理后再推送");
    }
    git(["push", "origin", currentBranch()]);
    return { ok: true, remote, committed: true, pushed: true, message };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function isInsideWorkspace(path) {
  const relativePath = relative(rootDir, resolve(path));
  return relativePath && !relativePath.startsWith("..") && !relativePath.includes(":");
}

function buildObsidianNote(date, vaultDir, copied) {
  const status = readJson(join(exportDir, `daily-evolution-status-${date}.json`));
  const audit = readJson(join(exportDir, `recommendation-audit-${date}.json`));
  const gate = readJson(join(exportDir, `realtime-source-gate-${date}.json`));
  const standard = readJson(join(exportDir, `data-completeness-standard-${date}.json`));
  const stage = readJson(join(exportDir, `model-stage-audit-${date}.json`));
  const rows = [
    "---",
    `date: ${date}`,
    "type: football-model-daily",
    "tags:",
    "  - football-model",
    "  - daily-report",
    "---",
    "",
    `# ${date} 足球大模型日报`,
    "",
    "## 闸门与审核",
    "",
    `- 日报生成：${status?.ok ? "通过" : "失败/未运行"}`,
    `- 实时闸门：${gate?.ok ? "通过" : "失败/未运行"}`,
    `- 市场快照：${gate?.gate?.summary?.marketSnapshots ?? gate?.summary?.marketSnapshots ?? "未知"}`,
    `- 可用快照：${gate?.gate?.summary?.marketUsable ?? gate?.summary?.marketUsable ?? "未知"}`,
    `- 实时快照：${gate?.gate?.summary?.marketRealtime ?? gate?.summary?.marketRealtime ?? "未知"}`,
    `- 推荐审核错误：${audit?.summary?.errors ?? "未知"}`,
    `- 推荐审核警告：${audit?.summary?.warnings ?? "未知"}`,
    `- 预测场次：${audit?.summary?.predictions ?? "未知"}`,
    `- 14场胆数：${audit?.summary?.fourteenBankers ?? "未知"}`,
    "",
    "## 数据完整度",
    "",
    `- 标准检查：${standard?.ok ? "通过" : "失败/未运行"}`,
    `- 完整快照：${standard?.summary?.complete ?? "未知"}/${standard?.summary?.fixtures ?? "未知"}`,
    `- 阶段审计：${stage?.ok ? "通过" : "失败/未运行"}`,
    `- 市场层评分：${stage?.summary?.stageScores?.market ?? "未知"}`,
    `- 推荐层评分：${stage?.summary?.stageScores?.prediction ?? "未知"}`,
    "",
    "## 附件",
    "",
    ...copied.map(({ target }) => `- [[${relative(vaultDir, target).replaceAll("\\", "/")}]]`),
    "",
    "## 复盘备注",
    "",
    "- 赛后补入实际赛果后，运行复盘流程更新命中率、Brier/LogLoss、赔率漂移归因。",
    "- 若阵容、伤停、大小球源缺失，表格会标注缺失，不使用臆造数据。"
  ];
  return `${rows.join("\n")}\n`;
}

function artifactPaths(date) {
  return [
    join(exportDir, `football-recommendations-${date}.xlsx`),
    join(exportDir, "football-recap-master.xlsx"),
    join(exportDir, `daily-evolution-status-${date}.json`),
    join(exportDir, `recommendation-audit-${date}.json`),
    join(exportDir, `realtime-source-gate-${date}.json`),
    join(exportDir, `realtime-source-gate-${date}.md`),
    join(exportDir, `data-completeness-standard-${date}.json`),
    join(exportDir, `model-stage-audit-${date}.json`),
    join(exportDir, `model-stage-audit-${date}.md`),
    join(exportDir, `model-defect-audit-${date}.json`),
    join(exportDir, `model-defect-audit-${date}.md`),
    join(exportDir, `model-capability-audit-${date}.json`),
    join(exportDir, `model-capability-audit-${date}.md`),
    join(exportDir, "backtest-summary.json"),
    join(exportDir, "backtest-calibration-profile.json"),
    join(exportDir, "recommendation-ledger.json"),
    join(dataDir, "fixtures", `${date}.json`),
    join(dataDir, "market", `${date}.json`),
    join(dataDir, "advanced", `${date}.json`),
    join(dataDir, "crawler", `realtime-source-${date}.json`)
  ];
}

function resolveObsidianVault(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.OBSIDIAN_VAULT_DIR,
    join("D:", "足球数据分析库", "111"),
    join("D:", "codex", "codex足球大模型"),
    join("D:", "Users", os.userInfo().username, "Documents", "Obsidian Vault"),
    join(os.homedir(), "Desktop"),
    join("D:", "Users", os.userInfo().username, "Desktop"),
    join("D:", "Desktop")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const vault = findVault(candidate);
    if (vault) return vault;
  }
  return "";
}

function findVault(candidate) {
  if (!existsSync(candidate)) return "";
  if (existsSync(join(candidate, ".obsidian"))) return candidate;
  let entries = [];
  try {
    entries = readdirSync(candidate, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(candidate, entry.name);
    if (existsSync(join(path, ".obsidian"))) return path;
  }
  return "";
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (options.allowFailure) return error.stdout?.toString() ?? "";
    throw new Error((error.stderr?.toString() || error.stdout?.toString() || error.message).trim());
  }
}

function currentBranch() {
  return git(["branch", "--show-current"]).trim() || "main";
}

function readJson(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
  const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const result = syncFootballArtifacts(date, {
    git: !args.includes("--no-git"),
    obsidian: !args.includes("--no-obsidian"),
    obsidianVaultDir: readArg("--obsidian-vault")
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
