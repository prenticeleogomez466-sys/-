#!/usr/bin/env node
/**
 * 把 API-Football 近期状态特征写进指定日期的 advancedData(data.apiFootball,描述性,不动概率)。
 *
 * 用法:
 *   npm run sync:api-football -- --date 2026-06-02            # 默认近10场、预算90次/天
 *   npm run sync:api-football -- --date 2026-06-02 --last 8 --budget 80 --dry
 *
 * 需要免费 key:在 D:\football-model-data\local.env 加一行 API_FOOTBALL_KEY=你的key
 *   (注册:https://dashboard.api-football.com/register —— 免费层 100 次/天)
 * 无 key 时本脚本优雅退出(0),模型照常诚实跑、该层标缺失。
 */
import "../src/env.js";
import { loadFixtures } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";
import { apiFootballConfigured, resolveTeamId, fetchTeamRecentForm, buildFixtureTeamTraits } from "../src/api-football-source.js";

const args = process.argv.slice(2);
const getStr = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const date = getStr("--date");
const last = Number(getStr("--last", "10"));
const budget = Number(getStr("--budget", "90"));
const dry = args.includes("--dry");

if (!date) { console.error("用法:--date YYYY-MM-DD [--last 10] [--budget 90] [--dry]"); process.exit(1); }

if (!apiFootballConfigured()) {
  console.log("⚠ 未配置 API_FOOTBALL_KEY —— 跳过(模型照常跑,该层标缺失)。");
  console.log("  注册免费 key:https://dashboard.api-football.com/register(100次/天)");
  console.log("  然后在 D:\\football-model-data\\local.env 加一行:API_FOOTBALL_KEY=你的key");
  process.exit(0);
}

let set;
try { set = loadFixtures(date); } catch { console.error(`[${date}] 无 fixture`); process.exit(1); }
const fixtures = set.fixtures ?? [];
console.log(`[${date}] ${fixtures.length} 场,预算 ${budget} 次,近 ${last} 场算状态。`);

const cache = {}; // 本次运行内存缓存(resolveTeamId 也会读盘)
let calls = 0;
const overBudget = () => calls >= budget;
const traitCache = new Map(); // teamId → trait(同一队两场只取一次)

async function teamTrait(name) {
  if (overBudget()) return { trait: null, dropped: true };
  const id = await resolveTeamId(name, { cache }); calls++; // search(命中盘缓存时其实不耗网,但保守计数)
  if (!id) return { trait: null, unresolved: true };
  if (traitCache.has(id)) return { trait: traitCache.get(id) };
  if (overBudget()) return { trait: null, dropped: true };
  const trait = await fetchTeamRecentForm(id, { last }); calls++;
  traitCache.set(id, trait);
  return { trait };
}

const advanced = (() => { try { return loadAdvancedData(date); } catch { return { date, fixtures: [], layers: {} }; } })();
advanced.fixtures = advanced.fixtures ?? [];
advanced.layers = advanced.layers ?? {};

let matched = 0, dropped = 0; const unresolved = new Set();
for (const fx of fixtures) {
  if (overBudget()) { dropped++; continue; }
  const h = await teamTrait(fx.homeTeam);
  const a = await teamTrait(fx.awayTeam);
  if (h.unresolved) unresolved.add(fx.homeTeam);
  if (a.unresolved) unresolved.add(fx.awayTeam);
  if (h.dropped || a.dropped) { dropped++; continue; }
  const traits = buildFixtureTeamTraits(h.trait, a.trait);
  if (!traits) continue;
  let row = advanced.fixtures.find((r) => r.fixtureId === fx.id);
  if (!row) { row = { fixtureId: fx.id, data: {} }; advanced.fixtures.push(row); }
  row.data = row.data ?? {};
  row.data.apiFootball = traits;
  matched++;
  console.log(`  ✓ ${fx.homeTeam}(${traits.home?.form ?? "—"}) vs ${fx.awayTeam}(${traits.away?.form ?? "—"})${Number.isFinite(traits.formDiff) ? ` 状态差 ${traits.formDiff}` : ""}`);
}

advanced.layers.apiFootball = { source: "api-football", count: matched, realCount: matched, syncedAt: new Date().toISOString(), last };

console.log(`\n汇总:写入 ${matched} 场 · 预算用 ${calls}/${budget} 次 · 因预算跳过 ${dropped} 场 · 未解析球队 ${unresolved.size}${unresolved.size ? "(" + [...unresolved].join(", ") + ")" : ""}`);
if (dropped) console.log(`⚠ 有 ${dropped} 场因 100次/天 预算未取(非静默截断)。可分日跑或调 --budget/--last。`);

if (dry) { console.log("（--dry 未写盘）"); process.exit(0); }
saveAdvancedData(date, advanced);
console.log(`已写入 advanced/${date}.json 的 data.apiFootball + layers.apiFootball。`);
