/**
 * 自动抓 500 jczq 页面 DOM 的「竞彩官方让球数」(handicapCell, 如 "0 -1")。
 * 用系统 Chrome(playwright-core, channel:chrome, 不下载 chromium)。
 * 输出 {主队名: "0 -1"} json,供 build-scrape-from-xml.mjs --handicap 注入。
 *
 * 用法: node scripts/scrape-jingcai-handicap.mjs [--out 路径]
 * 计划任务/jingcai 流程在 build-scrape 前先跑本脚本拿官方让球数。
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = readArg("--out", "D:/Temp/claude/handicap.json");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" });
  await page.goto("https://trade.500.com/jczq/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500); // 等 JS 渲染对阵表
  const data = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr")].filter((tr) => /周[一二三四五六日]\d{3}/.test(tr.innerText));
    const map = {};
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
      const teamCell = cells[3] || "";
      const hcap = cells[4] || "";
      const home = teamCell.replace(/\[\d+\]/g, "").split(/VS/i)[0].trim();
      if (home && /[-+]?\d/.test(hcap)) map[home] = hcap;
    }
    return map;
  });
  writeFileSync(out, JSON.stringify(data, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, count: Object.keys(data).length, out, data }, null, 2));
} catch (error) {
  console.error("抓取失败:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
