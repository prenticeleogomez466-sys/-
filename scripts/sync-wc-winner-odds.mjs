#!/usr/bin/env node
/**
 * 世界杯夺冠盘(outright winner)实时同步 —— 把直接夺冠期货赔率喂进世界杯大模型的市场项。
 * ════════════════════════════════════════════════════════════════════
 * 模型的市场夺冠率本就读 team-priors.json 的 title_odds(超算 blend=0.65市场+0.35模型),
 * 但 title_odds 此前是静态写死。本步用 The Odds API 拉【实时 Betfair 夺冠盘】刷新 title_odds,
 * 让超算原生吃到当下最锐利的"谁夺冠"市场信号 —— 不另起分离分析,融进同一个模型。
 *
 * 流程:拉 outright → 选最锐源(优先 Betfair 交易所) → 存 wc-winner-odds.json(留档) →
 *   按 .en 名(+少量别名)对回 team-priors.teams → 更新 title_odds(只更新匹配到的,其余保留) → 写回。
 * 遵 no-fabrication:拉不到/某队无盘 → 该队 title_odds 原样保留,不臆造;并如实报告未匹配队。
 * 用法: node scripts/sync-wc-winner-odds.mjs [--dry]
 */
import "../src/env.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry");
const DATA = "D:/football-model-data/world-cup/2026";
const ODDS_FILE = "D:/football-model-data/world-cup/wc-winner-odds.json";
const TP_FILE = join(DATA, "team-priors.json");
// 夺冠盘英文名 → team-priors .en 的少量差异别名(其余按 .en 精确匹配)
const ALIAS = {
  "USA": "United States", "United States": "USA",
  "South Korea": "Korea Republic", "Korea Republic": "South Korea",
  "Ivory Coast": "Côte d'Ivoire", "Czech Republic": "Czechia",
  "Czechia": "Czech Republic", "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Turkiye": "Turkey", "Curacao": "Curaçao",
};

async function fetchOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return null;
  const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup_winner/odds?apiKey=${key}&regions=eu,uk&markets=outrights&oddsFormat=decimal`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!r.ok) { console.log(`拉取失败 HTTP ${r.status} → 回退已存盘`); return null; }
    const j = await r.json();
    writeFileSync(ODDS_FILE, JSON.stringify(j, null, 1));
    console.log(`✅ 实时拉取夺冠盘,剩余配额 ${r.headers.get("x-requests-remaining") ?? "?"}`);
    return j;
  } catch (e) { console.log(`拉取异常 ${e.message} → 回退已存盘`); return null; }
}

function pickBook(event) {
  const bks = event?.bookmakers ?? [];
  return bks.find((b) => /betfair/i.test(b.key)) ?? bks[0] ?? null;
}

const j = (await fetchOdds()) ?? (existsSync(ODDS_FILE) ? JSON.parse(readFileSync(ODDS_FILE, "utf8")) : null);
if (!j?.length) { console.log("无夺冠盘数据(拉取失败且无存盘),title_odds 保持不变。"); process.exit(0); }
const book = pickBook(j[0]);
const outcomes = book?.markets?.find((m) => m.key === "outrights")?.outcomes ?? [];
if (!outcomes.length) { console.log("夺冠盘无 outrights 项,保持不变。"); process.exit(0); }

const liveOdds = new Map(outcomes.map((o) => [o.name, Number(o.price)]));
const tp = JSON.parse(readFileSync(TP_FILE, "utf8"));
let updated = 0; const unmatched = [];
for (const [zh, t] of Object.entries(tp.teams)) {
  const en = t.en;
  const price = liveOdds.get(en) ?? liveOdds.get(ALIAS[en]);
  if (Number.isFinite(price) && price > 1) {
    if (!DRY) t.title_odds = price;
    updated++;
  } else unmatched.push(`${zh}(${en})`);
}
tp._title_odds_source = `The Odds API outright (${book.title}, ${book.last_update ?? "?"})`;
if (!DRY) writeFileSync(TP_FILE, JSON.stringify(tp, null, 1));
console.log(`源:${book.title} | 更新 title_odds ${updated} 队${DRY ? "(--dry未写)" : ""} | 未匹配 ${unmatched.length}:${unmatched.slice(0, 8).join("、")}${unmatched.length > 8 ? "…" : ""}`);
console.log("下一步:重跑 node scripts/run-worldcup-supercomputer.mjs --json --xlsx 即用实时夺冠盘融合。");
