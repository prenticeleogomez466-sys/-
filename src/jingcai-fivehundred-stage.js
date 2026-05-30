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
import { scopeJingcaiFixtures } from "./jingcai-business-day.js";
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

function parseOdds(oddsCell) {
  const o = String(oddsCell ?? "").trim().split(/\s+/).map(oddsNum);
  // 让0档欧赔 = o[0..2];让球胜平负(让N档) = o[3..5]
  return { euro: { home: o[0], draw: o[1], away: o[2] }, hcp: { home: o[3], draw: o[4], away: o[5] } };
}
const validTriple = (t) => t && t.home && t.draw && t.away;

/**
 * 解析一组行(单次捕获)成 { fixtures, oddsBySeq }。
 */
function parseRows(rows) {
  const fixtures = [];
  const oddsBySeq = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const [seq, league, kickoff, teamCell, handicapCell, oddsCell] = row;
    const [homeTeam, awayTeam] = splitTeams(teamCell);
    if (!homeTeam || !awayTeam) continue;
    const key = String(seq ?? `${homeTeam}-${awayTeam}`);
    oddsBySeq.set(key, parseOdds(oddsCell));
    fixtures.push({ seq: String(seq ?? ""), league: String(league ?? "竞彩足球"), kickoff, homeTeam, awayTeam, handicapCell });
  }
  return { fixtures, oddsBySeq };
}

/**
 * 单次捕获:解析成 { fixtures, snapshots }(官方同款 shape)。initial=current。
 */
export function parseFiveHundredRows(rows, date, collectedAt = new Date().toISOString()) {
  return parseFiveHundredCaptures([{ collectedAt, rows }], date);
}

/**
 * 多次捕获:每场 initial=最早一次, current=最新一次 → 真实赔率变化(满足"每次生成必须实时赔率变化")。
 * @param {Array<{collectedAt:string, rows:Array<Array<string>>}>} captures  按时间先后
 * @param {string} date
 */
export function parseFiveHundredCaptures(captures, date, asianBySeq = null) {
  const list = (Array.isArray(captures) ? captures : []).filter((c) => c && Array.isArray(c.rows));
  if (!list.length) return { fixtures: [], snapshots: [] };
  const sorted = list.slice().sort((a, b) => String(a.collectedAt).localeCompare(String(b.collectedAt)));
  const first = parseRows(sorted[0].rows);
  const last = parseRows(sorted[sorted.length - 1].rows);
  const year = String(date).slice(0, 4);

  const fixtures = [];
  const snapshots = [];
  for (const f of last.fixtures) {
    const id = `jc-${date}-${safeName(f.seq)}-${safeName(f.homeTeam)}-${safeName(f.awayTeam)}`;
    fixtures.push({
      id, date, sequence: f.seq,
      kickoff: f.kickoff ? `${year}-${f.kickoff}` : "",
      competition: f.league, homeTeam: f.homeTeam, awayTeam: f.awayTeam,
      marketType: "jingcai", tags: ["竞彩足球", "500.com-playwright"],
      source: SCRAPE_SOURCE, officialStatus: "scraped-fallback", officialFixtureId: null,
      notes: `500.com 抓取;让球=${f.handicapCell ?? ""}`,
    });
    const cur = last.oddsBySeq.get(f.seq) ?? parseOdds("");
    const ini = first.oddsBySeq.get(f.seq) ?? cur;
    const euroIni = validTriple(ini.euro) ? ini.euro : null;
    const euroCur = validTriple(cur.euro) ? cur.euro : null;
    const hcpIni = validTriple(ini.hcp) ? ini.hcp : null;
    const hcpCur = validTriple(cur.hcp) ? cur.hcp : null;
    // 装亚盘 (asian 由调用方注入,seq → { iniHome,iniLine,iniAway,curHome,curLine,curAway,book })
    const asianRaw = asianBySeq?.[f.seq];
    const asianHandicap = buildAsianHandicapSnapshot(asianRaw);
    // 竞彩官方让球线:从 handicapCell("0 -1" / "单关 0 -2" / "0 +1")解析整数让球数(主队视角,负=让、正=受让)。
    const jingcaiLine = parseJingcaiHandicapLine(f.handicapCell);
    snapshots.push({
      date, fixtureId: id, sequence: f.seq, marketType: "jingcai",
      competition: f.league, homeTeam: f.homeTeam, awayTeam: f.awayTeam,
      collectedAt: sorted[sorted.length - 1].collectedAt,
      europeanOdds: euroIni || euroCur ? { initial: euroIni ?? euroCur, current: euroCur ?? euroIni } : null,
      asianHandicap,
      jingcaiHandicap: jingcaiLine !== null ? { line: jingcaiLine, source: "500.com-jczq" } : null,
      handicapOdds: hcpIni || hcpCur ? { initial: hcpIni ?? hcpCur, current: hcpCur ?? hcpIni } : null,
      capturedTimes: sorted.map((c) => c.collectedAt),
      source: SCRAPE_SOURCE,
    });
  }
  return { fixtures, snapshots };
}

