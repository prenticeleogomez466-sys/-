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
import { loadFixtures, mergeFixtureLists, stableFixtureKey } from "../src/fixture-store.js";
import { getDataSubdir } from "../src/paths.js";
import { shanghaiDateOf, isoAddDays, kickoffEpochMs } from "../src/kickoff-time.js";

const args = process.argv.slice(2);
const getStr = (f) => {
  const eq = args.find((a) => a.startsWith(`${f}=`));
  if (eq) return eq.slice(f.length + 1);
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
// 时区/业务日根修(缺陷#10,2026-06-10):
//   ① 旧默认 toISOString()(UTC 日历日)——北京 00:00-08:00 取出昨天日期;改 Intl 上海业务日。
//   ② 只盯"今天"一个业务日文件:当日文件 03:01 才生成 → 00:00-03:00 赛程恒空;
//      跨午夜开球(世界杯 02:00/03:00 场)归前一业务日文件 → 永远盯不到。
//      改为今天+昨天两个业务日合并盯防(已开赛的场剔除,首发推送只对赛前有意义)。
const date = getStr("--date") ?? shanghaiDateOf();
const prevDate = isoAddDays(date, -1);

const loadSafe = (d) => { try { return loadFixtures(d).fixtures ?? []; } catch { return []; } };
const nowMs = Date.now();
const fixtures = mergeFixtureLists(loadSafe(date), loadSafe(prevDate))
  // 已开赛(按真实 kickoff epoch,缺时刻按当日 23:59 保守保留)的场不再盯首发
  .filter((f) => { const ko = kickoffEpochMs(f); return ko === null || ko > nowMs; });
if (!fixtures.length) { console.log(`[${date}+${prevDate}] 赛程为空(双业务日均无未开赛场),跳过`); process.exit(3); }

let espn;
try { espn = await fetchEspnLineupsForFixtures(date, fixtures); }
catch (e) { console.error(`抓首发失败:${e.message}`); process.exit(1); }

const dir = getDataSubdir("lineups");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "watch-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

// 状态键改稳定键(真实赛日+主客队):同场跨业务日文件 id 不同(jc-06-09-4001 vs jc500-06-10-4001),
// 旧的按 fixture.id 记已上报在合并盯防下会重复推送。
const byId = new Map(fixtures.map((f) => [String(f.id), f]));
const keyToId = new Map();
for (const id of Object.keys(espn.fixtureData ?? {})) {
  const f = byId.get(String(id));
  if (f) keyToId.set(stableFixtureKey(f), id);
}
const withLineup = [...keyToId.keys()];
// 去重决策抽成纯函数 computeLineupWatch(可测,防漏推/刷屏)。
// extraSeenDates=昨天:昨天业务日已上报过的场(跨午夜合并盯防后会再次出现)不得重复触发。
const { fresh, nextState, shouldTrigger } = computeLineupWatch(state, date, withLineup, { extraSeenDates: [prevDate] });

if (!shouldTrigger) {
  console.log(`[${date}+${prevDate}] 已挂首发 ${withLineup.length} 场,无新增(已全部上报)→ 跳过`);
  process.exit(3);
}

// 记录已上报,避免下轮重复触发
writeFileSync(statePath, JSON.stringify(nextState, null, 0), "utf8");
for (const key of fresh) {
  const lu = espn.fixtureData[keyToId.get(key)];
  console.log(`[${date}] 新阵容:${lu.home?.team}(${lu.home?.formation}) vs ${lu.away?.team}(${lu.away?.formation})`);
}
console.log(`[${date}] 检测到 ${fresh.length} 场新首发 → 触发实时分析+推送`);
process.exit(0);
