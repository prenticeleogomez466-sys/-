/**
 * 建经验库:抓 football-data 主源(18 欧洲联赛 × 5 季,带亚盘+开收赔率+半场)
 *   + /new/(北欧/日职/丹超 14 季,收盘赔率)→ buildExperienceLibrary → 落盘。
 * 用法:node scripts/build-experience-library.mjs
 * 产物:D:\football-model-data\experience-library.json
 */
import "../src/env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFootballDataMatches, ALL_LEAGUES, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { loadFootballDataNewMatches, NEW_DEFAULT_FILES } from "../src/footballdata-new-loader.js";
import { loadEspnResults } from "../src/espn-results-source.js";
import { fetchTsdbRoundResults } from "../src/thesportsdb-results-source.js";
import { buildExperienceLibrary } from "../src/experience-library.js";
import { getDataDir } from "../src/paths.js";

// ESPN 补**不与 football-data/new 重叠**的热门联赛(日职/北欧已在 /new/,排除避免碎片化)。
// 纯赛果(无赔率)→ 只进联赛级经验:平局率/主客胜率/场均进球/比分分布/大小球。用户点名:日韩(韩)/澳超 + 其它热门。
const ESPN_EXPERIENCE_LEAGUES = ["usa.1", "bra.1", "ksa.1", "chn.1", "arg.1", "mex.1", "aus.1"]; // kor.1 ESPN 无数据→走 TheSportsDB
const ESPN_FROM = process.env.ESPN_EXP_FROM || "2023-01-01";
const ESPN_TO = process.env.ESPN_EXP_TO || new Date().toISOString().slice(0, 10);

// TheSportsDB 逐轮源:补 ESPN/football-data 都不覆盖的联赛(韩K = K League 1, id 4689)。参数化便于以后加。
const TSDB_LEAGUES = [{ leagueId: "4689", label: "韩K", seasons: ["2022", "2023", "2024", "2025"] }];

const t0 = Date.now();
console.log("[1/4] 抓主源 18 联赛 × 5 季 …");
const main = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
console.log(`  主源:${main.matches.length} 场,带赔率 ${main.withOdds},带亚盘 ${main.withAsian},带半场 ${main.matches.filter(m=>m.halfHome!==null).length}`);

console.log("[2/4] 抓 /new/ 北欧/日职/丹超(2018+)…");
const ext = await loadFootballDataNewMatches({ files: NEW_DEFAULT_FILES, seasonFrom: 2018 });
console.log(`  /new/:${ext.matches.length} 场,${JSON.stringify(ext.byLeague)}`);

console.log(`[3/4] 抓 ESPN 纯赛果热门联赛(${ESPN_FROM}~${ESPN_TO}):MLS/巴甲/沙特/中超/阿甲/墨超/韩K/澳超 …`);
const espn = await loadEspnResults({ leagues: ESPN_EXPERIENCE_LEAGUES, from: ESPN_FROM, to: ESPN_TO });
// 归一成经验库 match shape:无半场/无赔率/无亚盘,显式置 null 让 halfFull/赔率档优雅降级。
const espnMatches = (espn.matches ?? []).map((m) => ({ league: m.league, homeGoals: m.homeGoals, awayGoals: m.awayGoals, halfHome: null, halfAway: null, odds: null, oddsClose: null, asian: null }));
console.log(`  ESPN:${espnMatches.length} 场,${JSON.stringify(espn.byLeague)}`);

console.log("[4/5] 抓 TheSportsDB 逐轮源(韩K = K League 1)…");
const tsdbMatches = [];
const tsdbBy = {};
for (const cfg of TSDB_LEAGUES) {
  const res = await fetchTsdbRoundResults(cfg);
  tsdbMatches.push(...res.matches);
  tsdbBy[cfg.label] = res.count;
}
console.log(`  TheSportsDB:${tsdbMatches.length} 场,${JSON.stringify(tsdbBy)}`);

// 主源 league=代码(E0/SP1...)→ 中文名,与 fixture.competition / /new/ 键统一,查询才命中
for (const m of main.matches) m.league = LEAGUE_LABELS[m.league] ?? m.league;
const all = [...main.matches, ...ext.matches, ...espnMatches, ...tsdbMatches];
console.log(`[5/5] 建库(共 ${all.length} 场)…`);
const lib = buildExperienceLibrary(all);
lib.meta.builtAt = new Date().toISOString();
lib.meta.sources = { main: main.matches.length, new: ext.matches.length, espn: espnMatches.length, tsdb: tsdbMatches.length };

const path = join(getDataDir(), "experience-library.json");
writeFileSync(path, JSON.stringify(lib), "utf8");

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(JSON.stringify({
  ok: true,
  path,
  elapsedSec: Number(elapsed),
  totalMatches: lib.meta.totalMatches,
  usedMatches: lib.meta.usedMatches,
  leagues: lib.meta.leagues,
  sampleLeagues: Object.fromEntries(Object.entries(lib.leagues).slice(0, 8).map(([k, v]) => [k, v.n])),
}, null, 2));
