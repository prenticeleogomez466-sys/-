/**
 * 推荐输出一致性派生器
 * ──────────────────────────────────────────────────
 * 2026-05-28 用户明确要求:让球方向 / 胜负平 / 半全场 / 比分必须逻辑一致.
 *
 * **比分是锚点**,其他三项从比分推导,保证 100% 数学一致:
 *
 *   比分 X-Y → 胜负平方向 (X>Y 主胜 / X==Y 平 / X<Y 客胜)
 *   比分 X-Y → 让 -N 方向 ((X-N)>Y 主胜 / (X-N)==Y 平 / (X-N)<Y 客胜)
 *   比分 X-Y → 半全场 (上半场字符 + 全场字符,plausibility check)
 *
 * 用法:
 *   import { deriveWldFromScore, deriveHandicapFromScore, pickConsistentHalfFull } from "./consistency-derivation.js";
 *   const wld = deriveWldFromScore("1-0");                 // "主胜"
 *   const hd = deriveHandicapFromScore("1-0", -1);          // "平局"(让球后 0-0)
 *   const hf = pickConsistentHalfFull("1-0", hfOddsMap);    // 跟比分一致的最低赔率半全场
 */

const OUTCOME_LABELS = { home: "主胜", draw: "平局", away: "客胜" };
const FULL_LABEL_TO_CHAR = { 主胜: "胜", 平局: "平", 客胜: "负" };

export function parseScore(scoreStr) {
  const m = String(scoreStr || "").match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

export function deriveWldFromScore(scoreStr) {
  const s = parseScore(scoreStr);
  if (!s) return null;
  if (s.home > s.away) return "主胜";
  if (s.home < s.away) return "客胜";
  return "平局";
}

/**
 * 让 line(N 负数=主队让 N 球)后的胜平负 outcome.
 *   line = -1, score 1-0 → 让球后 0-0 → 平局
 *   line = -1, score 2-0 → 让球后 1-0 → 主胜
 *   line = -2, score 2-0 → 让球后 0-0 → 平局
 *   line = +1, score 0-1 → 让球后 1-1 → 平局
 */
export function deriveHandicapFromScore(scoreStr, line) {
  const s = parseScore(scoreStr);
  if (!s) return null;
  const adjusted = (s.home + Number(line || 0)) - s.away;
  if (adjusted > 0) return "主胜";
  if (adjusted < 0) return "客胜";
  return "平局";
}

/**
 * 给定比分锚点,从半全场赔率表里挑跟比分**全场结果一致 + plausibility 通过**的最低赔率.
 *
 * @param {string} scoreStr  比分 "X-Y"
 * @param {Object} hfOddsMap  半全场赔率字典:{ "胜胜": 2.02, "平胜": 3.90, ... }
 * @returns {{label, odds, alt?: {label, odds}}}  首选 + 备选
 */
export function pickConsistentHalfFull(scoreStr, hfOddsMap) {
  const score = parseScore(scoreStr);
  if (!score || !hfOddsMap) return { label: null, odds: null };
  const wld = deriveWldFromScore(scoreStr);
  if (!wld) return { label: null, odds: null };
  const targetChar = FULL_LABEL_TO_CHAR[wld];

  const candidates = [];
  for (const [hfLabel, odds] of Object.entries(hfOddsMap)) {
    if (!hfLabel.endsWith(targetChar)) continue;  // 全场字符必须匹配
    const firstChar = hfLabel.charAt(0);
    if (!firstHalfPlausible(firstChar, score.home, score.away)) continue;
    candidates.push({ label: hfLabel, odds: Number(odds) });
  }
  if (!candidates.length) return { label: null, odds: null };
  candidates.sort((a, b) => a.odds - b.odds);
  return {
    label: candidates[0].label,
    odds: candidates[0].odds,
    alt: candidates[1] ?? null
  };
}

/**
 * 上半场字符是否能加到全场比分:
 *   "胜" (上半主队领先) → 需要 full_home >= 1
 *   "平" (上半场平) → 永远可能(0-0 是平)
 *   "负" (上半客队领先) → 需要 full_away >= 1
 */
export function firstHalfPlausible(firstChar, fullHome, fullAway) {
  if (firstChar === "胜") return fullHome >= 1;
  if (firstChar === "平") return true;
  if (firstChar === "负") return fullAway >= 1;
  return false;
}

/**
 * 比分赔率结构 → 推荐比分(单一锚点).
 * 策略:从 allScoresOdds 里挑赔率最低 + 满足 outcome 约束的比分;
 *      备选:第二低赔率,且 wld 跟首选一致(或可指定 secondaryWld).
 *
 * @param {Object} allScoresOdds  完整比分赔率字典 { "1-0": 5.50, "2-0": 6.00, "0-0": 10, ... }
 * @param {string} [forceWld]  可选:强制只挑该 wld 的比分(如"主胜""平局""客胜")
 * @returns {{ score, odds, alt? }}
 */
export function pickConsistentScore(allScoresOdds, forceWld = null) {
  const candidates = [];
  for (const [score, odds] of Object.entries(allScoresOdds || {})) {
    const wld = deriveWldFromScore(score);
    if (!wld) continue;
    if (forceWld && wld !== forceWld) continue;
    candidates.push({ score, odds: Number(odds), wld });
  }
  if (!candidates.length) return { score: null, odds: null };
  candidates.sort((a, b) => a.odds - b.odds);
  return {
    score: candidates[0].score,
    odds: candidates[0].odds,
    wld: candidates[0].wld,
    alt: candidates[1] ?? null
  };
}

/**
 * 一致性自检:给定 4 个推荐字段,验证 wld 一致 + score 跟 wld 一致 + halfFull 跟 score 一致.
 * 返回 errors 数组(空 = 通过).
 */
export function verifyRecommendationConsistency({ score, wld, handicapDirection, handicapLine, halfFull }) {
  const errors = [];
  const s = parseScore(score);
  if (s) {
    const wldFromScore = deriveWldFromScore(score);
    if (wld && wldFromScore !== wld) {
      errors.push(`wld ${wld} 跟比分 ${score} 推出 ${wldFromScore} 矛盾`);
    }
    if (handicapDirection != null && handicapLine != null) {
      const hd = deriveHandicapFromScore(score, handicapLine);
      if (hd !== handicapDirection) {
        errors.push(`让球方向 ${handicapDirection}(让 ${handicapLine}) 跟比分 ${score} 推出 ${hd} 矛盾`);
      }
    }
    if (halfFull) {
      const firstChar = halfFull.charAt(0);
      const lastChar = halfFull.charAt(halfFull.length - 1);
      const fullChar = FULL_LABEL_TO_CHAR[wld ?? deriveWldFromScore(score)];
      if (lastChar !== fullChar) {
        errors.push(`半全场 ${halfFull} 的全场字符 ${lastChar} 跟比分 ${score} 全场字符 ${fullChar} 矛盾`);
      }
      if (!firstHalfPlausible(firstChar, s.home, s.away)) {
        errors.push(`半全场 ${halfFull} 上半字符 ${firstChar} 跟比分 ${score} 不兼容(${firstChar} 需要对应一方先进球)`);
      }
    }
  }
  return errors;
}
