/**
 * 扩展投注玩法输出层
 * ──────────────────────────────────────────────────
 * 在 Dixon-Coles 比分矩阵基础上,衍生出所有竞彩支持的玩法:
 *
 *   1. 大小球(总进球过 X.5):0.5 / 1.5 / 2.5 / 3.5 / 4.5
 *   2. 单双总进球
 *   3. 上半场胜负平(假设上半场 λ ≈ 0.46 × 全场)
 *   4. 让球胜负平(主队让 -1 / -2,客队让 +1)
 *   5. 双胜彩(主胜或平 / 平或客胜 / 主胜或客胜)
 *   6. 同一比分组(0-0/1-1/2-2 等;1-0/2-0/3-0 等)
 *   7. 价值标记(EV>X% 高亮)
 *
 * 输入:DC matrix (二维数组 P[h][a])
 * 输出:所有玩法的概率字典
 */

const HALF_RATIO = 0.46;  // 上半场进球率占比(经验值)

export function buildExtendedMarkets(matrix, options = {}) {
  if (!matrix || !matrix.length) return null;
  const maxGoals = matrix.length - 1;

  return {
    overUnder: buildOverUnderMarkets(matrix),
    totalGoalsOddEven: buildOddEven(matrix),
    firstHalf: buildFirstHalfMarkets(matrix, options.halfRatio ?? HALF_RATIO),
    asianHandicap: buildAsianHandicaps(matrix),
    doubleChance: buildDoubleChance(matrix),
    scoreGroup: buildScoreGroups(matrix),
    totalGoalsExact: buildTotalGoalsExact(matrix)
  };
}

// ───── 大小球(over X.5)─────
function buildOverUnderMarkets(matrix) {
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  const out = {};
  for (const line of lines) {
    let over = 0, under = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h].length; a++) {
        if (h + a > line) over += matrix[h][a];
        else under += matrix[h][a];
      }
    }
    out[`${line}`] = { over: round(over), under: round(under) };
  }
  return out;
}

// ───── 单双总进球 ─────
function buildOddEven(matrix) {
  let odd = 0, even = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      if ((h + a) % 2 === 0) even += matrix[h][a];
      else odd += matrix[h][a];
    }
  }
  return { odd: round(odd), even: round(even) };
}

// ───── 上半场胜负平 ─────
// 假设上半场 λ ≈ halfRatio × 全场,且上下半场独立。
function buildFirstHalfMarkets(matrix, halfRatio = HALF_RATIO) {
  // 边缘化拿全场 λ_h, λ_a(其实是 lambda*mu 但是简化)
  // 再用 Poisson 算上半场分布
  const lambdaH = expectedFromMatrix(matrix, "home") * halfRatio;
  const lambdaA = expectedFromMatrix(matrix, "away") * halfRatio;
  const distH = poissonDist(lambdaH, 5);
  const distA = poissonDist(lambdaA, 5);
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const p = distH[h] * distA[a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  // 上下半场进球比对
  const halfOver05 = 1 - (distH[0] * distA[0]);
  const halfOver15 = 1 - sum2d(distH, distA, (h, a) => h + a < 2);
  return {
    home: round(home), draw: round(draw), away: round(away),
    over05: round(halfOver05),
    over15: round(halfOver15),
    expectedHomeGoals: round(lambdaH),
    expectedAwayGoals: round(lambdaA)
  };
}

function sum2d(distH, distA, predicate) {
  let s = 0;
  for (let h = 0; h < distH.length; h++)
    for (let a = 0; a < distA.length; a++)
      if (predicate(h, a)) s += distH[h] * distA[a];
  return s;
}

// ───── 让球胜负平 ─────
// 让 -N(主队让 N 球):主胜需要赢超 N 球;让球平=赢 N 球;让球负=赢不到 N 球或输
// 让 +N(客队让 N 球):用对称逻辑
function buildAsianHandicaps(matrix) {
  const lines = [-2, -1, 1];
  const out = {};
  for (const line of lines) {
    let home = 0, draw = 0, away = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h].length; a++) {
        const adjustedDiff = (h + line) - a;  // 让 -N 时主队得分 - N
        if (adjustedDiff > 0) home += matrix[h][a];
        else if (adjustedDiff === 0) draw += matrix[h][a];
        else away += matrix[h][a];
      }
    }
    out[`${line}`] = { home: round(home), draw: round(draw), away: round(away) };
  }
  return out;
}

