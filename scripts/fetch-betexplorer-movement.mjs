// betexplorer 赔率异动抓取(开盘→即时·1X2)。替代已死的 odds.500.com / 宕机的 titan007。
// 用法:node scripts/fetch-betexplorer-movement.mjs <betexplorer-match-url> [更多url...]
//   或 node scripts/fetch-betexplorer-movement.mjs --search 法国 北爱  (在 friendly-international fixtures 里找)
// 输出:每场 {主,平,客} 的 open/cur + 信号(steam in / drift out),JSON 到 stdout。
// 端点真相(2026-06-08 实证):
//   - 比赛页 td[data-odd][data-bt="1"] 含即时赔率 + data-oid/bid/sc/hcp;
//   - 开盘历史 = GET /archive-odds/{oid}/{bid}/1/{sc}/{hcp}/ → JSON [{date,odd,change}],末项=开盘。
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const urls = args.filter((a) => a.startsWith("http"));
if (!urls.length) { console.error("用法: node scripts/fetch-betexplorer-movement.mjs <match-url> ..."); process.exit(1); }

// betexplorer 反爬:headless 被服务精简页(无赔率)。用真实 Chrome 非 headless + 真 UA + 等单元格出现。
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
const results = [];
for (const url of urls) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector('td[data-odd][data-bt="1"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const data = await page.evaluate(async () => {
      const cells = [...document.querySelectorAll('td[data-odd][data-bt="1"]')];
      const byBook = {};
      for (const td of cells) {
        const bid = td.getAttribute("data-bid");
        if (!byBook[bid]) byBook[bid] = { book: td.getAttribute("data-bookie"), bid, hcp: td.getAttribute("data-hcp"), sc: td.getAttribute("data-sc"), cur: {}, oid: {} };
        const k = { "1": "home", "0": "draw", "2": "away" }[td.getAttribute("data-pos")];
        byBook[bid].cur[k] = td.getAttribute("data-odd"); byBook[bid].oid[k] = td.getAttribute("data-oid");
      }
      const ref = Object.values(byBook).find((b) => b.cur.home && b.cur.draw && b.cur.away) || Object.values(byBook)[0];
      if (!ref) return null;
      const mv = {};
      for (const k of ["home", "draw", "away"]) {
        if (!ref.oid[k]) { mv[k] = null; continue; }
        try {
          const r = await fetch(`https://www.betexplorer.com/archive-odds/${ref.oid[k]}/${ref.bid}/1/${ref.sc}/${ref.hcp}/`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const a = JSON.parse(await r.text());
          mv[k] = { open: a.length ? a[a.length - 1].odd : null, openDate: a.length ? a[a.length - 1].date : null, cur: ref.cur[k] };
        } catch { mv[k] = { open: null, cur: ref.cur[k] }; }
      }
      const title = document.title.split(" - ")[0];
      return { book: ref.book, movement: mv, title };
    });
    if (data) {
      const sig = (m) => (m?.open && m?.cur) ? (Number(m.cur) < Number(m.open) ? "↓压入(steam in)" : Number(m.cur) > Number(m.open) ? "↑走高(drift out)" : "持平") : "—";
      results.push({ url, match: data.title, book: data.book,
        home: data.movement.home, draw: data.movement.draw, away: data.movement.away,
        signal: { home: sig(data.movement.home), draw: sig(data.movement.draw), away: sig(data.movement.away) } });
    } else results.push({ url, error: "无1X2赔率单元格" });
  } catch (e) { results.push({ url, error: e.message }); }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
