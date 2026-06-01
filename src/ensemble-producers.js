/**
 * 集成 producer 层(2026-06-01)——胜负平 10 路独立子模型,供 ratings-ensemble 融合。
 * ════════════════════════════════════════════════════════════════════
 * 用户:"胜负平模型两者太少,增加成 10 层融合,吸取最有用的。"
 * 本模块把仓库已有的多种方法收编成 10 路独立 1X2 producer,每路自出 {home,draw,away} 或 null。
 * 融合权重由 leak-safe 回测学(backtest-ensemble-1x2.mjs),没用/冗余的路自动低权重——
 * 不靠堆数量,靠回测择优。诚实:多路相关(强度类 pi/massey/colley/elo、泊松类 dc/bvp/skellam),
 * 融合相关路收益有限,回测会显示权重集中。
 *
 * 10 路:
 *   1 market      市场赔率隐含(去 vig)——含全部公开信息,通常最强
 *   2 dc          Dixon-Coles τ 泊松
 *   3 bvp         双变量泊松(共同分量建正相关)
 *   4 pi          Pi-ratings(主客分维度)
 *   5 massey      Massey 评级(进球差最小二乘)
 *   6 colley      Colley 评级(胜平负)
 *   7 skellam     DC λ 的 Skellam 进球差分布 → 1X2
 *   8 experience  同联赛×热门强度档 的历史经验频率(纯经验,非模型)
 *   9 leaguePrior 联赛主/平/客 基础频率(正则化先验)
 *  10 elo         ClubElo/Elo 评级(数据缺则 null)
 */
import { predictFromFitted } from "./dixon-coles-engine.js";
import { skellamPMF } from "./skellam-distribution.js";

const clamp01 = (v) => Math.max(1e-9, Math.min(1 - 1e-9, v));
function norm(p) {
  if (!p) return null;
  const h = Number(p.home), d = Number(p.draw), a = Number(p.away);
  if (![h, d, a].every(Number.isFinite)) return null;
  const t = h + d + a;
  if (t <= 0) return null;
  return { home: h / t, draw: d / t, away: a / t };
}

// Skellam(diff) → 1X2:P(diff>0)/P(0)/P(diff<0)
function skellam1x2(lh, la) {
  if (!(lh > 0) || !(la > 0)) return null;
  let home = 0, draw = 0, away = 0;
  for (let k = -12; k <= 12; k++) {
    const p = skellamPMF(k, lh, la);
    if (!Number.isFinite(p)) continue;
    if (k > 0) home += p; else if (k === 0) draw += p; else away += p;
  }
  return norm({ home, draw, away });
}

export const PRODUCER_KEYS = ["market", "dc", "bvp", "pi", "massey", "colley", "skellam", "experience", "leaguePrior", "elo"];

/**
 * 给一场比赛产出 10 路 1X2 分布。
 * @param {object} fits   { dc, bvp, pi, massey, colley, eloPredict } 已拟合方法
 * @param {object} match  { home, away, league, marketProbs }(marketProbs=去vig隐含或 null)
 * @param {object} tables { experience: Map(`${league}|${favBucket}`→{h,d,a,n}), leaguePrior: Map(league→{h,d,a,n}) }
 * @returns {Record<string,{home,draw,away}|null>}
 */
export function buildOneX2Producers(fits, match, tables = {}) {
  const { home, away, league } = match;
  const out = {};

  out.market = norm(match.marketProbs);

  const dc = fits.dc ? predictFromFitted(fits.dc, { homeTeam: home, awayTeam: away }) : null;
  out.dc = dc?.probabilities ? norm(dc.probabilities) : null;

  out.bvp = (() => { try { return norm(fits.bvp?.predict?.(home, away)?.probabilities); } catch { return null; } })();
  out.pi = (() => { try { return norm(fits.pi?.predictWinProb?.(home, away)); } catch { return null; } })();
  out.massey = (() => { try { return norm(fits.massey?.predictWinProb?.(home, away)); } catch { return null; } })();
  out.colley = (() => { try { return norm(fits.colley?.predictWinProb?.(home, away)); } catch { return null; } })();

  // skellam 用 DC 的 λ(同源但不同分布假设/平局处理)
  out.skellam = dc?.expectedGoals ? skellam1x2(dc.expectedGoals.home, dc.expectedGoals.away) : null;

  // 经验:同 league × 市场热门强度档 的历史 wld 频率
  const favBucket = (() => {
    const m = out.market;
    if (!m) return "na";
    const fav = Math.max(m.home, m.draw, m.away);
    return fav >= 0.65 ? "strong" : fav >= 0.55 ? "lean" : "flip";
  })();
  const expRow = tables.experience?.get(`${league}|${favBucket}`);
  out.experience = expRow && expRow.n >= 30 ? norm({ home: expRow.h, draw: expRow.d, away: expRow.a }) : null;

  const lpRow = tables.leaguePrior?.get(league);
  out.leaguePrior = lpRow && lpRow.n >= 30 ? norm({ home: lpRow.h, draw: lpRow.d, away: lpRow.a }) : null;

  out.elo = (() => { try { return norm(fits.eloPredict?.(home, away)); } catch { return null; } })();

  return out;
}

/** 从训练集构建 经验(league×favBucket)+ 联赛先验 频率表。leak-safe:只传训练集。 */
export function buildEmpiricalTables(trainMatches, marketProbOf) {
  const experience = new Map();
  const leaguePrior = new Map();
  for (const m of trainMatches) {
    if (m.homeGoals == null || m.awayGoals == null) continue;
    const r = m.homeGoals > m.awayGoals ? "h" : m.homeGoals === m.awayGoals ? "d" : "a";
    const lg = m.league ?? "?";
    const lp = leaguePrior.get(lg) ?? { h: 0, d: 0, a: 0, n: 0 };
    lp[r]++; lp.n++; leaguePrior.set(lg, lp);

    const mp = marketProbOf ? marketProbOf(m) : null;
    let bucket = "na";
    if (mp) { const fav = Math.max(mp.home, mp.draw, mp.away); bucket = fav >= 0.65 ? "strong" : fav >= 0.55 ? "lean" : "flip"; }
    const key = `${lg}|${bucket}`;
    const ex = experience.get(key) ?? { h: 0, d: 0, a: 0, n: 0 };
    ex[r]++; ex.n++; experience.set(key, ex);
  }
  // 频率转概率(拉普拉斯平滑)
  const toProb = (row) => ({ h: (row.h + 1) / (row.n + 3), d: (row.d + 1) / (row.n + 3), a: (row.a + 1) / (row.n + 3), n: row.n });
  for (const [k, v] of experience) experience.set(k, toProb(v));
  for (const [k, v] of leaguePrior) leaguePrior.set(k, toProb(v));
  return { experience, leaguePrior };
}

export { clamp01, norm };
