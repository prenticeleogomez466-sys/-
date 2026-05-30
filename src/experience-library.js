/**
 * 经验库(experience-library)
 * ──────────────────────────────────────────────────────────────────────
 * 用户要求:"抓取学习近五年各联赛历史 + 所有水位盘口 + SP变化做经验分析,以后新比赛
 * 直接去经验库里查相似情境。"
 *
 * 本模块把全历史(football-data 主源 18 欧洲联赛 + /new/ 北欧/日职等)按
 *   (联赛, 热门方, 热门强度档[, 亚盘线档, 开→收漂移档])
 * 聚合成经验性结果分布:
 *   - wld           胜/平/负 经验频率(含 drawRate,供平局风险提示)
 *   - scoreDist     精确比分经验直方图(按联赛真实进球水平,不再千篇一律)
 *   - halfFull      半全场经验直方图(仅有半场数据的主源场计入)
 *   - avgGoals      该桶主/客场均进球(= λ 经验代理,喂泊松矩阵)
 *
 * 解决"比分像模仿":λ 不再由 wld 概率凭空映射,而是查该联赛该档历史真实进球。
 * 解决"没有平局":drawRate 暴露真实平局率,prediction-engine 据此给平局风险提示。
 *
 * 诚实:/new/ 联赛无半场→halfFull.n=0;无开盘→无 drift 档,只按 favTier 聚合。
 */

// 热门强度分档(用 favorite 隐含概率)
const FAV_BANDS = [
  [0.33, 0.42, "弱热"],
  [0.42, 0.5, "小热"],
  [0.5, 0.6, "中热"],
  [0.6, 0.7, "强热"],
  [0.7, 0.82, "大热"],
  [0.82, 1.01, "超热"],
];

function favBand(p) {
  for (const [lo, hi, label] of FAV_BANDS) if (p >= lo && p < hi) return label;
  return "弱热";
}

// 一场 → favorite-frame:谁是热门(home/away/draw-lean)+ 热门概率
export function frameOf(prob) {
  if (!prob) return null;
  const { home, draw, away } = prob;
  const top = Math.max(home, draw, away);
  let side = "home";
  if (away === top) side = "away";
  else if (draw === top) side = "draw";
  // 用 home/away 的较大者定档(平局极少为最大,draw-lean 也按强侧定档)
  const favP = Math.max(home, away);
  return { side: side === "draw" ? (home >= away ? "home" : "away") : side, favProb: favP, drawProb: draw };
}

// 亚盘线分档(主队视角整数/半档):用于主源亚盘细化键
function asianBand(line) {
  if (line === null || line === undefined || !Number.isFinite(line)) return null;
  const a = Math.abs(line);
  const sign = line < 0 ? "主让" : line > 0 ? "主受" : "平手";
  if (a === 0) return "平手";
  if (a <= 0.5) return `${sign}半`;
  if (a <= 1) return `${sign}一`;
  if (a <= 1.5) return `${sign}球半`;
  if (a <= 2) return `${sign}两`;
  return `${sign}两半+`;
}

// 赔率开→收漂移分档:学"赔率变化方向→结果"。以收盘(最锐价)定热门方,量该方
// 开→收隐含概率位移:走强=被加注(steam in)、走弱=被抛(drift out)。
// 仅主源同时有开盘(odds)+收盘(oddsClose)才分档;只有单边价的场返回 null,优雅降级。
function driftBand(opening, closing) {
  if (!opening || !closing) return null;
  const cf = frameOf(closing);
  if (!cf || cf.side === "draw") return null;
  const side = cf.side; // home/away
  const openP = side === "home" ? opening.home : opening.away;
  const closeP = side === "home" ? closing.home : closing.away;
  if (!Number.isFinite(openP) || !Number.isFinite(closeP)) return null;
  const shift = closeP - openP;
  if (shift >= 0.03) return "热门走强"; // 收盘比开盘更看好热门(被加注)
  if (shift <= -0.03) return "热门走弱"; // 收盘转冷(被抛/冷门加注)
  return "盘口平稳";
}

function scoreKey(h, a) {
  // 比分封顶,避免长尾(>=4 归到 4)
  const cap = (x) => Math.min(x, 4);
  return `${cap(h)}-${cap(a)}`;
}

function halfFullKey(m) {
  if (m.halfHome === null || m.halfAway === null) return null;
  const sign = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
  return `${sign(m.halfHome, m.halfAway)}-${sign(m.homeGoals, m.awayGoals)}`;
}

