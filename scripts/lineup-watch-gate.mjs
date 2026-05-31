#!/usr/bin/env node
/**
 * 首发阵容轮询闸门(2026-05-31,用户硬规则:出阵容后自动分析发一份)。
 * 抓当日 ESPN 免费首发,与状态文件比对:**有新阵容出现** → exit 0(上层触发实时分析+推送);
 * 无新阵容 → exit 3(静默,不刷屏)。状态文件记已上报的 fixtureId,避免同一场重复发。
 * 用法:node scripts/lineup-watch-gate.mjs --date=YYYY-MM-DD
 * 退出码:0=有新阵容(触发),3=无新阵容/无赛程(跳过),1=出错。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchEspnLineupsForFixtures, computeLineupWatch } from "../src/lineup-source.js";
import { loadFixtures } from "../src/fixture-store.js";
import { getDataSubdir } from "../src/paths.js";

const args = process.argv.slice(2);
const getStr = (f) => {
  const eq = args.find((a) => a.startsWith(`${f}=`));
  if (eq) return eq.slice(f.length + 1);
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const date = getStr("--date") ?? new Date().toISOString().slice(0, 10);

let set;
try { set = loadFixtures(date); } catch { console.log(`[${date}] 无赛程,跳过`); process.exit(3); }
const fixtures = set.fixtures ?? [];
if (!fixtures.length) { console.log(`[${date}] 赛程为空,跳过`); process.exit(3); }

let espn;
try { espn = await fetchEspnLineupsForFixtures(date, fixtures); }
catch (e) { console.error(`抓首发失败:${e.message}`); process.exit(1); }

const dir = getDataSubdir("lineups");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "watch-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const withLineup = Object.keys(espn.fixtureData ?? {});
// 去重决策抽成纯函数 computeLineupWatch(可测,防漏推/刷屏)。
const { fresh, nextState, shouldTrigger } = computeLineupWatch(state, date, withLineup);

if (!shouldTrigger) {
  console.log(`[${date}] 已挂首发 ${withLineup.length} 场,无新增(已全部上报)→ 跳过`);
  process.exit(3);
}

// 记录已上报,避免下轮重复触发
writeFileSync(statePath, JSON.stringify(nextState, null, 0), "utf8");
for (const id of fresh) {
  const lu = espn.fixtureData[id];
  console.log(`[${date}] 新阵容:${lu.home?.team}(${lu.home?.formation}) vs ${lu.away?.team}(${lu.away?.formation})`);
}
console.log(`[${date}] 检测到 ${fresh.length} 场新首发 → 触发实时分析+推送`);
process.exit(0);
