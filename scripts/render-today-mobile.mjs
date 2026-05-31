/**
 * 今日足球·合一手机页:竞彩明细 + 14场胆双全 + 任选9,自包含响应式 HTML。
 *
 * 渲染逻辑在 src/today-mobile-view.js(与 server.js 的 /today 路由共用同一真相源)。
 * 本脚本只负责:跑 recommendFixtures(date) → 调 renderTodayMobileHtml → 落地文件。
 *
 * 用法:node scripts/render-today-mobile.mjs [--date 2026-05-31] [--out 路径]
 * 默认写 D:\Temp\webshare_lingdao\今日足球推荐.html(手机端口80)+ 桌面副本。
 */
import "../src/env.js";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recommendFixtures } from "../src/prediction-engine.js";
import { renderTodayMobileHtml } from "../src/today-mobile-view.js";

const args = process.argv.slice(2);
const readArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

const rec = recommendFixtures(date);
const preds = rec.predictions || [];
if (!preds.length) {
  console.error(`❌ ${date} 无任何可预测场次(predictions 为空),按「禁止假编/无14场则不发」不生成网页。`);
  process.exit(1);
}

const html = renderTodayMobileHtml(rec, date);
const four = rec.fourteen || {};
const sels = Array.isArray(four.selections) ? four.selections : [];
const dan = sels.filter((s) => s.type === "胆").length, shuang = sels.filter((s) => s.type === "双选").length, quan = sels.filter((s) => s.type === "全选").length;
const combos = sels.reduce((a, s) => a * (String(s.compound || s.single || "").split("/").filter(Boolean).length || 1), 1);
const issue = (preds[0]?.fixture?.notes || "").match(/官方期号=([^;]+)/)?.[1]?.trim() || null;

const targets = [
  readArg("--out") || "D:\\Temp\\webshare_lingdao\\今日足球推荐.html", // 手机端口80
  "C:\\Users\\Administrator\\Desktop\\今日足球推荐.html"               // 桌面副本
];
for (const t of targets) {
  const dir = dirname(t);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(t, html, "utf8");
}
console.log(`✅ 合一手机页已生成 (${preds.length}场竞彩 + 14场[胆${dan}/双${shuang}/全${quan}=${combos}注]${rec.fourteen?.renxuan9?.ok ? ` + 任选9(对${rec.fourteen.renxuan9.needCorrect})` : ""})`);
console.log(`   期号 ${issue || "(无)"}`);
targets.forEach((t) => console.log("   →", t));
console.log("   📱 手机静态页: http://172.16.0.240/今日足球推荐.html");
console.log("   📱 手机实时页(server): http://172.16.0.240:3000/today  (server.js 运行时)");
