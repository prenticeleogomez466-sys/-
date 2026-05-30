#!/usr/bin/env node
/**
 * 把 Sofascore 免授权伤停写进指定日期的 advanced-data injuries 层(激活多联赛 injury 信号)。
 *
 * Sofascore 有 Cloudflare,Node 直连 403 → 赛程/lineups 的 raw JSON 由**浏览器层**抓
 * (Playwright MCP / 系统 Chrome),存成一个 dump 文件,本脚本读它做匹配+归一+写盘。
 *
 * dump 文件格式(浏览器步骤产出):
 *   { "events": [ {id, homeTeam:{name}, awayTeam:{name}, ...}, ... ],
 *     "lineups": { "<eventId>": { home:{missingPlayers:[...]}, away:{missingPlayers:[...]} }, ... } }
 *
 * 用法:
 *   npm run sync:injuries:sofascore -- --date 2026-05-30 --input D:\football-model-data\crawler\sofascore-2026-05-30.json
 *   加 --dry 只看不写盘。
 */
import { readFileSync } from "node:fs";
import { buildInjuriesFromSofascore } from "../src/sofascore-injury-source.js";
import { loadFixtures } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const dry = args.includes("--dry");
const date = getStr("--date");
const input = getStr("--input");

if (!date || !input) {
  console.error("用法:--date YYYY-MM-DD --input <sofascore-dump.json> [--dry]");
  process.exit(1);
}

let dump;
try { dump = JSON.parse(readFileSync(input, "utf8")); }
catch (e) { console.error(`读 dump 失败:${e.message}`); process.exit(1); }

const events = dump.events ?? [];
const lineupsByEventId = dump.lineups ?? {};
console.log(`Sofascore dump:${events.length} 赛事,${Object.keys(lineupsByEventId).length} 场 lineups。`);

let set;
try { set = loadFixtures(date); }
catch { console.error(`[${date}] 无 fixture`); process.exit(1); }

const { byFixtureId, matched } = buildInjuriesFromSofascore(set.fixtures ?? [], events, lineupsByEventId);
if (!matched) {
  console.log(`[${date}] 无 fixture 匹配到 Sofascore 伤停(队名别名未覆盖或当日无缺阵)。`);
  process.exit(0);
}

const advanced = loadAdvancedData(date);
const fixturesById = new Map((advanced.fixtures ?? []).map((f) => [f.fixtureId, f]));
for (const fx of set.fixtures ?? []) {
  const layer = byFixtureId[fx.id];
  if (!layer) continue;
  const existing = fixturesById.get(fx.id) ?? { fixtureId: fx.id, data: {} };
  existing.data = { ...(existing.data ?? {}), injuries: layer };
  fixturesById.set(fx.id, existing);
  console.log(`[${date}] ${fx.homeTeam} vs ${fx.awayTeam}: 主 ${layer.home.length} 缺 / 客 ${layer.away.length} 缺(source=sofascore)`);
}

if (dry) { console.log(`[${date}] [--dry] 命中 ${matched} 场,未写盘`); process.exit(0); }

const layers = { ...(advanced.layers ?? {}), injuries: { ok: true, count: matched, source: "sofascore-lineups", importanceEstimated: true } };
saveAdvancedData(date, { layers, fixtures: [...fixturesById.values()] });
console.log(`[${date}] 已写入 advanced-data,${matched} 场带 Sofascore injuries 层。`);
