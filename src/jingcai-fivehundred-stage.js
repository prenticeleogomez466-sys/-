/**
 * 500.com 竞彩兜底装配层
 * ──────────────────────────────────────────────────
 * 官方竞彩 webapi(lottery.gov.cn / webapi.sporttery.cn)白天 WAF 567 或本机
 * SSL reset 不可达时,用 Playwright Chrome 抓 trade.500.com/jczq/ 的行数据,
 * 写成标准 JSON(见 jingcai-scrape-<date>.json),本模块把它解析成官方同款
 * fixture + marketSnapshot shape,并入当日 store(保留官方已同步的 14 场胜负彩),
 * 让 prediction-engine / daily-report 无差别消费。
 *
 * 输入行格式(与 reference-jingcai-data-pipeline 验证过的 500.com cells 一致):
 *   [seq, league, kickoff("MM-DD HH:MM"), teamCell("[排名]主 VS 客[排名]"),
 *    handicapCell("0 +1" / "单关 0 -1"), oddsCell("让0H 让0D 让0A 让NH 让ND 让NA")]
 *
 * 这是兜底数据源,失败容忍度高:单行字段缺失则跳过该行,不抛错。
 */
import { loadFixtures, saveFixtures } from "./fixture-store.js";
import { loadMarketSnapshots, saveMarketSnapshots } from "./market-data-store.js";
import { getDataSubdir } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCRAPE_SOURCE = "500.com /jczq/ (Playwright)";

export function scrapeFilePath(date) {
  return join(getDataSubdir("crawler"), `jingcai-scrape-${date}.json`);
}

/** 清洗队名:去掉 "[排名]" 标记。 */
export function cleanTeamName(name) {
  return String(name ?? "").replace(/\[\d+\]/g, "").trim();
}

function splitTeams(cell) {
  const [home, away] = String(cell ?? "").split(/\s*VS\s*/i);
  return [cleanTeamName(home), cleanTeamName(away)];
}

function oddsNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function safeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "x";
}

/**
 * 把抓到的 500.com 行解析成 { fixtures, snapshots }(官方同款 shape)。
 * @param {Array<Array<string>>} rows
 * @param {string} date  业务日期 YYYY-MM-DD
 * @param {string} collectedAt  快照采集时间 ISO(默认 now)
 */
export function parseFiveHundredRows(rows, date, collectedAt = new Date().toISOString()) {
  const fixtures = [];
  const snapshots = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const [seq, league, kickoff, teamCell, handicapCell, oddsCell] = row;
    const [homeTeam, awayTeam] = splitTeams(teamCell);
    if (!homeTeam || !awayTeam) continue;
    const o = String(oddsCell ?? "").trim().split(/\s+/).map(oddsNum);
    // 让0档欧赔 = o[0..2];让球胜平负(让N档) = o[3..5]
    const euro = { home: o[0], draw: o[1], away: o[2] };
    const hcp = { home: o[3], draw: o[4], away: o[5] };
    const year = String(date).slice(0, 4);
    const id = `jc-${date}-${safeName(seq)}-${safeName(homeTeam)}-${safeName(awayTeam)}`;
    fixtures.push({
      id,
      date,
      sequence: String(seq ?? ""),
      kickoff: kickoff ? `${year}-${kickoff}` : "",
      competition: String(league ?? "竞彩足球"),
      homeTeam,
      awayTeam,
      marketType: "jingcai",
      tags: ["竞彩足球", "500.com-playwright"],
      source: SCRAPE_SOURCE,
      officialStatus: "scraped-fallback",
      officialFixtureId: null,
      notes: `500.com 抓取;让球=${handicapCell ?? ""}`,
    });
    const hasEuro = euro.home && euro.draw && euro.away;
    const hasHcp = hcp.home && hcp.draw && hcp.away;
    snapshots.push({
      date,
      fixtureId: id,
      sequence: String(seq ?? ""),
      marketType: "jingcai",
      competition: String(league ?? ""),
      homeTeam,
      awayTeam,
      collectedAt,
      // 单次抓取只有一档即时赔率,initial=current 以满足 usable/freshness。
      europeanOdds: hasEuro ? { initial: euro, current: euro } : null,
      handicapOdds: hasHcp ? { initial: hcp, current: hcp } : null,
      source: SCRAPE_SOURCE,
    });
  }
  return { fixtures, snapshots };
}

/** 读取抓取 JSON 文件(支持 {date, collectedAt, rows} 或裸 rows 数组)。 */
export function loadScrapeFile(date, path = scrapeFilePath(date)) {
  if (!existsSync(path)) throw new Error(`缺少竞彩抓取文件：${path}。请先用 Playwright 抓 500.com 并写入。`);
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.rows ?? [];
  const collectedAt = (Array.isArray(payload) ? null : payload.collectedAt) ?? new Date().toISOString();
  return { rows, collectedAt };
}

/**
 * 把竞彩抓取数据并入当日 store:保留官方 14 场胜负彩,替换 jingcai 部分。
 * @returns {{ jingcaiFixtures, shengfucaiKept, marketSnapshots }}
 */
export function stageJingcaiIntoStore(date, rows, collectedAt) {
  const { fixtures, snapshots } = parseFiveHundredRows(rows, date, collectedAt);

  const existing = loadFixtures(date);
  const kept = existing.fixtures.filter((f) => f.marketType === "shengfucai");
  saveFixtures(date, [...kept, ...fixtures], {
    source: `${existing.source} + 500.com-jingcai-fallback`,
  });

  const prevMarket = loadMarketSnapshots(date).snapshots.filter((s) => s.marketType !== "jingcai");
  saveMarketSnapshots(date, [...prevMarket, ...snapshots], {
    source: "china-official-web + 500.com-jingcai-fallback",
  });

  return { jingcaiFixtures: fixtures.length, shengfucaiKept: kept.length, marketSnapshots: snapshots.length };
}
