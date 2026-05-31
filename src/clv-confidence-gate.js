/**
 * CLV + 市场背离置信门 (clv-confidence-gate)
 * ──────────────────────────────────────────────────────────────────────────
 * 实证依据(2026-05-31 signal-crossval/ou25 回测): 模型与市场分歧越大, 市场赢得越多
 * (1X2 分歧前5%: 市场62.5% vs 模型51.4%)。结论=逆市场选独门是陷阱。
 * 本模块把这条变成可执行规则:
 *   ① 背离度: 模型选项 vs 市场(去vig隐含)选项的方向一致性 + 概率差;
 *   ② 置信门: 与市场同向→保/升; 背离市场(尤其押市场最冷项)→降档/标"慎单选";
 *   ③ CLV: 下注隐含概率 vs 收盘隐含概率(收盘=有效市场金标准), 正CLV=长期赚。
 *
 * 纯函数, 无 IO。pickCode: 3=主胜, 1=平, 0=客胜(竞彩约定)。
 */

const PICK_KEY = { 3: "home", 1: "draw", 0: "away", H: "home", D: "draw", A: "away" };

export function devig(odds) {
  if (!odds) return null;
  const o = { home: Number(odds.home), draw: Number(odds.draw), away: Number(odds.away) };
  if (!(o.home > 1 && o.draw > 1 && o.away > 1)) return null;
  const ih = 1 / o.home, id = 1 / o.draw, ia = 1 / o.away, s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}

/** CLV: 下注赔率 vs 收盘赔率, 返回 +CLV(%) 与判定。 */
export function computeCLV(betOdds, closingOdds) {
  const b = Number(betOdds), c = Number(closingOdds);
  if (!(b > 1 && c > 1)) return { clv: null, verdict: "invalid" };
  const clv = (1 / c - 1 / b) / (1 / b);
  const verdict = clv > 0.03 ? "强正(长期赚)" : clv > 0 ? "正" : clv > -0.03 ? "中性" : "负(被收盘修正)";
  return { clv: Math.round(clv * 1000) / 10, verdict };
}

/**
 * 市场背离 + 置信门。
 * @param {{pickCode, probability, odds:{home,draw,away}}} row 推荐行(probability 为百分数或小数)
 * @returns {{marketProb, marketPick, modelPick, aligned, divergence, fightLevel,
 *            confidenceMultiplier, tag}}
 */
export function gate(row) {
  const market = devig(row.odds);
  const modelPick = PICK_KEY[row.pickCode] ?? null;
  if (!market || !modelPick) {
    return { marketProb: market, modelPick, aligned: null, divergence: null,
             fightLevel: "unknown", confidenceMultiplier: 1, tag: "无盘口·不调整" };
  }
  const entries = [["home", market.home], ["draw", market.draw], ["away", market.away]];
  entries.sort((a, b) => b[1] - a[1]);
  const marketPick = entries[0][0];
  const marketRankOfModel = entries.findIndex((e) => e[0] === modelPick); // 0最热,2最冷
  const pModelInMarket = market[modelPick];
  const aligned = modelPick === marketPick;

  // 模型主观概率(归一到小数)
  let pModel = Number(row.probability);
  if (pModel > 1.5) pModel /= 100;
  const divergence = Math.round((pModel - pModelInMarket) * 1000) / 10; // 模型比市场高多少(pp)

  let fightLevel, mult, tag;
  if (aligned) {
    fightLevel = "同向"; mult = 1.0; tag = "与市场同向·置信保持";
  } else if (marketRankOfModel === 1) {
    fightLevel = "次热"; mult = 0.85; tag = "押市场次热项·略降档";
  } else {
    // 押市场最冷项 = 硬逆市
    fightLevel = "逆市"; mult = market[modelPick] < 0.22 ? 0.5 : 0.65;
    tag = "押市场最冷项·硬逆市·降档·慎单选";
  }
  return {
    marketProb: { home: round(market.home), draw: round(market.draw), away: round(market.away) },
    marketPick, modelPick, aligned, divergence, marketRankOfModel,
    fightLevel, confidenceMultiplier: mult,
    gatedConfidence: row.confidence != null ? Math.round(row.confidence * mult * 100) / 100 : null,
    tag,
  };
}

function round(x) { return Math.round(x * 1000) / 10; }