// 从竞彩让球单元格解析整数让球线(主队视角)。格式:"0 -1" / "单关 0 -2" / "0 +1" / "0"。
// "0" 是让0档标记,其后带符号的整数才是竞彩让球数;无带符号整数(纯让0)返回 null。
export function parseJingcaiHandicapLine(cell) {
  const m = String(cell ?? "").match(/[+-]\d+/);
  if (!m) return null;
  const line = Number(m[0]);
  return Number.isFinite(line) ? line : null;
}

/**
 * 读取抓取 JSON 文件。支持三种形态:
 *   - 裸 rows 数组
 *   - { rows, collectedAt }(单次)
 *   - { captures:[{collectedAt,rows}], asian:{seq:{...}} }(多次捕获,有真实赔率变化)
 * @returns {{ captures, asian }}
 */
export function loadScrapeFile(date, path = scrapeFilePath(date)) {
  if (!existsSync(path)) throw new Error(`缺少竞彩抓取文件：${path}。请先用 Playwright 抓 500.com 并写入。`);
  const payload = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(payload)) return { captures: [{ collectedAt: new Date().toISOString(), rows: payload }], asian: {} };
  if (Array.isArray(payload.captures)) return { captures: payload.captures, asian: payload.asian ?? {} };
  return { captures: [{ collectedAt: payload.collectedAt ?? new Date().toISOString(), rows: payload.rows ?? [] }], asian: payload.asian ?? {} };
}

/**
 * 中文亚盘语义 → 主队让球数(主队视角,负=主队让球,正=主队受让)。
 * 来源:500.com/皇冠常用术语。例 "受让半球" → 主队 +0.5(客队让 -0.5);"球半" → 主队 -1.5。
 */
const ASIAN_LINE_LEXICON = {
  "平手": 0,
  "平手/半球": -0.25, "平半": -0.25,
  "半球": -0.5,
  "半球/一球": -0.75, "半/一": -0.75,
  "一球": -1.0,
  "一球/球半": -1.25, "一/球半": -1.25,
  "球半": -1.5,
  "球半/两球": -1.75, "球半/二": -1.75,
  "两球": -2.0, "二球": -2.0,
  "两球/两球半": -2.25,
  "两球半": -2.5, "二球半": -2.5,
  "受让平手/半球": 0.25, "受让平半": 0.25,
  "受让半球": 0.5,
  "受让半球/一球": 0.75, "受让半/一": 0.75,
  "受让一球": 1.0,
  "受让一球/球半": 1.25, "受让一/球半": 1.25,
  "受让球半": 1.5,
  "受让球半/两球": 1.75,
  "受让两球": 2.0, "受让二球": 2.0
};

export function parseAsianLineText(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t) return null;
  if (ASIAN_LINE_LEXICON.hasOwnProperty(t)) return ASIAN_LINE_LEXICON[t];
  // 数字直传(已经是 -0.5 / 0.5 这种格式)
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

function buildAsianHandicapSnapshot(raw) {
  if (!raw) return null;
  const iniLine = parseAsianLineText(raw.iniLine);
  const curLine = parseAsianLineText(raw.curLine);
  const iniHome = Number(raw.iniHome);
  const iniAway = Number(raw.iniAway);
  const curHome = Number(raw.curHome);
  const curAway = Number(raw.curAway);
  const initial = Number.isFinite(iniLine) || Number.isFinite(iniHome)
    ? { line: iniLine, homeWater: Number.isFinite(iniHome) ? iniHome : null, awayWater: Number.isFinite(iniAway) ? iniAway : null }
    : null;
  const current = Number.isFinite(curLine) || Number.isFinite(curHome)
    ? { line: curLine, homeWater: Number.isFinite(curHome) ? curHome : null, awayWater: Number.isFinite(curAway) ? curAway : null }
    : null;
  if (!initial && !current) return null;
  return { initial: initial ?? current, current: current ?? initial, book: raw.book ?? null };
}

/**
 * 把竞彩抓取数据(多次捕获)并入当日 store:保留官方 14 场胜负彩,替换 jingcai 部分。
 * @param {Array<{collectedAt,rows}>} captures
 * @param {Object} [asianBySeq] 可选:每场亚盘 dict { 周五001: {iniLine, curLine, ...} }
 * @returns {{ jingcaiFixtures, shengfucaiKept, marketSnapshots }}
 */
export function stageJingcaiIntoStore(date, captures, asianBySeq = null) {
  const { fixtures, snapshots } = parseFiveHundredCaptures(captures, date, asianBySeq);

  const existing = loadFixtures(date);
  const kept = existing.fixtures.filter((f) => f.marketType === "shengfucai");
  // 按业务日覆盖式落盘:限当日 + 跨源去重,杜绝次日(周日)场次/重复源累加进当日文件。
  const scoped = scopeJingcaiFixtures(date, [...kept, ...fixtures]);
  saveFixtures(date, scoped, {
    source: `${existing.source} + 500.com-jingcai-fallback`,
  });

  const prevMarket = loadMarketSnapshots(date).snapshots.filter((s) => s.marketType !== "jingcai");
  saveMarketSnapshots(date, [...prevMarket, ...snapshots], {
    source: "china-official-web + 500.com-jingcai-fallback",
  });

  return { jingcaiFixtures: fixtures.length, shengfucaiKept: kept.length, marketSnapshots: snapshots.length };
}
