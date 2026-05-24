import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getExportDir } from "./paths.js";

const exportDir = getExportDir();

export function checkRecapAutomationHealth(date = todayInShanghai()) {
  mkdirSync(exportDir, { recursive: true });
  const task = readScheduledTask("FootballModel-RecapBacktest");
  const latest = readJson(join(exportDir, "automation-recap-latest.json"));
  const masterPath = join(exportDir, "football-recap-master.xlsx");
  const result = {
    ok: Boolean(task.ok && task.atEleven && existsSync(masterPath)),
    date,
    generatedAt: new Date().toISOString(),
    task,
    latestRun: latest ? {
      ok: latest.ok,
      date: latest.date,
      generatedAt: latest.generatedAt,
      failed: latest.failed,
      total: latest.total,
      logPath: latest.logPath
    } : null,
    outputs: {
      masterPath,
      masterExists: existsSync(masterPath),
      latestSummaryPath: join(exportDir, "automation-recap-latest.json"),
      latestSummaryExists: existsSync(join(exportDir, "automation-recap-latest.json"))
    }
  };
  const jsonPath = join(exportDir, `recap-automation-health-${date}.json`);
  const markdownPath = join(exportDir, `recap-automation-health-${date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
  return result;
}

function readScheduledTask(name) {
  if (process.platform !== "win32") return { ok: false, name, error: "Windows Scheduled Task check only runs on Windows" };
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$task = Get-ScheduledTask -TaskName '${name}' -ErrorAction Stop; $info = Get-ScheduledTaskInfo -TaskName '${name}' -ErrorAction SilentlyContinue; [pscustomobject]@{ TaskName=$task.TaskName; State=$task.State.ToString(); Triggers=@($task.Triggers | ForEach-Object { $_.StartBoundary }); NextRunTime=$info.NextRunTime; LastRunTime=$info.LastRunTime; LastTaskResult=$info.LastTaskResult } | ConvertTo-Json -Depth 4`
    ], { encoding: "utf8" });
    const parsed = JSON.parse(output);
    const triggers = Array.isArray(parsed.Triggers) ? parsed.Triggers : [parsed.Triggers].filter(Boolean);
    return {
      ok: true,
      name,
      state: parsed.State,
      triggers,
      atEleven: triggers.some((trigger) => String(trigger).includes("T11:00")),
      nextRunTime: parsed.NextRunTime,
      lastRunTime: parsed.LastRunTime,
      lastTaskResult: parsed.LastTaskResult
    };
  } catch (error) {
    return { ok: false, name, error: error.message };
  }
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function renderMarkdown(result) {
  return [
    `# 每日复盘自动化健康检查 ${result.date}`,
    "",
    `状态：${result.ok ? "通过" : "未通过"}`,
    "",
    `- 计划任务：${result.task.ok ? "存在" : "缺失"}`,
    `- 触发时间：${result.task.atEleven ? "每日 11:00" : "不是 11:00 或无法读取"}`,
    `- 任务状态：${result.task.state ?? result.task.error ?? ""}`,
    `- 下一次运行：${result.task.nextRunTime ?? ""}`,
    `- 最近运行：${result.latestRun ? `${result.latestRun.ok ? "成功" : "失败"} ${result.latestRun.generatedAt}` : "暂无摘要"}`,
    `- 复盘总表：${result.outputs.masterExists ? result.outputs.masterPath : "缺失"}`,
    ""
  ].join("\n");
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("recap-automation-health.js")) {
  const date = readArg("--date") ?? todayInShanghai();
  const result = checkRecapAutomationHealth(date);
  console.log(JSON.stringify({ ok: result.ok, task: result.task, outputs: result.outputs }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
