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
    // 开球时刻(缺陷#9 配套,2026-06-10):500 静态 XML 无 matchtime,jczq DOM 是免费唯一含
    //   "MM-DD HH:MM" 开球时刻的现成源。随让球数一并捕获,供 fixtures 摄入链补 kickoff HH:mm
    //   (临场收盘捕获靠它判窗口)。挂保留键 __kickoffs__,与让球 map 同文件,消费端按复合键查。
    const kickoffs = {};
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
      const koCell = cells[2] || "";
      const teamCell = cells[3] || "";
      const hcap = cells[4] || "";
      const parts = teamCell.replace(/\[\d+\]/g, "").split(/VS/i);
      const home = (parts[0] || "").trim();
      const away = (parts[1] || "").trim();
      if (!home) continue;
      const ko = (koCell.match(/\d{2}-\d{2}\s+\d{1,2}:\d{2}/) || [])[0] || "";
      if (away && ko) kickoffs[`${home}|${away}`] = ko;
      if (!/[-+]?\d/.test(hcap)) continue;
      // 防碰撞(2026-06-09 根因修):同一主队当日可能两场(如阿根廷vs冰岛让-2 + 阿根廷vs阿尔及利亚让-1),
      //   旧 map[home] 后写覆盖前写 → 错拿别场让球线。改 "主队|客队" 唯一键;保留 home 键向后兼容(消费端优先查复合键)。
      if (away) map[`${home}|${away}`] = hcap;
      if (!(home in map)) map[home] = hcap;
    }
    if (Object.keys(kickoffs).length) map.__kickoffs__ = kickoffs;
    return map;
  });
  writeFileSync(out, JSON.stringify(data, null, 2), "utf8");
  const hcapCount = Object.keys(data).filter((k) => k !== "__kickoffs__").length;
  console.log(JSON.stringify({ ok: true, count: hcapCount, kickoffCount: Object.keys(data.__kickoffs__ ?? {}).length, out, data }, null, 2));
} catch (error) {
  console.error("抓取失败:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
