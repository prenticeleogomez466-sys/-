/**
 * 中国足彩网(zgzcw)百家欧赔采集 → 第三路独立市场锚 + 交叉验证描述层。
 * ─────────────────────────────────────────────────────────────────
 * 链路:
 *   1. 浏览器层(系统 Chrome / playwright-core)抓 odds.zgzcw.com 比赛列表 → matchId+主客队+联赛+时间
 *   2. Node 直连每场分析页 fenxi.zgzcw.com/<id>/bjop(静态 HTML)→ 百家共识(即时+初盘)+离散度
 *   3. 与当日主锚(500/The Odds API 市场快照)交叉验证去 vig 概率,分歧>阈值标注待人工核对
 *   4. 落盘 data/zgzcw/<date>.json(原始)+ exports/zgzcw-bjop-<date>.{json,md}(描述层)
 *   5. --merge:仅对「当日无任何 european 锚」的场次补 zgzcw 锚(gap-fill),
 *      绝不覆盖更 sharp 的主源;默认不开,遵命中率闭环纪律(动概率需回测)。
 *
 * 用法:
 *   node scripts/ingest-zgzcw-odds.mjs [--date YYYY-MM-DD] [--merge] [--limit N]
 * 默认 date=今天(zgzcw 列表本身就是近 1-2 日赛程,date 仅用于落盘命名/快照归属)。
 * 免费、无 key。
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../src/env.js";
import { getDataSubdir, getExportDir } from "../src/paths.js";
import { loadMarketSnapshots, saveMarketSnapshots, normalizeMarketSnapshot } from "../src/market-data-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import {
  fetchZgzcwBjopOdds,
  zgzcwImpliedProbs,
  buildZgzcwSnapshot,
  crossValidateZgzcw,
} from "../src/zgzcw-odds-source.js";

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);
const date = readArg("--date", new Date().toISOString().slice(0, 10));
const merge = hasFlag("--merge");
const limit = Number(readArg("--limit", "0")) || 0;

/** 浏览器层:抓 zgzcw 即时赔率列表 → [{id,seq,league,date,time,home,away}]。 */
async function scrapeMatchList() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await page.goto("https://odds.zgzcw.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3500); // 等 JS 渲染对阵表
    return await page.evaluate(() => {
      const re = /fenxi\.zgzcw\.com\/(\d+)/;
      const out = []; const seen = new Set();
      document.querySelectorAll("tr,li,div").forEach((el) => {
        const a = el.querySelector && el.querySelector('a[href*="fenxi.zgzcw.com"]');
        if (!a) return;
        const m = (a.getAttribute("href") || "").match(re);
        if (!m || seen.has(m[1])) return;
        const t = el.textContent.replace(/\s+/g, " ").trim();
        const mm = t.match(/\[(周[一二三四五六日]\d+)\]\s*(.+?)(\d{2}-\d{2})\s*(\d{2}:\d{2})(.+?)VS(.+?)(欧亚|析|$)/);
        if (!mm) return;
        seen.add(m[1]);
        out.push({ id: m[1], seq: mm[1], league: mm[2].trim(), date: mm[3], time: mm[4], home: mm[5].trim(), away: mm[6].trim() });
      });
      return out;
    });
  } finally {
    await browser.close();
  }
}

function sameTeam(a, b) {
  return canonicalTeamName(a) === canonicalTeamName(b);
}

function primaryProbsFor(snapshots, home, away) {
  const s = snapshots.find((x) => sameTeam(x.homeTeam, home) && sameTeam(x.awayTeam, away));
  if (!s) return { snapshot: null, probs: null };
  const cur = s.europeanOdds?.final ?? s.europeanOdds?.current ?? s.europeanOdds?.initial;
  if (!cur) return { snapshot: s, probs: null };
  return { snapshot: s, probs: zgzcwImpliedProbs(cur) };
}

