#!/usr/bin/env node
/**
 * 把 Understat 免费真 xG 写进指定日期的 advanced-data xg 层(给 DC λ 更真的进球期望)。
 *
 * Understat 反爬挡 Node → teamsData 由**浏览器层**抓(Playwright/系统 Chrome):
 *   对每个联赛 navigate 到 https://understat.com/league/<LG>/<season>,
 *   browser_evaluate(() => teamsData) 取页面内嵌对象,多联赛 merge 成一个 dump:
 *     { "teamsData": { "<teamId>": { title, history:[{date,xG,xGA,...}] }, ... } }
 *   存 D:\football-model-data\crawler\understat-<season>.json
 *
 * 用法:
 *   npm run sync:understat -- --date 2026-05-31 --input D:\football-model-data\crawler\understat-2025.json
 *   加 --dry 只看不写盘。
 */
import { readFileSync } from "node:fs";
import { buildXgLayerFromUnderstat } from "../src/understat-source.js";
import { loadFixtures } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const dry = args.includes("--dry");
const date = getStr("--date");
const input = getStr("--input");

if (!date || !input) {
  console.error("用法:--date YYYY-MM-DD --input <understat-dump.json> [--dry]");
  process.exit(1);
}

let dump;
try { dump = JSON.parse(readFileSync(input, "utf8")); }
catch (e) { console.error(`读 dump 失败:${e.message}`); process.exit(1); }
const teamsData = dump.teamsData ?? dump;
console.log(`Understat dump:${Object.keys(teamsData).length} 队 xG 形态。`);

let set;
try { set = loadFixtures(date); }
catch { console.error(`[${date}] 无 fixture`); process.exit(1); }

// 防泄漏:只用严格早于比赛日的场算近期 xG 形态
const { byFixtureId, matched } = buildXgLayerFromUnderstat(set.fixtures ?? [], teamsData, { beforeDate: date, n: 6 });
if (!matched) {
  console.log(`[${date}] 无 fixture 匹配到 Understat(当日非五大联赛,或队名别名未覆盖)。`);
  process.exit(0);
}

const advanced = loadAdvancedData(date);
const fixturesById = new Map((advanced.fixtures ?? []).map((f) => [f.fixtureId, f]));
for (const fx of set.fixtures ?? []) {
  const layer = byFixtureId[fx.id];
  if (!layer) continue;
  const existing = fixturesById.get(fx.id) ?? { fixtureId: fx.id, sequence: fx.sequence, homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, data: {} };
  existing.data = { ...(existing.data ?? {}), xg: layer };
  fixturesById.set(fx.id, existing);
  console.log(`[${date}] ${fx.homeTeam} vs ${fx.awayTeam}: 真xG 主${layer.home.xg} / 客${layer.away.xg}(source=understat)`);
}

if (dry) { console.log(`[${date}] [--dry] 命中 ${matched} 场,未写盘`); process.exit(0); }
const layers = { ...(advanced.layers ?? {}), xg: { ok: true, count: matched, source: "understat", proxy: false } };
saveAdvancedData(date, { layers, fixtures: [...fixturesById.values()] });
console.log(`[${date}] 已写入 advanced-data,${matched} 场带 Understat 真 xG 层。`);
