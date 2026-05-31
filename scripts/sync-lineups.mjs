#!/usr/bin/env node
/**
 * 抓 ESPN 免授权首发阵容,写进指定日期的 advanced-data lineups 层,激活融合层 lineup 信号。
 * ESPN summary 零授权、Node 直连,覆盖日职/K联/MLS/巴甲/中超/沙特/北欧等薄数据联赛。
 * 用法:
 *   npm run sync:lineups -- --date 2026-05-31
 *   npm run sync:lineups -- --date 2026-05-31 --dry   # 只看不写盘
 * 无 --date 时:对 fixture-store 里所有日期分别处理。
 * 注:首发赛前约 1 小时挂出,过早跑会匹配不到首发(正常)。
 */
import { fetchEspnLineupsForFixtures } from "../src/lineup-source.js";
import { loadFixtures, listFixtureDates } from "../src/fixture-store.js";
import { loadAdvancedData, saveAdvancedData } from "../src/advanced-data-store.js";

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const dry = args.includes("--dry");
const dateArg = getStr("--date");

const dates = dateArg ? [dateArg] : safeDates();
if (!dates.length) { console.log("无 fixture 日期可处理。"); process.exit(0); }

for (const date of dates) {
  let set;
  try { set = loadFixtures(date); } catch { console.log(`[${date}] 无 fixture,跳过`); continue; }
  console.log(`[${date}] 抓 ESPN 免授权首发(覆盖日职/K联/MLS/巴甲/中超/沙特/北欧…)...`);
  const espn = await fetchEspnLineupsForFixtures(date, set.fixtures ?? []);
  if (!espn.count) { console.log(`[${date}] 无 ESPN 联赛对阵匹配到首发(非 ESPN 联赛/赛前过早 → 正常)`); continue; }

  const advanced = loadAdvancedData(date);
  const fixturesById = new Map((advanced.fixtures ?? []).map((f) => [f.fixtureId, f]));
  for (const fx of set.fixtures ?? []) {
    const layer = espn.fixtureData[fx.id];
    if (!layer) continue;
    const existing = fixturesById.get(fx.id) ?? { fixtureId: fx.id, sequence: fx.sequence, homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, data: {} };
    existing.data = { ...(existing.data ?? {}), lineups: layer };
    fixturesById.set(fx.id, existing);
    const hf = layer.home?.formation ?? "?";
    const af = layer.away?.formation ?? "?";
    console.log(`[${date}] ${fx.homeTeam} vs ${fx.awayTeam}: 主阵型 ${hf} / 客阵型 ${af}${layer.confirmed ? "(已确认)" : "(预测)"}`);
  }
  if (dry) { console.log(`[${date}] [--dry] 命中 ${espn.count} 场,未写盘`); continue; }
  const fixtures = [...fixturesById.values()];
  const layers = { ...(advanced.layers ?? {}), lineups: { ok: true, count: espn.count, source: espn.source } };
  saveAdvancedData(date, { layers, fixtures });
  console.log(`[${date}] 已写入 advanced-data,${espn.count} 场带 lineups 层。`);
}

function safeDates() {
  try { return listFixtureDates(); } catch { return []; }
}
