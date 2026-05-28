/**
 * Big-game Form 强强对决专项
 * ──────────────────────────────────────────────────
 * 球队对"高 Elo 对手"的表现跟总 form 不同:
 *   - 顶级球队 vs 中弱队:胜率 70%+,但 vs 同级强队:胜率 40-50%
 *   - 防守反击型球队对强队反而更稳(战术克制)
 *   - 部分球队"大场怯场" → 对强队胜率低
 *
 * 算 big-game adjusted form:
 *   - 普通 form = 所有比赛 PPM
 *   - big-game form = vs ELO ≥ X 对手的 PPM
 *   - 差值 = big-game readiness factor
 *
 * 用途:
 *   - 预测强强对决时,优先用 big-game form 替代普通 form
 *   - 识别"看上去 form 好但对强队拉胯"的球队
 */

const DEFAULT_BIG_GAME_ELO_THRESHOLD = 1600;  // 通常顶级球队 ELO 区间
const MIN_BIG_GAME_SAMPLES = 5;

/**
 * 从历史 form 数据算 big-game form.
 *
 * @param {Array} matches  球队 perspective 的近期比赛
 *   [{ opponentElo, gf, ga, isHome }]
 * @param {Object} opts  eloThreshold, minSamples
 */
export function computeBigGameForm(matches, opts = {}) {
  const threshold = opts.eloThreshold ?? DEFAULT_BIG_GAME_ELO_THRESHOLD;
  const minSamples = opts.minSamples ?? MIN_BIG_GAME_SAMPLES;
  if (!Array.isArray(matches) || !matches.length) return null;

  const all = matches.filter((m) => Number.isFinite(Number(m.gf)) && Number.isFinite(Number(m.ga)));
  const bigGames = all.filter((m) => Number(m.opponentElo) >= threshold);

  if (all.length < 3) return null;

  const allPpm = computePpm(all);
  const allGoalsFor = mean(all.map((m) => Number(m.gf)));
  const allGoalsAgainst = mean(all.map((m) => Number(m.ga)));

  if (bigGames.length < minSamples) {
    return {
      allPpm: round(allPpm),
      bigGameDataAvailable: false,
      bigGameSamples: bigGames.length,
      bigGameMinNeeded: minSamples
    };
  }

  const bigPpm = computePpm(bigGames);
  const bigGoalsFor = mean(bigGames.map((m) => Number(m.gf)));
  const bigGoalsAgainst = mean(bigGames.map((m) => Number(m.ga)));

  const readiness = bigPpm - allPpm;  // 正 = 对强队更好,负 = 拉胯
  return {
    allPpm: round(allPpm),
    allGoalsFor: round(allGoalsFor),
    allGoalsAgainst: round(allGoalsAgainst),
    bigGameSamples: bigGames.length,
    bigGamePpm: round(bigPpm),
    bigGoalsFor: round(bigGoalsFor),
    bigGoalsAgainst: round(bigGoalsAgainst),
    readinessFactor: round(readiness),
    classification: classify(readiness, bigPpm),
    bigGameDataAvailable: true
  };
}

function computePpm(matches) {
  return mean(matches.map((m) => {
    if (Number(m.gf) > Number(m.ga)) return 3;
    if (Number(m.gf) === Number(m.ga)) return 1;
    return 0;
  }));
}

function classify(readiness, bigPpm) {
  if (readiness > 0.3) return "big-game-overperformer";    // 对强队反而更好
  if (readiness > 0.0) return "consistent";
  if (readiness > -0.5) return "big-game-slight-drop";
  if (bigPpm < 0.5) return "big-game-choker";              // 对强队完全拉胯
  return "big-game-drop";
}

/**
 * 给一场比赛,根据对手 Elo 决定用哪个 form 估计.
 */
export function chooseFormForOpponent(opponentElo, formProfile, opts = {}) {
  const threshold = opts.eloThreshold ?? DEFAULT_BIG_GAME_ELO_THRESHOLD;
  if (Number(opponentElo) >= threshold && formProfile?.bigGameDataAvailable) {
    return { ppm: formProfile.bigGamePpm, source: "big-game-form", samples: formProfile.bigGameSamples };
  }
  return { ppm: formProfile?.allPpm ?? 1.0, source: "overall-form", samples: null };
}

/**
 * 把 readinessFactor 转 LR 调整(强强对决时).
 */
export function bigGameReadinessLR(homeProfile, awayProfile) {
  if (!homeProfile?.bigGameDataAvailable || !awayProfile?.bigGameDataAvailable) return null;
  const homeFactor = Number(homeProfile.readinessFactor ?? 0);
  const awayFactor = Number(awayProfile.readinessFactor ?? 0);
  const netHomeLift = (homeFactor - awayFactor) * 0.1;  // 把 PPM 差转成 ±10%
  if (Math.abs(netHomeLift) < 0.01) return null;
  return {
    home: 1 + netHomeLift,
    draw: 1 - Math.abs(netHomeLift) * 0.2,
    away: 1 - netHomeLift
  };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
