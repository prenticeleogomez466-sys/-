/**
 * Line Movement Backtest(X 档 — 量化"市场未消化信息"这块饼有多大)
 * ────────────────────────────────────────────────────────────
 * 用 football-data.co.uk 同时含开盘/收盘的场次,诚实回答两个问题:
 *   1. 收盘线比开盘线准多少?(= 开盘后市场消化的信息量上限)
 *   2. 盘口朝某 outcome 移动时,该 outcome 真的更常赢吗?(漂移方向的预测力)
 *
 * 这不是可直接落地的实战增益(收盘只在 kickoff 已知,见 line-movement-signal 的泄漏
 * 边界),而是为 line-movement 信号定标:漂移确有预测力 → 实战用「开盘→当前」漂移
 * 才有依据;若收盘≈开盘,则这条信号天花板很低,别高估。
 */

import { loadFootballDataMatches } from "./footballdata-loader.js";
import { analyzeLineMovement } from "./line-movement-signal.js";

const OUTCOMES = ["home", "draw", "away"];

function actualOutcome(hg, ag) {
  if (hg > ag) return "home";
  if (hg < ag) return "away";
  return "draw";
}
function favoriteOf(p) {
  return OUTCOMES.reduce((b, o) => (p[o] > p[b] ? o : b), "home");
}
function brier(p, a) { return OUTCOMES.reduce((s, o) => s + (p[o] - (a === o ? 1 : 0)) ** 2, 0); }
function logLoss(p, a) { return -Math.log(Math.max(1e-12, p[a])); }
function round(v) { return Math.round(v * 10000) / 10000; }

function makeAcc() { return { n: 0, hit: 0, brier: 0, logLoss: 0 }; }
function record(acc, p, a) {
  acc.n++;
  if (favoriteOf(p) === a) acc.hit++;
  acc.brier += brier(p, a);
  acc.logLoss += logLoss(p, a);
}
function finalize(acc) {
  const n = acc.n || 1;
  return { tested: acc.n, accuracy: round(acc.hit / n), brier: round(acc.brier / n), logLoss: round(acc.logLoss / n) };
}

/**
 * @param {{leagues?, seasons?, fetch?, steamThreshold?}} opts
 */
export async function runLineMovementBacktest(opts = {}) {
  const steamThreshold = opts.steamThreshold ?? 0.03;
  const loaded = await loadFootballDataMatches({ leagues: opts.leagues, seasons: opts.seasons, fetch: opts.fetch });
  if (!loaded.ok) return { ok: false, reason: "football-data 加载失败(网络?)" };

  const arms = { open: makeAcc(), close: makeAcc(), pinnacleOpen: makeAcc(), pinnacleClose: makeAcc() };
  // 漂移预测力:在"有显著 steam"的场次里,比较 steam 指向的 outcome 命中率 vs 开盘 favorite 命中率
  const steam = { matches: 0, steamHit: 0, openFavHit: 0, agreeWithOpenFav: 0 };
  let bothCount = 0;

  for (const m of loaded.matches) {
    const a = actualOutcome(m.homeGoals, m.awayGoals);
    if (m.odds) record(arms.open, m.odds, a);
    if (m.oddsClose) record(arms.close, m.oddsClose, a);
    if (m.oddsPinnacle) record(arms.pinnacleOpen, m.oddsPinnacle, a);
    if (m.oddsPinnacleClose) record(arms.pinnacleClose, m.oddsPinnacleClose, a);

    if (m.odds && m.oddsClose) {
      bothCount++;
      const analysis = analyzeLineMovement(m.odds, m.oddsClose);
      if (analysis && analysis.totalMovement >= steamThreshold) {
        steam.matches++;
        const openFav = favoriteOf(m.odds);
        if (analysis.steamOutcome === a) steam.steamHit++;
        if (openFav === a) steam.openFavHit++;
        if (analysis.steamOutcome === openFav) steam.agreeWithOpenFav++;
      }
    }
  }

  return {
    ok: true,
    source: "football-data.co.uk",
    loadedMatches: loaded.matches.length,
    withClosing: loaded.withClosing,
    withPinnacle: loaded.withPinnacle,
    bothOpenClose: bothCount,
    arms: {
      open: finalize(arms.open),
      close: finalize(arms.close),
      pinnacleOpen: finalize(arms.pinnacleOpen),
      pinnacleClose: finalize(arms.pinnacleClose)
    },
    steam: {
      threshold: steamThreshold,
      matches: steam.matches,
      steamOutcomeHitRate: steam.matches ? round(steam.steamHit / steam.matches) : null,
      openFavoriteHitRate: steam.matches ? round(steam.openFavHit / steam.matches) : null,
      steamAgreesWithOpenFavRate: steam.matches ? round(steam.agreeWithOpenFav / steam.matches) : null
    },
    note: "close/pinnacleClose 含赛前全部公开信息(只在 kickoff 已知,实战不可用作 prior);" +
      "steamOutcomeHitRate > openFavoriteHitRate 说明跟随盘口移动方向有预测力。"
  };
}
