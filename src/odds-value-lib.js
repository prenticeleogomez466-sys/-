/**
 * odds-value-lib.js —— 返还率/抽水 + de-vig 公平价 + 初→即时→终盘动向(纯函数)。
 * ──────────────────────────────────────────────────────────────────────────
 * 目的(买球者绝对有用、平台从不告诉散户、却直接决定长期盈亏的三件事):
 *   ① 返还率/抽水:每个玩法 Σ(1/赔率)=overround;返还率=1/overround,抽水=1-返还率。
 *      实测同场不同玩法抽水差一倍(亚盘~5% vs 竞彩1X2~11%)→ 同样看好,押抽水低的玩法长期更划算。
 *   ② 公平价:de-vig(shin)还原真实概率→公平赔率=1/p;竞彩开价 vs 公平价的差=被庄家"加价"多少。
 *   ③ 盘口动向:初盘→即时→终盘 热门隐含概率漂移。结合 33278 场实证(reference_data_change_5yr):
 *      被加注的热门后续 56.4% 胜 vs 退烧热门仅 45.5%(弱信号,仅作方向参考,非下注 edge)。
 *
 * 全纯函数无 IO。缺数据一律返回 null / 标缺,绝不编造(遵 feedback_no_fabrication_live_only)。
 * de-vig 复用 src/market-devig.js(shin),不重造。
 */
import { devig } from "./market-devig.js";
import { gate as clvGate } from "./clv-confidence-gate.js";

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

/**
 * 赛前 CLV 风险(市场一致性)——CLV 在赛前唯一能诚实落地的形态。
 * 真 CLV=下注价 vs 收盘价(需收盘线,系统 final 现全 null→事后才能算);赛前用"模型方向 vs 市场共识方向"
 * 作代理:与市场同向→收盘大概率不反向(低 CLV 风险);逆市→收盘常反向修正(高 CLV 风险)。
 * 实证(reference_signal_backtest:9363场同向命中54.2%/次热32.2%/逆市22.7%;真分歧场 CLV −0.796%)。
 * 复用已验证的 clv-confidence-gate.gate(纯函数·Power de-vig)。缺 pick/赔率→null。
 */
export function clvRisk(modelPickCode, modelProb, euroOdds) {
  if (modelPickCode == null || !euroOdds) return null;
  const g = clvGate({ pickCode: modelPickCode, probability: modelProb, odds: euroOdds });
  if (!g || g.aligned == null) return null;
  let level, label;
  if (g.aligned) { level = "🟢低"; label = "与市场共识同向→收盘大概率不反向(实证同向54.2%胜·CLV风险低)"; }
  else if (g.fightLevel === "次热") { level = "🟡中"; label = "押市场次热项→略降档(实证次热32.2%)"; }
  else { level = "🔴高"; label = "硬逆市(押市场最冷项)→收盘常反向修正(实证逆市仅22.7%·真分歧场CLV −0.8%)"; }
  return { level, label, aligned: g.aligned, fightLevel: g.fightLevel, divergencePp: g.divergence, marketPick: g.marketPick, modelPick: g.modelPick };
}

/** 水位→十进制赔率:亚盘 homeWater=0.88 表示净赔 0.88 → decimal 1.88;若已是 >1 的 decimal 原样返回。 */
export function waterToDecimal(w) {
  const n = num(w);
  if (n == null || n <= 0) return null;
  return n > 1 ? n : 1 + n;
}

/** 单市场返还率/抽水。oddsArr=十进制赔率(>1)数组(2 路或 3 路)。
 *  overround=Σ(1/o)(>1 含抽水);payout=返还率=1/overround;vig=抽水=1-payout。 */
export function bookMetrics(oddsArr) {
  const valid = (oddsArr || []).map(num).filter((o) => o != null && o > 1);
  if (valid.length < 2) return null;
  const overround = valid.reduce((s, o) => s + 1 / o, 0);
  if (!(overround > 0)) return null;
  const payout = 1 / overround;
  return { overround, payout, vig: 1 - payout, n: valid.length };
}

/** 竞彩开价 vs de-vig 公平价(1X2 三路)。返回逐选项 {sel,zh,offered,fair,prob,gapPct}。
 *  gapPct=(开价-公平价)/公平价:负=开价低于公平价(被抽水,常态);正=开价高于公平价(相对让利,罕见)。 */
export function fairVsOffered(odds3, method = "shin") {
  if (!odds3) return null;
  const o = { home: num(odds3.home), draw: num(odds3.draw), away: num(odds3.away) };
  if (!(o.home > 1 && o.draw > 1 && o.away > 1)) return null;
  const p = devig(o, method);
  if (!p) return null;
  return [["home", "主"], ["draw", "平"], ["away", "客"]].map(([k, zh]) => {
    const fair = 1 / p[k];
    return { sel: k, zh, offered: o[k], fair, prob: p[k], gapPct: (o[k] - fair) / fair };
  });
}

/** 三阶段 1X2 隐含概率(比例去 vig,仅用于看漂移方向,不作真概率)。 */
function impliedFrom(odds) {
  if (!odds) return null;
  const o = { home: num(odds.home), draw: num(odds.draw), away: num(odds.away) };
  if (!(o.home > 1 && o.draw > 1 && o.away > 1)) return null;
  const s = 1 / o.home + 1 / o.draw + 1 / o.away;
  return { home: 1 / o.home / s, draw: 1 / o.draw / s, away: 1 / o.away / s };
}

/** 热门方=隐含概率更高的一侧(home/away)。无即时盘则用初盘。 */
export function favSideOf(stages) {
  const ref = impliedFrom(stages?.cur) || impliedFrom(stages?.init);
  if (!ref) return null;
  return ref.home >= ref.away ? "home" : "away";
}

