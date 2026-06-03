#!/usr/bin/env node
/**
 * 把 FBref 球队 xG 画像写进指定日期的 advancedData(data.fbref,描述性,不动概率)。
 *
 * FBref 强反爬(>1req/3s 封、非浏览器UA 403)→ squad-stats 表由**浏览器层**(Playwright MCP / 系统 Chrome)
 * 抓取并 dump 成 JSON,本脚本读 dump 做匹配+归一+写盘。
 *
 * dump 文件形状(浏览器步骤产出):
 *   {
 *     "collectedAt": "ISO",
 *     "competitions": [
 *       { "name": "...", "url": "https://fbref.com/en/comps/<id>/...",
 *         "teams": { "<队名>": { mp, poss, gf, ga, xg, xga, npxg, sh, sot }, ... } }
 *     ]
 *   }
 * 浏览器抓取入口(每页 ≥3 秒间隔、用真实浏览器 UA):
 *   国家队赛事总览 https://fbref.com/en/comps/  → 取相关赛事的 "Squad Standard Stats"/"Squad Shooting" 表
 *
 * 用法:
 *   npm run sync:fbref -- --date 2026-06-02 --input D:\football-model-data\crawler\fbref-2026-06-02.json [--dry]
 */
import "../src/env.js";
import { readFileSync } from "node:fs";
import { loadFixtures } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";
import { flattenFbrefDump, buildFbrefForFixtures } from "../src/fbref-source.js";

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const dry = args.includes("--dry");
const date = getStr("--date");
const input = getStr("--input");

if (!date || !input) { console.error("用法:--date YYYY-MM-DD --input <fbref-dump.json> [--dry]"); process.exit(1); }

let dump;
try { dump = JSON.parse(readFileSync(input, "utf8")); }
catch (e) { console.error(`读 dump 失败:${e.message}`); process.exit(1); }

const teamStats = flattenFbrefDump(dump);
console.log(`FBref dump:${dump.competitions?.length ?? 0} 个赛事,${teamStats.size} 支球队有 xG 画像。`);

let set;
try { set = loadFixtures(date); } catch { console.error(`[${date}] 无 fixture`); process.exit(1); }
const fixtures = set.fixtures ?? [];

const { byFixtureId, matched, unmatched } = buildFbrefForFixtures(fixtures, teamStats);
console.log(`匹配 ${matched}/${fixtures.length} 场。未匹配球队 ${unmatched.length}${unmatched.length ? "(" + unmatched.join(", ") + ")" : ""}`);
if (unmatched.length) console.log("⚠ 未匹配多为冷门/低级别国家队(FBref xG 覆盖有限),非静默丢弃。");

const advanced = (() => { try { return loadAdvancedData(date); } catch { return { date, fixtures: [], layers: {} }; } })();
advanced.fixtures = advanced.fixtures ?? [];
advanced.layers = advanced.layers ?? {};
for (const [fixtureId, fb] of Object.entries(byFixtureId)) {
  let row = advanced.fixtures.find((r) => r.fixtureId === fixtureId);
  if (!row) { row = { fixtureId, data: {} }; advanced.fixtures.push(row); }
  row.data = row.data ?? {};
  row.data.fbref = fb;
  const h = fb.home, a = fb.away;
  console.log(`  ✓ ${h?.team ?? "?"}(xG${h?.xgFor ?? "—"}/xGA${h?.xgAgainst ?? "—"}) vs ${a?.team ?? "?"}(xG${a?.xgFor ?? "—"}/xGA${a?.xgAgainst ?? "—"})`);
}
advanced.layers.fbref = { source: "fbref", count: matched, realCount: matched, syncedAt: new Date().toISOString() };

if (dry) { console.log("（--dry 未写盘）"); process.exit(0); }
saveAdvancedData(date, advanced);
console.log(`已写入 advanced/${date}.json 的 data.fbref + layers.fbref。`);
