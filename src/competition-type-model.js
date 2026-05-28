/**
 * Competition Type Model
 * ──────────────────────────────────────────────────
 * 不同赛事性质影响球队战力发挥:
 *   - 联赛: 标准基准
 *   - 杯赛(主场): 高强度,主队投入更多 → 主胜略加
 *   - 杯赛(中立): 高强度,中性
 *   - 杯赛(两回合): 第一回合保守,第二回合需要追分 → 角色调整
 *   - 欧冠: 顶级强队全力,中下游队保积分
 *   - 友谊赛: 轮换为主,战意低,结果随机性高
 *   - 国际赛(国家队): 跟俱乐部完全不同生态
 */

const COMPETITION_PROFILES = {
  "联赛": {
    intensityMultiplier: 1.00,
    homeBoost: 1.00,
    drawProbBoost: 1.00,
    upsetProbBoost: 1.00,
    randomnessFactor: 1.00
  },
  "league": {
    intensityMultiplier: 1.00,
    homeBoost: 1.00,
    drawProbBoost: 1.00,
    upsetProbBoost: 1.00,
    randomnessFactor: 1.00
  },
  "杯赛-单场淘汰": {
    intensityMultiplier: 1.15,
    homeBoost: 1.05,
    drawProbBoost: 1.10,  // 加时常出现
    upsetProbBoost: 1.20,
    randomnessFactor: 1.30
  },
  "杯赛-两回合-首回合": {
    intensityMultiplier: 0.92,
    homeBoost: 1.05,
    drawProbBoost: 1.20,  // 首回合常稳一手
    upsetProbBoost: 0.95,
    randomnessFactor: 0.90
  },
  "杯赛-两回合-次回合": {
    intensityMultiplier: 1.12,
    homeBoost: 1.10,  // 在主场决出胜负
    drawProbBoost: 0.85,  // 必须分出
    upsetProbBoost: 1.10,
    randomnessFactor: 1.10
  },
  "欧冠": {
    intensityMultiplier: 1.10,
    homeBoost: 1.08,
    drawProbBoost: 0.95,
    upsetProbBoost: 1.05,
    randomnessFactor: 1.05
  },
  "欧联": {
    intensityMultiplier: 1.05,
    homeBoost: 1.05,
    drawProbBoost: 0.98,
    upsetProbBoost: 1.10,
    randomnessFactor: 1.10
  },
  "友谊赛": {
    intensityMultiplier: 0.65,
    homeBoost: 1.02,
    drawProbBoost: 1.25,  // 大概率轮换+平淡
    upsetProbBoost: 1.50,
    randomnessFactor: 1.80
  },
  "国家队-世预赛": {
    intensityMultiplier: 1.20,
    homeBoost: 1.18,  // 主场对国家队尤其重要
    drawProbBoost: 0.92,
    upsetProbBoost: 1.10,
    randomnessFactor: 1.05
  },
  "国家队-友谊赛": {
    intensityMultiplier: 0.55,
    homeBoost: 1.03,
    drawProbBoost: 1.30,
    upsetProbBoost: 1.60,
    randomnessFactor: 2.00
  }
};

export function competitionProfile(competition) {
  if (!competition) return COMPETITION_PROFILES["联赛"];
  const direct = COMPETITION_PROFILES[competition];
  if (direct) return direct;
  // 模糊匹配
  if (/(欧冠|Champions)/i.test(competition)) return COMPETITION_PROFILES["欧冠"];
  if (/(欧联|Europa)/i.test(competition)) return COMPETITION_PROFILES["欧联"];
  if (/(国家|World Cup|世预)/i.test(competition)) return COMPETITION_PROFILES["国家队-世预赛"];
  if (/友谊|Friendly/i.test(competition)) return COMPETITION_PROFILES["友谊赛"];
  if (/杯|Cup/i.test(competition)) return COMPETITION_PROFILES["杯赛-单场淘汰"];
  return COMPETITION_PROFILES["联赛"];
}

/**
 * 给基础概率,按 competition profile 调整.
 */
export function adjustProbabilitiesByCompetition(probabilities, competition) {
  if (!probabilities) return null;
  const profile = competitionProfile(competition);
  const drawShift = profile.drawProbBoost - 1;
  const homeBoostShift = profile.homeBoost - 1;
  const upsetShift = profile.upsetProbBoost - 1;

  // 提升平局率减弱主胜+客胜
  const adjusted = {
    home: probabilities.home * (1 + homeBoostShift),
    draw: probabilities.draw * (1 + drawShift),
    away: probabilities.away
  };
  // upset boost:把"弱方"的胜率推高
  if (probabilities.home > probabilities.away) {
    adjusted.away *= 1 + upsetShift * 0.3;
  } else if (probabilities.away > probabilities.home) {
    adjusted.home *= 1 + upsetShift * 0.3;
  }

  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    profile,
    adjusted: {
      home: round(adjusted.home / sum),
      draw: round(adjusted.draw / sum),
      away: round(adjusted.away / sum)
    }
  };
}

/**
 * Lambda(进球期望)按性质调整.
 */
export function adjustLambdaByCompetition(lambda, competition) {
  const profile = competitionProfile(competition);
  return round(lambda * profile.intensityMultiplier);
}

/**
 * 杯赛 / 友谊赛 等是否"低质样本",影响 prediction confidence.
 */
export function isLowQualitySample(competition) {
  const profile = competitionProfile(competition);
  return profile.randomnessFactor > 1.3 || profile.intensityMultiplier < 0.7;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
