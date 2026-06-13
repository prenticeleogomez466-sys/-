#!/usr/bin/env node
/**
 * 复盘覆盖完整性闸(2026-06-13 建,用户铁律:"必须保证每天自动复盘,把复盘涉及到的所有东西、内容都覆盖全面")。
 * ════════════════════════════════════════════════════════════════════════════════
 * recap:health 只查"任务在 11 点窗口 + 日报 master 在",查不到世界杯逐场复盘是否产出、
 * 也查不到"待回填是否趋零、每条留白有无理由"——某步 $true 静默失败就留白却无人报警。
 * 本闸把【每日复盘】+【世界杯逐场复盘】两边的 selfcheck + 全部产物今日新鲜度合并核验,
 * 任何真窟窿(产物缺失/陈旧、未全覆盖、pending 无理由、假结算、已开赛却未结算)→ exit 1。
 *
 * 遵铁律 [[feedback_no_fallback_absolute]] / [[project_daily_recap_auto]]:只读现成产物核验,绝不补造数据。
 * 用法: node scripts/recap-coverage-audit.mjs   (链路末尾自动跑;红=拒绿,真故障不再被淹没)
 */
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getExportDir } from "../src/paths.js";

const EXPORT = getExportDir();
const DESK = join(homedir(), "Desktop");

function todayShanghai(ms = Date.now()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms));
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) : null; } catch { return null; } };
const freshToday = (p, today) => existsSync(p) && todayShanghai(statSync(p).mtimeMs) === today;

function latestDailyRecap() {
  // 取 mtime 最新的 daily-recap-*.json(每日复盘按业务日命名,通常是"昨天")
  const files = readdirSync(EXPORT).filter((f) => /^daily-recap-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(EXPORT, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return files.length ? join(EXPORT, files[0].f) : null;
}

function runAudit() {
  const today = todayShanghai();
  const problems = [];
  const notes = [];

  // ── 1. 全部复盘产物今日新鲜度 ──
  const outputs = {
    "日报 master(D)": join(EXPORT, "football-recap-master.xlsx"),
    "神选复盘(桌面)": join(DESK, "神选复盘.xlsx"),
    "世界杯逐场快照(D)": join(EXPORT, "worldcup-match-recap.json"),
    "世界杯逐场表(桌面)": join(DESK, "足球推荐", "世界杯复盘", "2026世界杯逐场复盘命中率_累计.xlsx")
  };
  const freshness = {};
  for (const [name, p] of Object.entries(outputs)) {
    const ok = freshToday(p, today);
    freshness[name] = !existsSync(p) ? "缺失" : ok ? "今日已刷新" : "陈旧(非今日)";
    if (!ok) problems.push(`产物未今日刷新:${name} → ${freshness[name]}`);
  }

  // ── 2. 每日复盘 selfcheck ──
  const dailyPath = latestDailyRecap();
  const daily = dailyPath ? readJson(dailyPath) : null;
  const dailySc = daily?.selfcheck || null;
  if (!dailySc) problems.push("每日复盘 selfcheck 缺失(daily-recap-*.json 未产出或无自检)");
  else {
    if (!dailySc.全覆盖) problems.push(`每日复盘未全覆盖(覆盖 ${dailySc.覆盖场次})`);
    if (!dailySc["⏳均有理由"]) problems.push(`每日复盘有 pending 无理由(${dailySc.待回填已写理由}/${dailySc.待回填})`);
    if ((dailySc.可疑假结算 ?? 0) > 0) problems.push(`每日复盘疑似假结算 ${dailySc.可疑假结算} 场`);
    notes.push(`每日复盘[${daily.date}]: 全覆盖=${dailySc.全覆盖} 待回填=${dailySc.待回填}(均有理由=${dailySc["⏳均有理由"]}) 0假结算=${dailySc["0假结算"]} 穷尽免费源=${dailySc.穷尽免费源}`);
  }

  // ── 3. 世界杯逐场复盘 selfcheck ──
  const wc = readJson(join(EXPORT, "worldcup-match-recap.json"));
  const wcSc = wc?.selfcheck || null;
  if (!wcSc) problems.push("世界杯逐场复盘 selfcheck 缺失(worldcup-match-recap.json 未产出或为旧版无自检)");
  else {
    if (!wcSc.全覆盖) problems.push(`世界杯逐场未全覆盖(覆盖 ${wcSc.覆盖场次})`);
    if (!wcSc["⏳均有理由"]) problems.push(`世界杯逐场有 pending 无理由(${wcSc.待回填已写理由}/${wcSc.待回填})`);
    if ((wcSc.可疑假结算 ?? 0) > 0) problems.push(`世界杯逐场疑似假结算 ${wcSc.可疑假结算} 场`);
    if ((wcSc.已开赛却未结算 ?? 0) > 0) problems.push(`世界杯已开赛却未结算 ${wcSc.已开赛却未结算} 场:${(wcSc.已开赛却未结算明细 || []).join("; ")}`);
    if (!wcSc.盘口对照覆盖) problems.push("世界杯盘口主推对照列未覆盖全部已结算场");
    notes.push(`世界杯逐场: 全覆盖=${wcSc.全覆盖} 待回填=${wcSc.待回填}(均有理由=${wcSc["⏳均有理由"]}) 0假结算=${wcSc["0假结算"]} 盘口对照=${wcSc.盘口对照覆盖} 已开赛未结算=${wcSc.已开赛却未结算}`);
  }

  const ok = problems.length === 0;
  const report = { ok, date: today, generatedAt: new Date().toISOString(), freshness, dailySelfcheck: dailySc, wcSelfcheck: wcSc, problems, notes };
  mkdirSync(EXPORT, { recursive: true });
  writeFileSync(join(EXPORT, `recap-coverage-audit-${today}.json`), JSON.stringify(report, null, 2));

  console.log(`\n=== 复盘覆盖完整性闸 ${today} ===`);
  console.log("产物新鲜度:"); for (const [k, v] of Object.entries(freshness)) console.log(`  ${v === "今日已刷新" ? "✅" : "❌"} ${k}: ${v}`);
  notes.forEach((n) => console.log("  · " + n));
  if (ok) console.log("\n✅ 复盘覆盖全面:每日+世界杯逐场全部产出今日刷新、全覆盖、pending 均有理由、0 假结算、盘口对照在位。");
  else { console.log(`\n❌ 复盘覆盖不全(${problems.length} 项):`); problems.forEach((p) => console.log("  - " + p)); }
  return ok;
}

const ok = runAudit();
if (!ok) process.exitCode = 1;
