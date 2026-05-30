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
export function getExperienceBaseline(fixture, probabilities, snapshot = null, marketProbs = null) {
  const lib = loadExperienceLibrary();
  if (!lib || !fixture?.competition || !probabilities) return null;
  const asianLine = Number(
    snapshot?.asianHandicap?.current?.line ??
      snapshot?.asianHandicap?.initial?.line ??
      snapshot?.jingcaiHandicap?.line ??
      NaN
  );
  // opening 用市场开盘隐含概率(若有)定档/算漂移;否则退回模型概率。
  // closing 用市场当前(收盘)隐含概率——开盘+收盘双价齐全才出"赔率漂移"经验。
  const opening = marketProbs?.opening ?? probabilities;
  const closing = marketProbs?.closing ?? null;
  return queryExperience(lib, {
    league: fixture.competition,
    opening,
    closing,
    asianLine: Number.isFinite(asianLine) ? asianLine : undefined,
  });
}
