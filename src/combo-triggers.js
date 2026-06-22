/**
 * combo-triggers.js —— 交叉组合触发器引擎(2026-06-22 用户令:把所有验证过的交叉规律合成一个,
 *   任何一场喂进去→告诉你触发了哪几条、各预测什么、历史命中多少、信心几档)。
 *
 * 规律三来源(全部已在 12458场五大联赛全7赛季 回测,关键条已在353张真竞彩截图交叉确认):
 *   ① 实测高命中组合(scan-hitrate-combos·TRAIN/TEST双稳):大小球/主胜为主,让球过盘无高命中点。
 *   ② 庄家意图(bookmaker-intent·21405场+截图双证):初→终 退烧热门=危险 / 加注热门=偏可靠。
 *   ③ 用户让球分线手感(test-user-rules):方向对但多数不显著→标为"倾向/弱",不冒充高把握。
 *
 * 诚实铁律(reference_signal_backtest_findings):高命中≠盈利(收盘已定价);本引擎价值=选择性出手把命中率
 *   从基线拉到65-78%,以及标出"危险盘"避坑。不保证赚钱,不打败收盘线。
 *
 * 纯函数无IO。输入用收盘欧赔+收盘亚盘线即可;有竞彩/亚盘1X2则额外触发用户规则。
 */

// 让球线解析:单值(-0.75)或分盘字符串("-0.5/1"→0.75, "0/0.5"→0.25),返回带符号的均值
export function parseLine(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const neg = s.startsWith("-");
  const parts = s.replace(/^-/, "").split("/").map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  if (!parts.length) return null;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return neg ? -avg : avg;
}

const devig3 = (o) => {
  if (!o || !(o.home > 1 && o.draw > 1 && o.away > 1)) return null;
  const inv = [1 / o.home, 1 / o.draw, 1 / o.away], s = inv[0] + inv[1] + inv[2];
  return { home: inv[0] / s, draw: inv[1] / s, away: inv[2] / s };
};

/**
 * 归一化特征。
 * @param {{euClose,euOpen,ahLineClose,ahLineOpen}} m
 *   euClose/euOpen = {home,draw,away} 小数欧赔(终/初);ahLineClose/Open = 让球线(数字或"-0.5/1"字符串,主队视角负=主让)
 */
export function comboFeatures(m) {
  if (!m || !m.euClose) return null;
  const euC = m.euClose, euO = m.euOpen || null;
  if (!(euC.home > 1 && euC.draw > 1 && euC.away > 1)) return null;
  const favHome = euC.home <= euC.away, favSide = favHome ? "home" : "away";
  const favOdds = euC[favSide], dogOdds = favHome ? euC.away : euC.home, drawOdds = euC.draw;
  const dC = devig3(euC), dO = devig3(euO);
  const favDrift = dC && dO ? dC[favSide] - dO[favSide] : null; // >0 加注 <0 退烧
  const lineC = parseLine(m.ahLineClose), lineO = parseLine(m.ahLineOpen);
  const ahAbs = lineC === null ? null : Math.abs(lineC);
  const lineMove = lineC !== null && lineO !== null ? Math.abs(lineC) - Math.abs(lineO) : null;
  return { favHome, favSide, favOdds, dogOdds, drawOdds, favDrift, ahAbs, lineC, lineMove,
    drift: favDrift === null ? null : favDrift > 0.02 ? "加注" : favDrift < -0.02 ? "退烧" : "平稳" };
}

