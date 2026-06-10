#!/usr/bin/env node
// 世界杯期间每日专业版交付链(2026-06-11 上线,7/19 后可停):
//   ingest(--horizon 6 抓全期次腿) → ESPN近5/DK补盘 → 本地H2H → titan007亚盘/欧赔参考 → 专业版渲染 → 三副本同步。
// 设计:每步独立 AllowFailure(前步失败后步照跑,渲染层对缺数标⚠️不兜底),汇总 json 落 exports 供晨检;
//   绝不在此处做任何概率/参数修改——纯数据采集+渲染编排。计划任务 FootballModel-WCProDelivery 每日 11:40 调用
//   (在 DailyEvolution 11:15 之后,叠加其产出而非竞争)。
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "../src/paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()); // YYYY-MM-DD 北京口径
const steps = [
  ["ingest(全期次腿)", ["scripts/ingest-500-jingcai-fallback.mjs", `--date=${date}`, "--horizon", "6"]],
  ["coverage(ESPN近5/DK)", ["scripts/fetch-match-coverage.mjs", date]],
  ["H2H(本地历史库)", ["scripts/fetch-h2h-local.mjs", `--date=${date}`]],
  ["亚盘/欧赔参考(titan007)", ["scripts/fetch-asian-titan007.mjs", `--date=${date}`]],
  ["专业版渲染", ["scripts/today-full-coverage.mjs", date, "--jconly"]],
];
const results = [];
for (const [name, argv] of steps) {
  const r = spawnSync("node", argv, { cwd: join(here, ".."), encoding: "utf8", timeout: 600000 });
  results.push({ step: name, exit: r.status, tail: String(r.stderr || r.stdout || "").slice(-300) });
  console.error(`[wc-pro-delivery] ${name} exit=${r.status}`);
}
// 三副本同步(交付铁律:子文件夹+手机下载副本;Desktop 根由渲染器自写)
try {
  const src = `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
  const sub = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
  mkdirSync(sub, { recursive: true });
  copyFileSync(src, join(sub, `神选-竞彩推荐-${date}.xlsx`));
  copyFileSync(src, `D:/Temp/webshare_lingdao/jingcai-${date}.xlsx`);
  results.push({ step: "三副本同步", exit: 0 });
} catch (e) { results.push({ step: "三副本同步", exit: 1, tail: e.message }); }
const ok = results.every((r) => r.exit === 0);
writeFileSync(join(getExportDir(), "wc-pro-delivery-latest.json"), JSON.stringify({ date, ok, finishedAt: new Date().toISOString(), results }, null, 1));
console.log(JSON.stringify({ date, ok, failed: results.filter((r) => r.exit !== 0).map((r) => r.step) }));
process.exitCode = ok ? 0 : 1;