async function main() {
  const collectedAt = new Date().toISOString();
  const list = await scrapeMatchList();
  const rows = limit > 0 ? list.slice(0, limit) : list;
  if (!rows.length) {
    console.log(JSON.stringify({ ok: false, date, reason: "列表页未解析到比赛(可能改版或当日无赛)" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const existing = loadMarketSnapshots(date).snapshots;
  const records = [];
  const gapFillSnapshots = [];

  for (const row of rows) {
    row.dateIso = `${date.slice(0, 4)}-${row.date}`;
    row.collectedAt = collectedAt;
    let parsed;
    try {
      parsed = await fetchZgzcwBjopOdds(row.id);
    } catch (error) {
      records.push({ ...row, ok: false, error: error.message });
      continue;
    }
    if (!parsed.ok) { records.push({ ...row, ok: false, error: parsed.error || "bjop 解析失败" }); continue; }

    const zProbs = zgzcwImpliedProbs(parsed.consensus.current);
    const { snapshot: primary, probs: primaryProbs } = primaryProbsFor(existing, row.home, row.away);
    const crossVal = crossValidateZgzcw(zProbs, primaryProbs);
    const snap = buildZgzcwSnapshot(row, parsed, date);

    records.push({
      ...row,
      ok: true,
      consensus: parsed.consensus,
      dispersion: parsed.dispersion,
      impliedProbs: zProbs,
      hasPrimaryAnchor: Boolean(primaryProbs),
      crossValidation: crossVal,
    });

    if (merge && !primaryProbs && snap) gapFillSnapshots.push(snap); // 仅补无锚场次
  }

  // 落盘:原始 + 描述层导出
  const dataDir = getDataSubdir("zgzcw");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, `${date}.json`), `${JSON.stringify({ date, collectedAt, records }, null, 2)}\n`, "utf8");

  const exportDir = getExportDir();
  mkdirSync(exportDir, { recursive: true });
  const okRecords = records.filter((r) => r.ok);
  const divergences = okRecords.filter((r) => r.crossValidation?.divergent);
  const summary = {
    date,
    collectedAt,
    scraped: rows.length,
    parsed: okRecords.length,
    withPrimaryAnchor: okRecords.filter((r) => r.hasPrimaryAnchor).length,
    divergences: divergences.length,
    merged: merge ? gapFillSnapshots.length : 0,
    mergeEnabled: merge,
  };
  writeFileSync(join(exportDir, `zgzcw-bjop-${date}.json`), `${JSON.stringify({ summary, records }, null, 2)}\n`, "utf8");
  writeFileSync(join(exportDir, `zgzcw-bjop-${date}.md`), buildMarkdown(summary, okRecords), "utf8");

  // gap-fill 合并(opt-in)
  if (merge && gapFillSnapshots.length) {
    const normalized = gapFillSnapshots.map((s, i) => normalizeMarketSnapshot(s, date, existing.length + i));
    const merged = [...existing, ...normalized];
    saveMarketSnapshots(date, merged, { source: "zgzcw-百家欧赔:gap-fill" });
  }

  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}

function buildMarkdown(summary, records) {
  const lines = [
    `# 中国足彩网百家欧赔 — ${summary.date}`,
    "",
    `采集时间:${summary.collectedAt}`,
    `列表 ${summary.scraped} 场 / 解析 ${summary.parsed} 场 / 有主锚 ${summary.withPrimaryAnchor} 场 / 分歧告警 ${summary.divergences} 场 / 合并 ${summary.merged} 场(merge=${summary.mergeEnabled})`,
    "",
    "| 赛事 | 对阵 | 百家共识(主/平/客) | 隐含概率 | 离散度(主/平/客) | 与主锚交叉验证 |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of records) {
    const c = r.consensus?.current ?? {};
    const p = r.impliedProbs ?? {};
    const d = r.dispersion ?? {};
    const cv = r.crossValidation;
    const cvText = !cv ? "无主锚可对" : cv.divergent ? `⚠️ ${cv.note}` : "✓ 一致";
    lines.push(
      `| ${r.league} ${r.seq} | ${r.home} vs ${r.away} | ${c.home}/${c.draw}/${c.away} | ${pct(p.home)}/${pct(p.draw)}/${pct(p.away)} | ${fmt(d.home)}/${fmt(d.draw)}/${fmt(d.away)} | ${cvText} |`,
    );
  }
  lines.push("", "> 纪律:百家共识作市场数据源/描述层与交叉验证,默认不改概率引擎;`--merge` 仅对无任何 european 锚的场次补锚,不覆盖更 sharp 的主源。");
  return lines.join("\n") + "\n";
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—");
const fmt = (v) => (Number.isFinite(v) ? v : "—");

main().catch((error) => {
  console.error("zgzcw 采集失败:", error.message);
  process.exitCode = 1;
});