function emptyBucket() {
  return { n: 0, sumH: 0, sumA: 0, wld: { home: 0, draw: 0, away: 0 }, scores: new Map(), htN: 0, hf: new Map(), ou: { o15: 0, o25: 0, o35: 0 } };
}

function addToBucket(b, m) {
  b.n += 1;
  b.sumH += m.homeGoals;
  b.sumA += m.awayGoals;
  // 大小球(总进球)经验:学"该情境历史进多少球"——over1.5/2.5/3.5 真实命中
  const total = m.homeGoals + m.awayGoals;
  if (total >= 2) b.ou.o15 += 1;
  if (total >= 3) b.ou.o25 += 1;
  if (total >= 4) b.ou.o35 += 1;
  const r = m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw";
  b.wld[r] += 1;
  const sk = scoreKey(m.homeGoals, m.awayGoals);
  b.scores.set(sk, (b.scores.get(sk) ?? 0) + 1);
  const hf = halfFullKey(m);
  if (hf) {
    b.htN += 1;
    b.hf.set(hf, (b.hf.get(hf) ?? 0) + 1);
  }
}

function finalizeBucket(b) {
  if (!b.n) return null;
  const dist = (map, n) =>
    [...map.entries()].map(([k, c]) => ({ key: k, prob: c / n })).sort((x, y) => y.prob - x.prob);
  return {
    n: b.n,
    avgGoals: { home: b.sumH / b.n, away: b.sumA / b.n },
    wld: { home: b.wld.home / b.n, draw: b.wld.draw / b.n, away: b.wld.away / b.n },
    drawRate: b.wld.draw / b.n,
    // 大小球经验频率(总进球 over X.5 = total ≥ X+1):avgTotal 与三条主流盘口的真实命中率
    overUnder: {
      avgTotal: (b.sumH + b.sumA) / b.n,
      over15: b.ou.o15 / b.n,
      over25: b.ou.o25 / b.n,
      over35: b.ou.o35 / b.n,
    },
    scoreDist: dist(b.scores, b.n).slice(0, 12),
    halfFull: { n: b.htN, dist: b.htN ? dist(b.hf, b.htN).slice(0, 9) : [] },
  };
}

/**
 * 构建经验库。
 * @param {Array} matches  统一 match shape(footballdata-loader / footballdata-new-loader)
 */
export function buildExperienceLibrary(matches) {
  const leagues = new Map(); // league → { all:bucket, tiers:Map(tierKey→bucket), asianTiers:Map }
  let used = 0;
  for (const m of matches) {
    const prob = m.oddsClose || m.odds; // 收盘优先(最有效价),无则开盘
    if (!prob || m.homeGoals === null || m.awayGoals === null) continue;
    const frame = frameOf(prob);
    if (!frame) continue;
    used += 1;
    const lg = m.league;
    if (!leagues.has(lg)) leagues.set(lg, { all: emptyBucket(), tiers: new Map(), asianTiers: new Map(), driftTiers: new Map() });
    const L = leagues.get(lg);
    addToBucket(L.all, m);
    const tierKey = `${frame.side}|${favBand(frame.favProb)}`;
    if (!L.tiers.has(tierKey)) L.tiers.set(tierKey, emptyBucket());
    addToBucket(L.tiers.get(tierKey), m);
    // 赔率漂移细化(需开盘+收盘双价):学该联赛"赔率变化方向→结果"
    const db = driftBand(m.odds, m.oddsClose);
    if (db) {
      const dKey = `${frame.side}|${db}`;
      if (!L.driftTiers.has(dKey)) L.driftTiers.set(dKey, emptyBucket());
      addToBucket(L.driftTiers.get(dKey), m);
    }
    // 亚盘细化(仅主源有 asian.line)
    const ab = asianBand(m.asian?.lineClose ?? m.asian?.line ?? null);
    if (ab) {
      const aKey = `${frame.side}|${ab}`;
      if (!L.asianTiers.has(aKey)) L.asianTiers.set(aKey, emptyBucket());
      addToBucket(L.asianTiers.get(aKey), m);
    }
  }

  const global = emptyBucket();
  const leaguesOut = {};
  for (const [lg, L] of leagues) {
    // 累积 global
    global.n += L.all.n;
    global.sumH += L.all.sumH;
    global.sumA += L.all.sumA;
    for (const k of ["home", "draw", "away"]) global.wld[k] += L.all.wld[k];
    for (const k of ["o15", "o25", "o35"]) global.ou[k] += L.all.ou[k];
    for (const [k, c] of L.all.scores) global.scores.set(k, (global.scores.get(k) ?? 0) + c);
    global.htN += L.all.htN;
    for (const [k, c] of L.all.hf) global.hf.set(k, (global.hf.get(k) ?? 0) + c);

    const tiers = {};
    for (const [k, b] of L.tiers) tiers[k] = finalizeBucket(b);
    const asianTiers = {};
    for (const [k, b] of L.asianTiers) asianTiers[k] = finalizeBucket(b);
    const driftTiers = {};
    for (const [k, b] of L.driftTiers) driftTiers[k] = finalizeBucket(b);
    leaguesOut[lg] = { ...finalizeBucket(L.all), tiers, asianTiers, driftTiers, hasHalfTime: L.all.htN > 0 };
  }

  return {
    meta: {
      totalMatches: matches.length,
      usedMatches: used,
      leagues: Object.keys(leaguesOut).length,
      favBands: FAV_BANDS.map((b) => b[2]),
      builtAt: null, // 由调用方写入(脚本里 Date 不可用,落盘后戳)
    },
    leagues: leaguesOut,
    global: finalizeBucket(global),
  };
}

