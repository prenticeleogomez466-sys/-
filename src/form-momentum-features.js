/**
 * Rolling Form + Momentum 特征工程
 * ──────────────────────────────────────────────────
 * 顶级模型的命中率主要来自**特征工程**而非算法.这里实现:
 *
 *   1. Rolling form(滚动 form):最近 5/10/15 场加权得分率
 *   2. Momentum(势头):最近 3 场 vs 之前 7 场对比(球队是否在上升期)
 *   3. xG quality(xG 把握率):实际进球 / 预期进球(>1 = 把握率高)
 *   4. Defensive solidity:最近 N 场失球 vs 对手 xG(防守效率)
 *   5. Cleansheet rate:最近 N 场零封率
 *   6. Big-game form:对强队(对手 Elo > +100)的最近表现
 *   7. Home-away split:主场表现 vs 客场表现差
 *
 * 直接命中率提升:这些特征直接喂给 DC / Pi / stacker,
 * 解决"近期 form 过于简单"的痛点.
 */

/**
 * 给一组球队近期比赛,算所有 form features.
 *
 * @param {Array} recent [{ opponent, isHome, gf, ga, opponentRating, xgFor, xgAgainst, date }]
 *   按时间升序(最新在末)
 * @returns {Object} feature dict
 */
export function buildFormFeatures(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return null;

  const sorted = [...recent].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return {
    rollingForm5: rollingForm(sorted, 5),
    rollingForm10: rollingForm(sorted, 10),
    rollingForm15: rollingForm(sorted, 15),
    momentum: momentumScore(sorted),
    xgQuality: xgQualityScore(sorted),
    defensiveSolidity: defensiveSolidity(sorted),
    cleansheetRate: cleansheetRate(sorted, 10),
    bigGameForm: bigGameForm(sorted),
    homeAwaySplit: homeAwaySplit(sorted),
    sampleSize: sorted.length
  };
}

function rollingForm(matches, n) {
  const slice = matches.slice(-n);
  if (!slice.length) return null;
  let points = 0;
  for (const m of slice) {
    if (m.gf > m.ga) points += 3;
    else if (m.gf === m.ga) points += 1;
  }
  return round(points / (slice.length * 3));  // [0, 1]
}

function momentumScore(matches) {
  if (matches.length < 10) return null;
  const last3 = matches.slice(-3);
  const prev7 = matches.slice(-10, -3);
  const ppm3 = last3.reduce((s, m) => s + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0) / 3;
  const ppm7 = prev7.reduce((s, m) => s + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0) / 7;
  return round(ppm3 - ppm7);  // 正 = 上升期
}

function xgQualityScore(matches) {
  const valid = matches.filter((m) => Number.isFinite(Number(m.xgFor)) && Number(m.xgFor) > 0);
  if (valid.length < 3) return null;
  const goalsRatio = valid.reduce((s, m) => s + Number(m.gf), 0);
  const xgRatio = valid.reduce((s, m) => s + Number(m.xgFor), 0);
  return round(goalsRatio / Math.max(0.01, xgRatio));  // >1 = 把握率超 xG 预期
}

function defensiveSolidity(matches) {
  const valid = matches.filter((m) => Number.isFinite(Number(m.xgAgainst)) && Number(m.xgAgainst) > 0);
  if (valid.length < 3) return null;
  const goalsAgainst = valid.reduce((s, m) => s + Number(m.ga), 0);
  const xgAgainst = valid.reduce((s, m) => s + Number(m.xgAgainst), 0);
  // <1 = 防守好(失球低于对手 xG)
  return round(goalsAgainst / Math.max(0.01, xgAgainst));
}

function cleansheetRate(matches, n) {
  const slice = matches.slice(-n);
  if (!slice.length) return null;
  const cs = slice.filter((m) => Number(m.ga) === 0).length;
  return round(cs / slice.length);
}

function bigGameForm(matches) {
  const big = matches.filter((m) => Number(m.opponentRating) >= 1600);
  if (big.length < 2) return null;
  const points = big.reduce((s, m) => s + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0);
  return round(points / (big.length * 3));
}

function homeAwaySplit(matches) {
  const home = matches.filter((m) => m.isHome);
  const away = matches.filter((m) => !m.isHome);
  if (home.length < 3 || away.length < 3) return null;
  const homePts = home.reduce((s, m) => s + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0) / home.length;
  const awayPts = away.reduce((s, m) => s + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0) / away.length;
  return round(homePts - awayPts);  // 正 = 主场优势明显
}

/**
 * 把两队 feature 对比成"特征差"向量,可直接喂 stacker / KNN.
 */
export function buildMatchupFeatures(homeFeatures, awayFeatures) {
  if (!homeFeatures || !awayFeatures) return null;
  return {
    formGap5: nullSafeSub(homeFeatures.rollingForm5, awayFeatures.rollingForm5),
    formGap10: nullSafeSub(homeFeatures.rollingForm10, awayFeatures.rollingForm10),
    momentumGap: nullSafeSub(homeFeatures.momentum, awayFeatures.momentum),
    xgQualityGap: nullSafeSub(homeFeatures.xgQuality, awayFeatures.xgQuality),
    defGap: nullSafeSub(awayFeatures.defensiveSolidity, homeFeatures.defensiveSolidity),  // 注意:防守低=好
    cleansheetGap: nullSafeSub(homeFeatures.cleansheetRate, awayFeatures.cleansheetRate),
    bigGameGap: nullSafeSub(homeFeatures.bigGameForm, awayFeatures.bigGameForm),
    homeAdvantageEffect: homeFeatures.homeAwaySplit
  };
}

function nullSafeSub(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return round(a - b);
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
