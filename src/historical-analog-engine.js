// 历史同联赛类比引擎 (Historical Analog Engine)
// ──────────────────────────────────────────────────────────────────────────
// 用户硬要求(2026-05-30):分析历史上同一联赛、相近"水位"(盘口深浅)、相近
// "赔率变化"(开盘→收盘漂移)的所有比赛,作为类比样本进行对比,据此给出
// 胜负平 / 半全场 / 比分推荐。
//
// 设计原则:
//   1. 纯函数 / 无 IO —— 历史比赛由调用方(CLI/管线)用 footballdata-loader 装好传入,
//      本模块只做特征提取、相似度检索、结果聚合,便于单测与回测复用。
//   2. 以"庄家热门"为参照系(favorite-frame):把每场表达成 {热门, 平, 冷门},
//      让主让/客让的历史样本可比、样本量翻倍;再按目标场的热门所在主客位
//      映射回 home/draw/away。venue(主客优势)通过 favIsHome 维度保留。
//   3. "水位" = 欧赔隐含的热门强度(让球越深 → 热门隐含概率越高);
//      "赔率变化" = 收盘隐含 − 开盘隐含的漂移(steam)。两者共同构成相似度距离。
//   4. **以胜负平方向为锚**(memory 硬规则 2026-05-29):WLD 分布是锚点,
//      半全场 / 比分只在选定的 wld 方向内取类比样本中最高频路径,不反推 wld。
//
// 输入的赔率一律是"去 vig 后的隐含概率" {home, draw, away}(footballdata-loader 已归一)。

const DEFAULT_WEIGHTS = Object.freeze({
  fav: 1.0,    // 热门水位(盘口深浅)
  dog: 1.0,    // 冷门水位
  draw: 0.5,   // 平局水位
  drift: 2.0   // 赔率变化(开→收漂移)—— 信息量大,加权
});

const DEFAULT_OPTS = Object.freeze({
  k: 60,                 // 取最近 K 个类比样本
  minAnalogs: 12,        // 少于此数判定为低置信(样本不足)
  requireSameVenue: true,// 仅匹配热门主客位相同的历史(保留主场优势)
  bandwidthFloor: 0.03,  // 高斯核带宽下限,避免全是 0 距离时塌缩
  weights: DEFAULT_WEIGHTS
});

// ── 参照系:把一场比赛(或一个目标盘口)转成热门-冷门坐标 ──────────────
// odds/oddsClose 为隐含概率 {home, draw, away};oddsClose 缺失时漂移记 0。
export function favoriteFrame(opening, closing = null) {
  if (!opening || !Number.isFinite(opening.home) || !Number.isFinite(opening.away)) return null;
  const favIsHome = opening.home >= opening.away;
  const favOpen = favIsHome ? opening.home : opening.away;
  const dogOpen = favIsHome ? opening.away : opening.home;
  const drawOpen = Number.isFinite(opening.draw) ? opening.draw : Math.max(0, 1 - favOpen - dogOpen);
  let favDrift = 0, dogDrift = 0, drawDrift = 0;
  if (closing && Number.isFinite(closing.home) && Number.isFinite(closing.away)) {
    const favClose = favIsHome ? closing.home : closing.away;
    const dogClose = favIsHome ? closing.away : closing.home;
    favDrift = favClose - favOpen;
    dogDrift = dogClose - dogOpen;
    if (Number.isFinite(closing.draw)) drawDrift = closing.draw - drawOpen;
  }
  return { favIsHome, favOpen, dogOpen, drawOpen, favDrift, dogDrift, drawDrift };
}

// ── 从一场历史比赛提取 {特征, 结果} ───────────────────────────────────
// match: footballdata-loader 的单场对象
//   { league, odds, oddsClose, homeGoals, awayGoals, halfHome, halfAway, ... }
export function extractAnalogRecord(match) {
  if (!match || !match.odds) return null;
  const frame = favoriteFrame(match.odds, match.oddsClose || null);
  if (!frame) return null;
  const fh = match.homeGoals, fa = match.awayGoals;
  if (!Number.isFinite(fh) || !Number.isFinite(fa)) return null;
  const favG = frame.favIsHome ? fh : fa;
  const dogG = frame.favIsHome ? fa : fh;
  const ft = favG > dogG ? "fav" : favG === dogG ? "draw" : "dog";
  let htRes = null, favHT = null, dogHT = null;
  if (Number.isFinite(match.halfHome) && Number.isFinite(match.halfAway)) {
    favHT = frame.favIsHome ? match.halfHome : match.halfAway;
    dogHT = frame.favIsHome ? match.halfAway : match.halfHome;
    htRes = favHT > dogHT ? "fav" : favHT === dogHT ? "draw" : "dog";
  }
  return {
    league: match.league,
    feature: frame,
    favG, dogG, favHT, dogHT, ft, htRes,
    home: match.home, away: match.away, date: match.date
  };
}