// ───── 双胜彩(任意 2 个 outcome 合并)─────
function buildDoubleChance(matrix) {
  let h = 0, d = 0, a = 0;
  for (let hh = 0; hh < matrix.length; hh++) {
    for (let aa = 0; aa < matrix[hh].length; aa++) {
      if (hh > aa) h += matrix[hh][aa];
      else if (hh === aa) d += matrix[hh][aa];
      else a += matrix[hh][aa];
    }
  }
  return {
    homeOrDraw: round(h + d),
    drawOrAway: round(d + a),
    homeOrAway: round(h + a)
  };
}

// ───── 比分分组 ─────
function buildScoreGroups(matrix) {
  let drawScores = 0, narrowHome = 0, wideHome = 0, narrowAway = 0, wideAway = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      const diff = h - a;
      if (diff === 0) drawScores += p;
      else if (diff === 1) narrowHome += p;
      else if (diff >= 2) wideHome += p;
      else if (diff === -1) narrowAway += p;
      else wideAway += p;
    }
  }
  return {
    draw: round(drawScores),
    homeBy1: round(narrowHome),
    homeBy2Plus: round(wideHome),
    awayBy1: round(narrowAway),
    awayBy2Plus: round(wideAway)
  };
}

// ───── 总进球数精确分布 ─────
function buildTotalGoalsExact(matrix) {
  const out = {};
  for (let n = 0; n <= 7; n++) {
    let p = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h].length; a++) {
        if (h + a === n) p += matrix[h][a];
      }
    }
    out[`${n}`] = round(p);
  }
  // 7+ 是剩余
  let sevenPlus = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      if (h + a >= 7) sevenPlus += matrix[h][a];
    }
  }
  out["7+"] = round(sevenPlus);
  return out;
}

// ───── 工具 ─────
function expectedFromMatrix(matrix, side) {
  let sum = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      sum += matrix[h][a] * (side === "home" ? h : a);
    }
  }
  return sum;
}

function poissonDist(lambda, maxGoals) {
  if (!Number.isFinite(lambda) || lambda <= 0) {
    const out = new Array(maxGoals + 1).fill(0);
    out[0] = 1;
    return out;
  }
  const out = [];
  let sum = 0;
  for (let k = 0; k <= maxGoals; k++) {
    const p = Math.exp(k * Math.log(lambda) - lambda - logFact(k));
    out.push(p);
    sum += p;
  }
  return out.map(p => p / sum);
}

function logFact(n) {
  let v = 0;
  for (let i = 2; i <= n; i++) v += Math.log(i);
  return v;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}

// ───── 把 EV 标签算到每条玩法上 ─────
/**
 * 输入:扩展玩法概率字典 + 市场赔率(同结构);输出:每条玩法的 EV 标签
 * @param {Object} markets buildExtendedMarkets 返回的对象
 * @param {Object} odds 同结构,赔率值替代概率;不存在的字段忽略
 * @returns {Object} 每条玩法的 { probability, odds, ev, verdict }
 */
// 递归遍历嵌套结构(支持 2-3 层),给每个叶子概率配对应赔率算 EV
export function annotateMarketsWithEV(markets, odds) {
  if (!markets || !odds) return null;
  function walk(probObj, oddsObj) {
    if (probObj == null || oddsObj == null) return null;
    if (typeof probObj === "number") {
      const odd = Number(oddsObj);
      if (!Number.isFinite(odd) || odd <= 1) return null;
      const ev = probObj * odd - 1;
      return { probability: probObj, odds: odd, ev: round(ev), verdict: evVerdict(ev) };
    }
    if (typeof probObj !== "object") return null;
    const out = {};
    for (const k of Object.keys(probObj)) {
      const sub = walk(probObj[k], oddsObj[k]);
      if (sub != null) out[k] = sub;
    }
    return Object.keys(out).length ? out : null;
  }
  const result = {};
  for (const key of Object.keys(markets)) {
    if (odds[key] == null) continue;
    const sub = walk(markets[key], odds[key]);
    if (sub != null) result[key] = sub;
  }
  return result;
}

function evVerdict(ev) {
  if (ev > 0.15) return "strong-value";
  if (ev > 0.05) return "value";
  if (ev > -0.05) return "fair";
  return "negative-ev";
}