/** 盘口动向:1X2 三阶段 {init,cur,fin} 热门隐含概率漂移。
 *  起点=初盘(无则即时),终点=终盘(无则即时)。driftPp>0=热门被加注,<0=退烧。
 *  返回 {favKey,openPp,closePp,driftPp,dir,label,hasMove,stageNote} 或 null。 */
export function lineMovement(stages, favKey = null) {
  const fk = favKey || favSideOf(stages);
  if (!fk) return null;
  const pi = impliedFrom(stages?.init), pc = impliedFrom(stages?.cur), pf = impliedFrom(stages?.fin);
  const open = pi || pc, close = pf || pc;
  if (!open || !close) return null;
  const openPp = open[fk] * 100, closePp = close[fk] * 100;
  const driftPp = closePp - openPp;
  const stageNote = pf ? "初→终盘(终盘已封)" : pi ? "初→即时盘(未封盘)" : "仅即时盘(无初盘)";
  let dir, label;
  if (driftPp > 2) { dir = "加注"; label = `热门被加注(+${driftPp.toFixed(1)}pp)→5年实证该类热门56.4%胜(略可靠·弱信号)`; }
  else if (driftPp < -2) { dir = "退烧"; label = `热门退烧(${driftPp.toFixed(1)}pp)→5年实证仅45.5%胜(更危险·弱信号)`; }
  else { dir = "平稳"; label = `盘口平稳(${driftPp >= 0 ? "+" : ""}${driftPp.toFixed(1)}pp)·无明显资金倾向`; }
  return { favKey: fk, openPp, closePp, driftPp, dir, label, hasMove: Math.abs(driftPp) > 2, stageNote };
}

/**
 * 组装一场比赛的"返还率与盘口动向"评估。
 * vo = { euro:{init,cur,fin}, hcp:{init,cur,fin}, ah:{init,cur,fin}, totals:{init,cur,fin}, jcLine }
 *   euro/hcp 各阶段 = {home,draw,away}(十进制);ah 各阶段 = {line,homeWater,awayWater};totals = {line,over,under}。
 * 返回 { markets:[{key,zh,payout,vig,detail}], cheapest, dearest, fair, movement } —— 缺的市场不进 markets(标缺由 sheet 处理)。
 */
export function assessMatchOdds(vo) {
  if (!vo) return null;
  const markets = [];
  const d2 = (x) => { const n = num(x); return n == null ? "—" : n.toFixed(2); };
  const push = (key, zh, m, detail) => { if (m) markets.push({ key, zh, payout: m.payout, vig: m.vig, n: m.n, detail }); };

  const euroCur = vo.euro?.cur;
  push("euro", "胜平负(欧赔1X2)", euroCur ? bookMetrics([euroCur.home, euroCur.draw, euroCur.away]) : null,
    euroCur ? `主${d2(euroCur.home)}/平${d2(euroCur.draw)}/客${d2(euroCur.away)}` : null);

  const hcpCur = vo.hcp?.cur;
  push("hcp", "让球胜平负(竞彩)", hcpCur ? bookMetrics([hcpCur.home, hcpCur.draw, hcpCur.away]) : null,
    hcpCur ? `主${d2(hcpCur.home)}/平${d2(hcpCur.draw)}/客${d2(hcpCur.away)}` : null);

  const ahCur = vo.ah?.cur;
  const ahHome = waterToDecimal(ahCur?.homeWater), ahAway = waterToDecimal(ahCur?.awayWater);
  push("ah", "亚盘让球(主/客水)", (ahHome && ahAway) ? bookMetrics([ahHome, ahAway]) : null,
    (ahHome && ahAway) ? `线${ahCur.line ?? "—"}·主水${d2(ahCur.homeWater)}/客水${d2(ahCur.awayWater)}` : null);

  const totCur = vo.totals?.cur;
  push("totals", "大小球(亚式盘口)", totCur ? bookMetrics([totCur.over, totCur.under]) : null,
    totCur ? `线${totCur.line ?? "—"}·大${d2(totCur.over)}/小${d2(totCur.under)}` : null);

  // 抽水最低=最划算 / 最高=最贵(同看好下押低抽水玩法长期更划算)
  let cheapest = null, dearest = null;
  for (const m of markets) {
    if (!cheapest || m.vig < cheapest.vig) cheapest = m;
    if (!dearest || m.vig > dearest.vig) dearest = m;
  }

  const fair = fairVsOffered(euroCur, "shin");
  const movement = lineMovement(vo.euro ? { init: vo.euro.init, cur: vo.euro.cur, fin: vo.euro.fin } : null);
  const clv = clvRisk(vo.modelPickCode, vo.modelProb, euroCur);

  return { markets, cheapest, dearest, fair, movement, clv, hasData: markets.length > 0 };
}

/** 返还率档位标签(供 sheet 直观判读;基于真实赔率算出的 payout)。 */
export function payoutVerdict(payout) {
  if (payout == null) return { tag: "—", note: "缺" };
  if (payout >= 0.95) return { tag: "🟢极低抽水", note: "接近国际sharp盘水平·最划算" };
  if (payout >= 0.92) return { tag: "🟢低抽水", note: "性价比好" };
  if (payout >= 0.88) return { tag: "🟡中等抽水", note: "常见欧赔水平" };
  if (payout >= 0.80) return { tag: "🟠偏高抽水", note: "成本偏重·同看好优先换低抽水玩法" };
  return { tag: "🔴高抽水", note: "成本很重·长期不利" };
}