// 规则库:每条带回测命中率(train/test/N)+信心档+来源。fire(f)=触发条件(f=comboFeatures结果)
// tier: 高(实测OOS稳≥62%) / 中(方向稳·中命中) / 提醒(避坑) / 倾向(用户规则方向对但不显著) / 弱(几乎无效·仅记录)
export const RULES = [
  // ===== ① 实测高命中组合 =====
  { id: "超大热门→主胜", market: "胜平负", predict: "主胜", tier: "高", hit: { tr: 0.663, te: 0.700, n: 940 }, base: 0.43, src: "实测组合",
    fire: (f) => f.favHome && f.favOdds < 1.3, why: "主队收盘欧赔<1.3(超大热门)" },
  { id: "超大热门(客)→客胜", market: "胜平负", predict: "客胜", tier: "高", hit: { tr: 0.663, te: 0.700, n: 940 }, base: 0.43, src: "实测组合",
    fire: (f) => !f.favHome && f.favOdds < 1.3, why: "客队收盘欧赔<1.3(超大热门)" },
  { id: "实力悬殊让2+→主胜", market: "胜平负", predict: "主胜", tier: "高", hit: { tr: 0.646, te: 0.705, n: 887 }, base: 0.43, src: "实测组合",
    fire: (f) => f.ahAbs >= 1.625 && f.favHome, why: "亚盘让2球+且主队是热门" },
  { id: "实力悬殊让2+→大球", market: "大小球", predict: "大球", tier: "高", hit: { tr: 0.697, te: 0.697, n: 887 }, base: 0.53, src: "实测组合",
    fire: (f) => f.ahAbs >= 1.625, why: "亚盘让2球+(实力悬殊,强队压着打)" },
  { id: "超大热门→大球", market: "大小球", predict: "大球", tier: "高", hit: { tr: 0.679, te: 0.678, n: 940 }, base: 0.53, src: "实测组合",
    fire: (f) => f.favOdds < 1.3, why: "热门欧赔<1.3(一边倒易进球)" },
  { id: "让0.25+高平赔→大球", market: "大小球", predict: "大球", tier: "高", hit: { tr: 0.703, te: 0.712, n: 211 }, base: 0.53, src: "实测组合",
    fire: (f) => f.ahAbs !== null && f.ahAbs >= 0.125 && f.ahAbs < 0.375 && f.drawOdds >= 3.7 && f.drawOdds < 4.0, why: "让0.25球且平赔3.7-4.0(对攻盘)" },
  { id: "中热+高平赔→大球", market: "大小球", predict: "大球", tier: "高", hit: { tr: 0.700, te: 0.700, n: 221 }, base: 0.53, src: "实测组合",
    fire: (f) => f.favOdds >= 2.1 && f.favOdds < 2.5 && f.drawOdds >= 3.7 && f.drawOdds < 4.0, why: "热门2.1-2.5且平赔3.7-4.0(双方对攻)" },
  { id: "胶着低平赔+平稳→小球", market: "大小球", predict: "小球", tier: "中", hit: { tr: 0.628, te: 0.612, n: 988 }, base: 0.47, src: "实测组合",
    fire: (f) => f.drawOdds < 3.2 && f.drift === "平稳", why: "平赔<3.2(胶着低分盘)且盘口平稳" },
  { id: "胶着低平赔+退烧→小球", market: "大小球", predict: "小球", tier: "中", hit: { tr: 0.621, te: 0.610, n: 368 }, base: 0.47, src: "实测组合",
    fire: (f) => f.drawOdds < 3.2 && f.drift === "退烧", why: "平赔<3.2(胶着)且热门退烧" },
  { id: "让0.25+低平赔+平稳→小球", market: "大小球", predict: "小球", tier: "中", hit: { tr: 0.646, te: 0.639, n: 555 }, base: 0.47, src: "实测组合",
    fire: (f) => f.ahAbs !== null && f.ahAbs >= 0.125 && f.ahAbs < 0.375 && f.drawOdds < 3.2 && f.drift === "平稳", why: "让0.25+平赔<3.2+平稳(闷平/小胜)" },
  { id: "让1.25小热+平稳→主胜", market: "胜平负", predict: "主胜", tier: "中", hit: { tr: 0.627, te: 0.689, n: 315 }, base: 0.43, src: "实测组合",
    fire: (f) => f.ahAbs !== null && f.ahAbs >= 1.125 && f.ahAbs < 1.375 && f.favHome && f.favOdds >= 1.3 && f.favOdds < 1.45 && f.drift === "平稳", why: "让1.25主热(1.3-1.45)且平稳" },

  // ===== ② 庄家意图(避坑/可靠度) =====
  { id: "退烧热门→危险避坑", market: "风险", predict: "该热门命中骤降·别当胆/防爆", tier: "提醒", hit: { tr: 0.455, te: 0.455, n: 3080 }, base: 0.543, src: "庄家意图",
    fire: (f) => f.drift === "退烧", why: "热门从初盘到收盘被看淡(资金撤离),5年实证此类热门仅45.5%胜、竞彩截图更低28.8%" },
  { id: "加注热门→偏可靠", market: "可靠度", predict: "该热门偏可靠(可作胆)", tier: "中", hit: { tr: 0.564, te: 0.564, n: 3530 }, base: 0.543, src: "庄家意图",
    fire: (f) => f.drift === "加注", why: "热门从初盘到收盘被继续加注(资金涌入),5年实证此类56.4%胜" },

  // ===== ③ 用户让球分线手感(回测后诚实定档) =====
  { id: "让1+平高+负高→倾向平", market: "胜平负", predict: "平局倾向", tier: "倾向", hit: { tr: 0.27, te: 0.27, n: 170 }, base: 0.252, src: "用户规则",
    fire: (f) => f.ahAbs !== null && f.ahAbs >= 0.875 && f.ahAbs < 1.125 && f.drawOdds >= 4.0 && f.dogOdds >= 6.5, why: "让1球+平赔>4+负赔>6.5(用户:重热门盘平局轻微被低估·方差大仅倾向)" },
  { id: "让0.25中庸盘→倾向平", market: "胜平负", predict: "平局倾向", tier: "倾向", hit: { tr: 0.293, te: 0.293, n: 532 }, base: 0.252, src: "用户规则",
    fire: (f) => f.ahAbs !== null && f.ahAbs >= 0.125 && f.ahAbs < 0.375 && f.favOdds >= 2.1 && f.favOdds <= 2.45 && f.drawOdds >= 3.05 && f.drawOdds <= 3.75 && f.dogOdds >= 3.0 && f.dogOdds <= 3.25, why: "让0.25+三门赔率中庸(用户:易平·实测平29%略高基线)" },
];

/**
 * 主入口:给一场比赛,返回所有触发的规律(按信心档+命中率排序)。
 * @returns {{features, triggers:Array}|null}
 */
export function comboTriggers(m) {
  const f = comboFeatures(m);
  if (!f) return null;
  const order = { 高: 0, 中: 1, 提醒: 2, 倾向: 3, 弱: 4 };
  const triggers = RULES.filter((r) => { try { return r.fire(f); } catch { return false; } })
    .map((r) => ({ id: r.id, market: r.market, predict: r.predict, tier: r.tier, src: r.src,
      hitRate: r.hit, lift: ((r.hit.tr + r.hit.te) / 2 - r.base), why: r.why }))
    .sort((a, b) => (order[a.tier] - order[b.tier]) || (b.hitRate.te - a.hitRate.te));
  return { features: f, triggers };
}
