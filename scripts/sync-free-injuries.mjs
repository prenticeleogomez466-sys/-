#!/usr/bin/env node
/**
 * 抓 FPL 免授权伤停,写进指定日期的 advanced-data injuries 层,激活融合层 injury 信号。
 * 用法:
 *   npm run sync:injuries -- --date 2026-05-30
 *   npm run sync:injuries -- --date 2026-05-30 --dry   # 只看不写盘
 * 无 --date 时:对 fixture-store 里所有日期分别处理(通常只有今日竞彩那天有数据)。
 */
import { fetchFplInjuries, injuriesForFixture } from "../src/free-injury-source.js";
import { loadFixtures } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";
import { listFixtureDates } from "../src/fixture-store.js";

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const dry = args.includes("--dry");
const dateArg = getStr("--date");

console.log("抓 FPL 免授权伤停(fantasy.premierleague.com)...");
const fpl = await fetchFplInjuries();
if (!fpl.ok) { console.error("失败:", fpl.reason); process.exit(1); }
console.log(`FPL:${fpl.teamCount} 队有伤停,共 ${fpl.totalAbsences} 条(status i/d/s,已排除转会 u)。\n`);

const dates = dateArg ? [dateArg] : safeDates();
if (!dates.length) { console.log("无 fixture 日期可处理。"); process.exit(0); }

for (const date of dates) {
  let set;
  try { set = loadFixtures(date); } catch { console.log(`[${date}] 无 fixture,跳过`); continue; }
  const advanced = loadAdvancedData(date);
  const fixturesById = new Map((advanced.fixtures ?? []).map((f) => [f.fixtureId, f]));
  let matched = 0;
  for (const fx of set.fixtures ?? []) {
    const layer = injuriesForFixture(fx, fpl.byTeam);
    if (!layer) continue;
    matched++;
    const existing = fixturesById.get(fx.id) ?? { fixtureId: fx.id, data: {} };
    existing.data = { ...(existing.data ?? {}), injuries: layer };
    fixturesById.set(fx.id, existing);
    console.log(`[${date}] ${fx.homeTeam} vs ${fx.awayTeam}: 主${layer.home.length}伤 / 客${layer.away.length}伤`);
  }
  if (!matched) { console.log(`[${date}] 无英超对阵匹配到 FPL 伤停(竞彩多为非英超 → 正常)`); continue; }
  const fixtures = [...fixturesById.values()];
  const layers = { ...(advanced.layers ?? {}), injuries: { ok: true, count: matched, source: "fpl-bootstrap-static" } };
  if (dry) { console.log(`[${date}] [--dry] 命中 ${matched} 场,未写盘`); continue; }
  saveAdvancedData(date, { layers, fixtures });
  console.log(`[${date}] 已写入 advanced-data,${matched} 场带 injuries 层。`);
}

function safeDates() {
  try { return listFixtureDates(); } catch { return []; }
}
