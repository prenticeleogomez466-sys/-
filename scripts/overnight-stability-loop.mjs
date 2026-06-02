#!/usr/bin/env node
/**
 * Overnight Stability Loop(过夜稳定性循环 — 跑到明早 8 点)
 * ────────────────────────────────────────────────────────────
 * 每 INTERVAL 分钟跑一次 source-stability-monitor,持续到目标时间(默认次日 08:00 北京)。
 * 目的:用真实账本证明"稳定缓存接入后,反复抓取结果不再漂移",并暴露真正不稳的源。
 *
 * 用法:node scripts/overnight-stability-loop.mjs [intervalMin] [stopUtcISO]
 *   默认:间隔 10 分钟,停止于次日 00:00 UTC(= 北京 08:00)。
 * 避让:02:45–03:30 UTC 之外才跑?不需要 —— 03:00 的 DailyEvolution 改的是
 *   fusion 权重,本循环只读盘口 + 写 stability-cache/ledger,不撞文件。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const intervalMin = Number(process.argv[2] || 10);
const stopAt = process.argv[3] ? new Date(process.argv[3]) : defaultStop();

function defaultStop() {
  // 北京 08:00 = UTC 00:00。取"现在之后最近的 00:00 UTC"。
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[overnight] 启动稳定性循环:每 ${intervalMin} 分钟一轮,停止于 ${stopAt.toISOString()}（北京 ${new Date(stopAt.getTime() + 8 * 3600e3).toISOString().slice(11, 16)}）`);

let round = 0;
while (Date.now() < stopAt.getTime()) {
  round += 1;
  const startedAt = new Date().toISOString();
  console.log(`\n[overnight] ── 第 ${round} 轮 @ ${startedAt} ──`);
  const res = spawnSync(process.execPath, [join(here, "source-stability-monitor.mjs")], {
    cwd: dirname(here),
    encoding: "utf8",
    timeout: 5 * 60e3,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" }
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.status !== 0 && res.stderr) process.stderr.write(`[overnight] 监控异常: ${res.stderr.slice(0, 400)}\n`);
  const remainMs = stopAt.getTime() - Date.now();
  if (remainMs <= 0) break;
  await sleep(Math.min(intervalMin * 60e3, remainMs));
}
console.log(`\n[overnight] 到达停止时间 ${new Date().toISOString()},共 ${round} 轮。循环结束。`);