// ── 相似度距离(同参照系下的加权欧氏距离) ──────────────────────────────
export function analogDistance(a, b, weights = DEFAULT_WEIGHTS) {
  const w = weights;
  let d2 = 0;
  d2 += w.fav * (a.favOpen - b.favOpen) ** 2;
  d2 += w.dog * (a.dogOpen - b.dogOpen) ** 2;
  d2 += w.draw * (a.drawOpen - b.drawOpen) ** 2;
  d2 += w.drift * ((a.favDrift - b.favDrift) ** 2 + (a.dogDrift - b.dogDrift) ** 2);
  return Math.sqrt(d2);
}

function round(v, p = 4) { return Math.round(v * 10 ** p) / 10 ** p; }

// ── 核心:对一个目标盘口,在历史库里找类比并聚合结果 ──────────────────
// target: { league, opening:{home,draw,away}, closing?:{home,draw,away} }
// history: footballdata-loader 的 matches 数组(本模块自行提取记录)
export function analyzeHistoricalAnalogs(target, history, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options, weights: { ...DEFAULT_WEIGHTS, ...(options.weights || {}) } };
  if (!target || !target.opening) return { ok: false, reason: "no-target-odds" };
  const tFrame = favoriteFrame(target.opening, target.closing || null);
  if (!tFrame) return { ok: false, reason: "bad-target-odds" };

  // 1) 同联赛过滤 + 提取记录 + 同主客位(保留主场优势)
  const pool = [];
  for (const m of history || []) {
    if (target.league && m.league !== target.league) continue;
    const rec = extractAnalogRecord(m);
    if (!rec) continue;
    if (opts.requireSameVenue && rec.feature.favIsHome !== tFrame.favIsHome) continue;
    pool.push(rec);
  }
  if (pool.length === 0) return { ok: false, reason: "no-same-league-history", league: target.league };

  // 2) 算距离,取最近 K
  const scored = pool
    .map((rec) => ({ rec, dist: analogDistance(tFrame, rec.feature, opts.weights) }))
    .sort((x, y) => x.dist - y.dist);
  const nearest = scored.slice(0, Math.min(opts.k, scored.length));

  // 3) 高斯核加权(带宽 = 第 K 个距离,设下限防塌缩)
  const bw = Math.max(opts.bandwidthFloor, nearest[nearest.length - 1].dist || opts.bandwidthFloor);
  const weighted = nearest.map(({ rec, dist }) => ({ rec, dist, w: Math.exp(-(dist * dist) / (2 * bw * bw)) }));
  const effN = weighted.reduce((s, x) => s + x.w, 0);

  // 4) 聚合 WLD(热门参照系)
  const wldFav = { fav: 0, draw: 0, dog: 0 };
  const htft = new Map();        // `${htRes}-${ft}` -> weight
  const scoreFav = new Map();    // `${favG}-${dogG}` -> weight
  let htCovered = 0;
  for (const { rec, w } of weighted) {
    wldFav[rec.ft] += w;
    const sk = `${rec.favG}-${rec.dogG}`;
    scoreFav.set(sk, (scoreFav.get(sk) || 0) + w);
    if (rec.htRes) {
      htCovered += w;
      const hk = `${rec.htRes}-${rec.ft}`;
      htft.set(hk, (htft.get(hk) || 0) + w);
    }
  }
  const norm = (obj) => {
    const total = Object.values(obj).reduce((s, v) => s + v, 0) || 1;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / total]));
  };
  const wldFavP = norm(wldFav);

  // 5) 映射回 home/draw/away
  const toHomeFrame = (favP, drawP, dogP) =>
    tFrame.favIsHome ? { home: favP, draw: drawP, away: dogP } : { home: dogP, draw: drawP, away: favP };
  const probabilities = toHomeFrame(wldFavP.fav, wldFavP.draw, wldFavP.dog);

  // WLD 锚:argmax
  const wldKey = ["home", "draw", "away"].reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a), "home");

  // 6) 半全场:在选定 wld 方向内取最高频路径(锚一致)
  const favDir = tFrame.favIsHome ? (wldKey === "home" ? "fav" : wldKey === "away" ? "dog" : "draw")
                                  : (wldKey === "home" ? "dog" : wldKey === "away" ? "fav" : "draw");
  const halfFull = pickTopConditioned(htft, (k) => k.endsWith(`-${favDir}`), htCovered, (k) => {
    const [ht, ft] = k.split("-");
    return mapHtFtToHomeFrame(ht, ft, tFrame.favIsHome);
  });

  // 7) 比分:在选定 wld 方向内取最高频比分(映射到主客)
  const score = pickTopConditioned(scoreFav, (k) => {
    const [fg, dg] = k.split("-").map(Number);
    const dir = fg > dg ? "fav" : fg === dg ? "draw" : "dog";
    return dir === favDir;
  }, effN, (k) => {
    const [fg, dg] = k.split("-").map(Number);
    return tFrame.favIsHome ? `${fg}-${dg}` : `${dg}-${fg}`;
  });

  // 8) 置信度:有效样本量 + WLD 集中度
  const topP = probabilities[wldKey];
  const sampleFactor = Math.min(1, effN / opts.minAnalogs);
  const concentration = (topP - 1 / 3) / (2 / 3); // 0=均匀, 1=确定
  const confidence = round(Math.max(0, Math.min(1, 0.6 * sampleFactor + 0.4 * Math.max(0, concentration))));

  return {
    ok: true,
    league: target.league,
    favIsHome: tFrame.favIsHome,
    analogCount: nearest.length,
    effectiveN: round(effN, 2),
    avgDistance: round(nearest.reduce((s, x) => s + x.dist, 0) / nearest.length, 4),
    lowConfidence: effN < opts.minAnalogs,
    probabilities: { home: round(probabilities.home), draw: round(probabilities.draw), away: round(probabilities.away) },
    wld: wldKey,
    halfFull,                 // { label, probability } 或 null
    score,                    // { label, probability } 或 null
    confidence,
    samples: nearest.slice(0, 8).map(({ rec, dist }) => ({
      date: rec.date, home: rec.home, away: rec.away,
      score: tFrame.favIsHome ? `${rec.favG}-${rec.dogG}` : `${rec.dogG}-${rec.favG}`,
      ftFav: rec.ft, dist: round(dist, 3)
    }))
  };
}

