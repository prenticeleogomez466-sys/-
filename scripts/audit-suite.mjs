#!/usr/bin/env node
// audit-suite —— 日常出表零token硬闸(2026-06-11 分级铁律配套)
// 用法: node scripts/audit-suite.mjs [--date=YYYY-MM-DD]
// 退出码: 0=全绿可交付; 1=有红,拒绝交付并起agent排查。
// 检查项来源: ①复发探针(历次缺陷修复三件套沉淀,见 config) ②三处一致 ③店内卫生。
// 原则: 任何检查目标缺失=显式SKIP打印原因,绝不静默跳过(守 feedback_no_fallback_absolute)。

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data";
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const DATE = dateArg ? dateArg.split("=")[1] : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  const mark = status === "PASS" ? "✅" : status === "SKIP" ? "⏭️" : "❌";
  console.log(`${mark} [${id}] ${status} ${detail}`);
}

// ── 1) config 驱动的外部命令检查(复发探针沉淀处) ──
// expect: "exit0"=命令须成功; "nonzero"=喂坏输入必须被拦(命令须失败)
const CONFIG_PATH = path.join(ROOT, "scripts", "audit-suite.config.json");
let config = [];
if (existsSync(CONFIG_PATH)) {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} else {
  record("config", "SKIP", `${CONFIG_PATH} 不存在,探针清单未灌入`);
}
for (const entry of config) {
  if (entry.disabled) { record(entry.id, "SKIP", entry.disabledReason || "disabled"); continue; }
  try {
    execSync(entry.cmd, { cwd: ROOT, stdio: "pipe", timeout: entry.timeoutMs || 120000 });
    record(entry.id, entry.expect === "nonzero" ? "FAIL" : "PASS", entry.expect === "nonzero" ? `坏输入未被拦!cmd=${entry.cmd}` : entry.desc || "");
  } catch (e) {
    record(entry.id, entry.expect === "nonzero" ? "PASS" : "FAIL", entry.expect === "nonzero" ? `${entry.desc || ""}(正确拒绝)` : `${entry.cmd} 失败: ${String(e.message).slice(0, 200)}`);
  }
}

// ── 2) 输出层垃圾扫描(手机页/HTML) ──
const WEBDIR = "D:\\Temp\\webshare_lingdao";
const GARBAGE = [/&lt;span/i, /undefined/, /\bNaN\b/, /\{\{/];
if (existsSync(WEBDIR)) {
  const targets = ["今日足球推荐.html", "worldcup.html"].filter((f) => existsSync(path.join(WEBDIR, f)));
  if (!targets.length) record("html-garbage", "SKIP", "目标html不存在");
  for (const f of targets) {
    const txt = readFileSync(path.join(WEBDIR, f), "utf8");
    const hits = GARBAGE.filter((re) => re.test(txt)).map(String);
    if (hits.length) record(`html-garbage:${f}`, "FAIL", `命中: ${hits.join(" ")}`);
    else record(`html-garbage:${f}`, "PASS", `${Math.round(txt.length / 1024)}KB 干净`);
  }
} else record("html-garbage", "SKIP", `${WEBDIR} 不存在`);

// ── 3) 当日fixtures卫生: 未来场不得带result; kickoff须含HH:mm(48h内场次) ──
const fxPath = path.join(DATA, "fixtures", `${DATE}.json`);
if (existsSync(fxPath)) {
  try {
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    const list = Array.isArray(fx) ? fx : fx.fixtures || [];
    const now = Date.now();
    let futureWithResult = 0, missingHHmm = 0, near = 0, sfDateOnly = 0;
    for (const m of list) {
      const ko = m.kickoff || m.kickoffTime || "";
      const koMs = Date.parse(ko);
      if (!Number.isNaN(koMs) && koMs > now && (m.result || m.finalScore)) futureWithResult++;
      if (!Number.isNaN(koMs) && koMs - now < 48 * 3600e3 && koMs > now) {
        near++;
        if (!/\d{1,2}:\d{2}/.test(String(ko))) {
          // 胜负彩腿历史上只有销售日粒度,影响结算时效不影响当日推荐/收盘捕获(走竞彩孪生行)→WARN不拦
          if (m.marketType === "shengfucai") sfDateOnly++;
          else missingHHmm++;
        }
      }
    }
    if (futureWithResult) record("fixtures-future-result", "FAIL", `${futureWithResult}场未开赛却带赛果`);
    else record("fixtures-future-result", "PASS", `${list.length}场无未来占位赛果`);
    if (missingHHmm) record("fixtures-kickoff-hhmm", "FAIL", `48h内${near}场中${missingHHmm}场(非胜负彩)kickoff缺HH:mm(收盘捕获会漏)`);
    else record("fixtures-kickoff-hhmm", "PASS", `48h内${near}场竞彩/WC行kickoff全带时刻${sfDateOnly ? `(另${sfDateOnly}条胜负彩腿仅日期粒度=WARN,可从竞彩孪生行回填)` : ""}`);
  } catch (e) { record("fixtures-hygiene", "FAIL", `解析失败: ${e.message}`); }
} else record("fixtures-hygiene", "SKIP", `${fxPath} 不存在`);

// ── 汇总 ──
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n══ audit-suite ${DATE}: ${results.length}项 | PASS ${results.length - fails.length - skips.length} | SKIP ${skips.length} | FAIL ${fails.length} ══`);
if (fails.length) { console.error("🔴 闸红,拒绝交付。FAIL项:\n" + fails.map((f) => `  - [${f.id}] ${f.detail}`).join("\n")); process.exit(1); }
process.exit(0);
