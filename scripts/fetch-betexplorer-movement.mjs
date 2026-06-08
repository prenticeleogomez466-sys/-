// betexplorer 赔率异动抓取(开盘→即时·1X2)。替代已死的 odds.500.com / 宕机的 titan007。
// 用法:node scripts/fetch-betexplorer-movement.mjs <betexplorer-match-url> [更多url...]
//   带校验闸(强烈建议):--expect "TeamA|TeamB" [--expect "TeamC|TeamD" ...]  按 url 顺序逐一对位校验
// 输出:每场 {主,平,客} 的 open/cur + 信号(steam in / drift out),JSON 到 stdout。
// 端点真相(2026-06-08 实证):
//   - 比赛页 td[data-odd][data-bt="1"] 含即时赔率 + data-oid/bid/sc/hcp;
//   - 开盘历史 = GET /archive-odds/{oid}/{bid}/1/{sc}/{hcp}/ → JSON [{date,odd,change}],末项=开盘。
//
// ⚠️【防张冠李戴闸·2026-06-08 加】根因:betexplorer 同名球队不同对手/不同日期的比赛 URL 极易喂错
//   (实证事故:把"荷兰vs阿尔及利亚6/04已完赛"当成"荷兰vs乌兹别克6/09"抓异动,违 no_fabrication 铁律)。
//   对策:每个 url 必须配一个 --expect "主队英文|客队英文",抓到的比赛页标题必须同时含这两个队名,
//   否则该场判 REJECTED、绝不输出异动数字。team name 用 betexplorer 英文(如 Netherlands|Uzbekistan)。
//   缺 --expect 时仅 WARN 放行(向后兼容),但生产/cron 必须传,守真金白银底线。
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const urls = args.filter((a) => a.startsWith("http"));
// 按出现顺序收集 --expect "A|B",与 urls 一一对位
const expects = [];
for (let i = 0; i < args.length; i++) { if (args[i] === "--expect" && args[i + 1]) { expects.push(args[i + 1]); i++; } }
if (!urls.length) { console.error("用法: node scripts/fetch-betexplorer-movement.mjs <match-url> [--expect \"Home|Away\"] ..."); process.exit(1); }

// betexplorer 反爬:headless 被服务精简页(无赔率)。用真实 Chrome 非 headless + 真 UA + 等单元格出现。
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
const results = [];
for (let ui = 0; ui < urls.length; ui++) {
  const url = urls[ui];
  const expect = expects[ui] ?? null; // "Home|Away"
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
      // 完整标题供校验(含主+客队);短名供展示。h1 优先(如 "Netherlands - Algeria"),退回 document.title。
      const rawTitle = (document.querySelector("h1")?.textContent || document.title || "").replace(/\s+/g, " ").trim();
      const title = rawTitle.split(/\s+\d+:\d+|\s+-\s+BetExplorer|\|/)[0].trim() || rawTitle;
      return { book: ref.book, movement: mv, title, rawTitle };
    });
    if (data) {
      // ⚠️ 防张冠李戴闸:页面标题必须同时含 expect 的两个队名,否则判错配、不输出异动数字。
      if (expect) {
        const hay = `${data.rawTitle || ""} ${data.title || ""}`.toLowerCase();
        const parts = expect.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const missing = parts.filter((p) => !hay.includes(p));
        if (missing.length) {
          results.push({ url, REJECTED: true, reason: `页面比赛(${data.rawTitle || data.title})与期望(${expect})不符——缺[${missing.join(",")}],判张冠李戴,丢弃`, pageTitle: data.rawTitle || data.title });
          continue;
        }
      } else {
        console.error(`⚠️ WARN: ${url} 未传 --expect 校验,无法确认抓到正确比赛(生产/cron 必须传)。`);
      }
      const sig = (m) => (m?.open && m?.cur) ? (Number(m.cur) < Number(m.open) ? "↓压入(steam in)" : Number(m.cur) > Number(m.open) ? "↑走高(drift out)" : "持平") : "—";
      results.push({ url, match: data.title, book: data.book, verified: !!expect,
        home: data.movement.home, draw: data.movement.draw, away: data.movement.away,
        signal: { home: sig(data.movement.home), draw: sig(data.movement.draw), away: sig(data.movement.away) } });
    } else results.push({ url, error: "无1X2赔率单元格" });
  } catch (e) { results.push({ url, error: e.message }); }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