function pickTopConditioned(map, predicate, denom, labelFn) {
  let bestKey = null, bestW = 0;
  for (const [k, w] of map.entries()) {
    if (!predicate(k)) continue;
    if (w > bestW) { bestW = w; bestKey = k; }
  }
  if (!bestKey) return null;
  return { label: labelFn(bestKey), probability: round((denom > 0 ? bestW / denom : 0)) };
}

// 半全场标签:fav/dog/draw 的上下半场 → 主客视角中文码 (主/平/客)
function mapHtFtToHomeFrame(ht, ft, favIsHome) {
  const map = (x) => (x === "draw" ? "平" : favIsHome ? (x === "fav" ? "主" : "客") : (x === "fav" ? "客" : "主"));
  return `${map(ht)}/${map(ft)}`;
}

// ── 类比 → 似然比信号(供 signal-fusion-layer 融合) ───────────────────
// 把类比后验相对先验的偏移转成 LR {home,draw,away},夹在 [0.5, 2.0]。
export function analogToLR(analogResult, prior, opts = {}) {
  if (!analogResult || !analogResult.ok || !prior) return null;
  const minN = opts.minEffectiveN ?? 8;
  if (analogResult.effectiveN < minN) return null; // 样本太少不发信号
  const clamp = (v) => Math.max(0.5, Math.min(2.0, v));
  const p = analogResult.probabilities;
  const lr = {};
  for (const k of ["home", "draw", "away"]) {
    const pr = prior[k];
    if (!Number.isFinite(pr) || pr <= 1e-6) { lr[k] = 1; continue; }
    lr[k] = clamp(p[k] / pr);
  }
  return lr;
}

