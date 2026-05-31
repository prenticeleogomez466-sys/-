/**
 * 一次性启动评级系统(D 档接入 daily 流水线)
 * ──────────────────────────────────────────────────
 * daily-evolution 启动时调一次 bootstrapRatings():
 *
 *   1. 加载 fixture-store 所有历史比赛 + result
 *   2. 训练 Pi-ratings、Massey、Colley、Bivariate Poisson、Hierarchical Poisson
 *   3. 返回 wrapped object,prediction-engine 内部按 fixture 调用
 *
 * 设计原则:
 *   - 失败不阻塞:任何一个评级失败(样本不足等)→ 该评级返回 null,其他继续
 *   - 缓存友好:同 process 多次调 bootstrapRatings 用 memoize
 *   - 可选择性加载:opts.includeMassey/Colley 等可关掉重模型
 *   - 不抓 OpenFootball(那个走 daily 的 advanced-data-sync 异步刷新,bootstrap 不等)
 */

import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { fitPiRatings } from "./pi-ratings.js";
import { fitMasseyRatings } from "./massey-ratings.js";
import { fitColleyRatings } from "./colley-ratings.js";
import { fitBivariatePoisson } from "./bivariate-poisson.js";
import { fitHierarchicalPoisson } from "./hierarchical-poisson.js";
import { canonicalTeamName } from "./team-aliases.js";

const DEFAULT_MAX_DATES = 180;  // 回溯 180 个比赛日

// 进程级 memoize
let memo = null;
let memoKey = null;

export function bootstrapRatings(opts = {}) {
  const maxDates = opts.maxDates ?? DEFAULT_MAX_DATES;
  const key = `${maxDates}:${opts.includeMassey ?? 1}:${opts.includeColley ?? 1}:${opts.includeBivariate ?? 1}:${opts.includeHier ?? 1}:${opts.includePi ?? 1}`;
  if (memo && memoKey === key) return memo;

  const matches = collectHistoricalMatches(maxDates);

  const result = {
    samples: matches.length,
    maxDates,
    generatedAt: new Date().toISOString(),
    pi: null,
    massey: null,
    colley: null,
    bivariate: null,
    hierarchical: null
  };

  if (matches.length < 5) {
    memo = result;
    memoKey = key;
    return result;
  }

  if (opts.includePi !== 0) {
    try { result.pi = fitPiRatings(matches); } catch (e) { result.pi = { ok: false, error: e.message }; }
  }
  if (opts.includeMassey !== 0) {
    try { result.massey = fitMasseyRatings(matches); } catch (e) { result.massey = { ok: false, error: e.message }; }
  }
  if (opts.includeColley !== 0) {
    try { result.colley = fitColleyRatings(matches); } catch (e) { result.colley = { ok: false, error: e.message }; }
  }
  if (opts.includeBivariate !== 0) {
    try { result.bivariate = fitBivariatePoisson(matches); } catch (e) { result.bivariate = { ok: false, error: e.message }; }
  }
  if (opts.includeHier !== 0) {
    try { result.hierarchical = fitHierarchicalPoisson(matches); } catch (e) { result.hierarchical = { ok: false, error: e.message }; }
  }

  memo = result;
  memoKey = key;
  return result;
}

// 从 fixture-store 收集有 result 的历史比赛,带 league 字段(给 Hierarchical 用)
export function collectHistoricalMatches(maxDates = DEFAULT_MAX_DATES) {
  const dates = listFixtureDates().slice(0, maxDates);
  const matches = [];
  for (const date of dates) {
    const { fixtures } = loadFixtures(date);
    for (const f of fixtures) {
      if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
      const home = canonicalTeamName(f.homeTeam);
      const away = canonicalTeamName(f.awayTeam);
      if (!home || !away) continue;
      matches.push({
        home, away,
        homeGoals: f.result.home,
        awayGoals: f.result.away,
        // 半场比分 + 历史市场维(2026-05-31 富集后 33k+ 场可用):供半全场/大小球/数据变化
        // 小模型自主读取,缺则 null/undefined,下游按 available 判定不编造。
        halfHome: f.result.halfHome ?? null,
        halfAway: f.result.halfAway ?? null,
        marketHistorical: f.marketHistorical ?? null,
        date: f.date,
        league: f.competition ?? "unknown"
      });
    }
  }
  return matches;
}

// 单元测试 hook
export function __resetBootstrapMemoForTests() {
  memo = null;
  memoKey = null;
}