const MIN_TIER_N = 30; // 档样本下限,不足退回联赛级
const MIN_LEAGUE_N = 40; // 联赛样本下限,不足退回 global

/**
 * 给一场比赛查"赔率开→收漂移"经验:同联赛同热门方+漂移方向的历史 WLD/大小球。
 * 需 opening + closing 双价才能定漂移方向;只有单价或样本不足返回 null。
 * @returns {Object|null} { driftBand, side, n, wld, drawRate, overUnder }
 */
function queryDriftContext(L, q) {
  if (!L || !q.opening || !q.closing) return null;
  const db = driftBand(q.opening, q.closing);
  if (!db) return null;
  const cf = frameOf(q.closing);
  if (!cf) return null;
  const b = L.driftTiers?.[`${cf.side}|${db}`];
  if (!b || b.n < MIN_TIER_N) return null;
  return { driftBand: db, side: cf.side, n: b.n, wld: b.wld, drawRate: b.drawRate, overUnder: b.overUnder };
}

/**
 * 查询经验库:给新比赛找最相似历史情境。
 * @param {Object} lib  buildExperienceLibrary 产物
 * @param {Object} q    { league, opening:{home,draw,away}, closing?, asianLine? }
 * @returns {Object|null} { source, n, avgGoals, wld, drawRate, scoreDist, halfFull, overUnder, matchedKey, drift? }
 */
export function queryExperience(lib, q) {
  if (!lib?.leagues) return null;
  const prob = q.closing || q.opening;
  const frame = frameOf(prob);
  if (!frame) return null;
  const L = lib.leagues[q.league];
  // 赔率漂移情境(独立于主基线档,附加在结果上供透明展示)
  const drift = queryDriftContext(L, q);
  const withDrift = (r) => (drift ? { ...r, drift } : r);
  // 1) 亚盘细化档(主源,最精确)
  if (L && q.asianLine !== null && q.asianLine !== undefined) {
    const ab = asianBand(q.asianLine);
    const k = `${frame.side}|${ab}`;
    const b = L.asianTiers?.[k];
    if (b && b.n >= MIN_TIER_N) return withDrift({ ...b, source: `联赛+亚盘档(${q.league}/${k})`, matchedKey: k });
  }
  // 2) 联赛 + 热门强度档
  if (L) {
    const k = `${frame.side}|${favBand(frame.favProb)}`;
    const b = L.tiers?.[k];
    if (b && b.n >= MIN_TIER_N) return withDrift({ ...b, source: `联赛+热门档(${q.league}/${k})`, matchedKey: k });
    // 3) 联赛级
    if (L.n >= MIN_LEAGUE_N) return withDrift({ ...L, tiers: undefined, asianTiers: undefined, driftTiers: undefined, source: `联赛级(${q.league})`, matchedKey: "league" });
  }
  // 4) 全局兜底
  if (lib.global) return withDrift({ ...lib.global, source: "全局经验", matchedKey: "global" });
  return null;
}
