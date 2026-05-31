/**
 * 经验库加载器(模块级缓存,只读一次)。
 * 经验库由 scripts/build-experience-library.mjs 落在 D:\football-model-data\experience-library.json。
 * prediction-engine 据此给 odds-only/非DC 场提供"联赛真实进球水平 + 历史平局率"的经验基线。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./paths.js";
import { queryExperience } from "./experience-library.js";

let _cache = undefined; // undefined=未读, null=不存在

export function experienceLibraryPath() {
  return join(getDataDir(), "experience-library.json");
}

export function loadExperienceLibrary() {
  if (_cache !== undefined) return _cache;
  const path = experienceLibraryPath();
  if (!existsSync(path)) {
    _cache = null;
    return null;
  }
  try {
    _cache = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    _cache = null;
  }
  return _cache;
}

/** 测试/重建后清缓存 */
export function resetExperienceLibraryCache() {
  _cache = undefined;
}

/**
 * 给一场比赛查经验基线。
 * @param {Object} fixture  需 fixture.competition(中文联赛名)
 * @param {Object} probabilities  当前模型 wld(用于定热门档)
 * @param {Object} [snapshot]  用于取亚盘线细化
 * @returns {Object|null} queryExperience 结果(含 avgGoals/wld/drawRate/scoreDist/halfFull/source)
 */
// 实时竞彩联赛短名 → 经验库 canonical 键(库键来自 footballdata-new-loader.NEW_LEAGUE_FILES
// 的长名)。修"瑞超≠瑞典超级联赛"导致联赛级经验退全局的集成缺口(2026-05-31 实盘暴露)。
const LEAGUE_ALIAS = {
  "瑞超": "瑞典超级联赛", "挪超": "挪威超级联赛", "芬超": "芬兰超级联赛", "丹超": "丹麦超级联赛",
  "日职": "日本职业联赛", "日职联": "日本职业联赛", "日本职业": "日本职业联赛",
};

/** 把实时竞彩联赛名归一到经验库键:直配 → 别名表 → 模糊(库键含短名/短名含库键 stem)→ 原名。 */
export function normalizeLeagueName(name, lib) {
  if (!name || !lib?.leagues) return name;
  if (lib.leagues[name]) return name;                 // 直配
  if (LEAGUE_ALIAS[name] && lib.leagues[LEAGUE_ALIAS[name]]) return LEAGUE_ALIAS[name]; // 别名
  const keys = Object.keys(lib.leagues);
  // 模糊:库键以短名去"超/联赛"后的 stem 开头(如 "瑞" → "瑞典超级联赛");仅当唯一命中才用
  const stem = name.replace(/超级?联?赛?$|联赛$/u, "");
  if (stem.length >= 1) {
    const hit = keys.filter((k) => k.startsWith(stem));
    if (hit.length === 1) return hit[0];
  }
  return name; // 无匹配 → 原名(queryExperience 会退全局)
}

export function getExperienceBaseline(fixture, probabilities, snapshot = null, marketProbs = null) {
  const lib = loadExperienceLibrary();
  if (!lib || !fixture?.competition || !probabilities) return null;
  const league = normalizeLeagueName(fixture.competition, lib);
  const asianLine = Number(
    snapshot?.asianHandicap?.current?.line ??
      snapshot?.asianHandicap?.initial?.line ??
      snapshot?.jingcaiHandicap?.line ??
      NaN
  );
  // opening 用市场开盘隐含概率(若有)定档;无真实开盘价则退回模型概率(仅用于定热门档)。
  // 漂移(开→收)经验只在**有真实开盘价**时才算:否则拿"模型概率 vs 收盘"算出的是假漂移,
  // /new/ 源(北欧/日职)仅收盘价 → 不报漂移(诚实降级,遵 feedback-no-fabrication-live-only)。
  const hasRealOpening = Boolean(marketProbs?.opening);
  const opening = marketProbs?.opening ?? probabilities;
  const closing = hasRealOpening ? (marketProbs?.closing ?? null) : null;
  return queryExperience(lib, {
    league,
    opening,
    closing,
    asianLine: Number.isFinite(asianLine) ? asianLine : undefined,
  });
}
