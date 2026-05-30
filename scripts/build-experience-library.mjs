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
import { buildExperienceLibrary } from "../src/experience-library.js";
import { getDataDir } from "../src/paths.js";

const t0 = Date.now();
console.log("[1/3] 抓主源 18 联赛 × 5 季 …");
const main = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
console.log(`  主源:${main.matches.length} 场,带赔率 ${main.withOdds},带亚盘 ${main.withAsian},带半场 ${main.matches.filter(m=>m.halfHome!==null).length}`);

console.log("[2/3] 抓 /new/ 北欧/日职/丹超(2018+)…");
const ext = await loadFootballDataNewMatches({ files: NEW_DEFAULT_FILES, seasonFrom: 2018 });
console.log(`  /new/:${ext.matches.length} 场,${JSON.stringify(ext.byLeague)}`);

// 主源 league=代码(E0/SP1...)→ 中文名,与 fixture.competition / /new/ 键统一,查询才命中
for (const m of main.matches) m.league = LEAGUE_LABELS[m.league] ?? m.league;
const all = [...main.matches, ...ext.matches];
console.log(`[3/3] 建库(共 ${all.length} 场)…`);
const lib = buildExperienceLibrary(all);
lib.meta.builtAt = new Date().toISOString();
lib.meta.sources = { main: main.matches.length, new: ext.matches.length };

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
