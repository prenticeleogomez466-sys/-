/**
 * 大融合 · 每场深度分析(2026-05-31 通宵进化起点)
 * ────────────────────────────────────────────────────────────
 * 把模型的多路信号融成一段"内行口吻"的深度分析,对齐用户思路(多因素结合):
 *   ① 联赛历史特点(场均进球/平局率/主场优势——日职小球多平、德甲大球、英超主场弱);
 *   ② 球队强度(DC attack/defense,赛果回填后真实);
 *   ③ 市场选择分层(市场隐含热门概率定档 + 回测命中率);
 *   ④ 让球胜平负盘口方向 + 让球线;
 *   ⑤ 历史同情境(平局率/大小球/盘口漂移);
 *   ⑥ 风险/爆冷 + 复盘教训(硬币局慎单选)。
 * 纯综合解释,不改 wld 锚、不替用户弃赛。诚实标注缺失因子。
 */
import { leagueProfile, canonicalLeague } from "./league-profile.js";
import { attributeRecap } from "./recap-attribution.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const pct = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : "—");

// 复盘反馈联动(2026-05-31):读真实结算账本的逐联赛命中记录,接回每场分析。
let _leagueRecord;
function leagueRecord() {
  if (_leagueRecord !== undefined) return _leagueRecord;
  try {
    const p = join(getExportDir(), "recommendation-ledger.json");
    if (!existsSync(p)) { _leagueRecord = {}; return _leagueRecord; }
    const L = JSON.parse(readFileSync(p, "utf8"));
    _leagueRecord = attributeRecap(Array.isArray(L) ? L : L.rows)?.byLeague ?? {};
  } catch { _leagueRecord = {}; }
  return _leagueRecord;
}
// 模糊匹配 fixture.competition ↔ 账本联赛名(日职↔日本职业联赛、瑞超↔瑞典超级联赛)。
function recordFor(competition) {
  const canon = canonicalLeague(competition);
  if (!canon) return null;
  for (const [k, v] of Object.entries(leagueRecord())) {
    if (canonicalLeague(k) === canon) return { league: k, ...v };
  }
  return null;
}

/**
 * @param {object} prediction recommendFixtures 的单条预测
 * @returns {{headline:string, factors:string[], verdict:string, text:string}}
 */
export function deepFusionAnalysis(prediction) {
  if (!prediction?.fixture) return null;
  const fx = prediction.fixture;
  const comp = fx.competition ?? "";
  const lp = leagueProfile(comp);
  const probs = prediction.probabilities ?? {};
  const tier = prediction.selectionTier;
  const factors = [];

  // ① 联赛特点
  if (lp.matched) {
    const goalsTag = lp.avgGoals >= 2.9 ? "偏大球" : lp.avgGoals <= 2.5 ? "偏小球" : "中性进球";
    const drawTag = lp.drawRate >= 0.29 ? "平局率偏高" : lp.drawRate <= 0.23 ? "平局率偏低" : "平局率中性";
    const homeTag = lp.homeAdvantage >= 1.30 ? "主场优势强" : lp.homeAdvantage <= 1.18 ? "主场优势弱" : "主场中性";
    factors.push(`📊 联赛(${comp}):场均${lp.avgGoals}球(${goalsTag})、平局率${pct(lp.drawRate)}(${drawTag})、${homeTag}(主客进球比${lp.homeAdvantage})`);
  } else {
    factors.push(`📊 联赛(${comp}):无足量历史画像(国家队/友谊赛等),进球与主客特征不确定,谨慎`);
  }

  // ② 球队强度
  const ts = prediction.dixonColes?.teamStrength;
  if (ts?.home && ts?.away) {
    factors.push(`⚔️ 球队强度(DC):主 攻${ts.home.attack}/防${ts.home.defense} vs 客 攻${ts.away.attack}/防${ts.away.defense}`);
  } else {
    factors.push(`⚔️ 球队强度:该队不在训练集(冷启动),胜负平主要由市场赔率定价`);
  }

  // ③ 市场选择分层
  if (tier) {
    factors.push(`🎯 选择分层:${tier.label}(市场隐含热门${pct(tier.marketFavProb)}·回测档内命中~${pct(tier.backtestHit)})${tier.bankerEligible ? "·够格胆码" : "·不宜单选搏胆"}`);
  }

  // ④ 让球胜平负(点名到队,方向直白:买哪支队/走盘)
  const lq = prediction.jingcaiLetqiu;
  if (lq?.pick) {
    const ln = Number(lq.line);
    const lineLabel = ln > 0 ? `主队受让+${ln}` : ln < 0 ? `主队让${ln}` : "平手盘";
    // 让球后方向 → 点名:主胜=主队(让/受让后)赢盘,客胜=客队赢盘,平局=走盘
    const dirTeam = lq.pick.code === "3" ? `买 ${fx.homeTeam}(${ln < 0 ? "让" + ln + "过盘" : "受让+" + ln})`
      : lq.pick.code === "0" ? `买 ${fx.awayTeam}(${ln < 0 ? "受让+" + (-ln) : "让" + (-ln)})`
      : "走盘(让球后打平)";
    factors.push(`🀄 让球胜平负[${lineLabel}]:方向 → ${dirTeam} ${pct(lq.pick.probability)}${lq.sfcSold ? "" : "(本场胜平负未开售,只让球盘可投)"}`);
  }

  // ④b 大小球(总进球2.5):联赛历史大球率(回测证明联赛维度 Brier 优于全局:0.2494→0.2472)为主信号,
  //    模型比分矩阵 P(over) 作交叉验证。直接吃联赛进球特性(德甲大球61%/意甲小球45%)。
  const lpOver = lp.matched ? lp.overRate : null;
  const modelOver = prediction.extendedMarkets?.overUnder?.["2.5"]?.over;
  const ouSignal = lpOver != null ? lpOver : modelOver;
  if (ouSignal != null) {
    // 融合权重经回测优化(run:31343场):模型0.3/联赛0.7 Brier 0.2463 最优(联赛率主导,大小球本是联赛驱动)。
    const blend = (lpOver != null && Number.isFinite(modelOver)) ? 0.7 * lpOver + 0.3 * modelOver : ouSignal;
    const ouPick = blend >= 0.55 ? "大球(>2.5)" : blend <= 0.45 ? "小球(<2.5)" : "接近2.5·中性";
    const basis = lpOver != null
      ? `联赛历史大球率 ${pct(lpOver)}${Number.isFinite(modelOver) ? `·模型矩阵 ${pct(modelOver)}` : ""}(联赛维度已回测加分)`
      : `${comp}无联赛大球画像,用模型矩阵 ${pct(modelOver)}`;
    factors.push(`⚽ 大小球[2.5]:${ouPick} — ${basis}`);
    prediction._ouFusion = { line: 2.5, leagueOverRate: lpOver, modelOver: modelOver ?? null, blendOver: Math.round(blend * 1000) / 1000, pick: ouPick };
  }

  // ④c 盘口异动/赔率变化(2026-05-31,回测验证强信号:热门被推命中56% vs 被甩45.9%,差10pp):
  //    推荐方向开盘→当前的隐含概率变化——线路收窄=锐钱在推(信号增强)、走高=被甩(警惕)。
  const eo = prediction.marketSnapshot?.europeanOdds;
  if (eo?.initial && eo?.current) {
    const dv = (o) => { const r = { h: 1 / o.home, d: 1 / o.draw, a: 1 / o.away }; const s = r.h + r.d + r.a; return { home: r.h / s, draw: r.d / s, away: r.a / s }; };
    const pOpen = dv(eo.initial), pCur = dv(eo.current);
    const key = prediction.pick?.code === "3" ? "home" : prediction.pick?.code === "0" ? "away" : "draw";
    if (Number.isFinite(pOpen[key]) && Number.isFinite(pCur[key])) {
      const move = pCur[key] - pOpen[key];
      if (move >= 0.02) factors.push(`💹 盘口异动:推荐方向被锐钱推、线路收窄(${pct(pOpen[key])}→${pct(pCur[key])})→ 信号增强(回测此类命中56%)`);
      else if (move <= -0.02) factors.push(`💹 盘口异动:推荐方向被甩、线路走高(${pct(pOpen[key])}→${pct(pCur[key])})→ ⚠️警惕(回测此类命中仅46%)`);
    }
  }

  // ⑤ 历史同情境
  const ec = prediction.experienceContext;
  if (ec?.drawAlert) factors.push(`📈 ${ec.drawAlert}`);
  else if (ec?.historicalDrawRate != null) factors.push(`📈 历史同情境平局率 ${pct(ec.historicalDrawRate)}(${ec.n ?? "?"}场)`);

  // ⑤b 复盘反馈联动:本联赛真实结算命中记录(赛果反馈→分析闭环)
  const rec = recordFor(comp);
  if (rec && rec.n >= 3) {
    const hr = rec.hit / rec.n;
    if (hr <= 0.34) factors.push(`🔁 复盘反馈:本联赛(${rec.league})近期实测命中 ${rec.hit}/${rec.n} 偏弱 → 该联赛模型暂不靠谱,谨慎、优先覆盖`);
    else if (hr >= 0.66) factors.push(`🔁 复盘反馈:本联赛近期实测命中 ${rec.hit}/${rec.n} 良好,可信度较高`);
    else factors.push(`🔁 复盘反馈:本联赛近期实测命中 ${rec.hit}/${rec.n}`);
  }

  // ⑥ 风险 + 复盘教训
  const conf = Number(prediction.confidence);
  const ranked = [probs.home, probs.draw, probs.away].map(Number).sort((a, b) => b - a);
  const gap = (ranked[0] ?? 0) - (ranked[1] ?? 0);
  let riskNote;
  if (gap < 0.12 || conf < 40) riskNote = `⚠️ 硬币局(信心${prediction.confidence}·概率差${pct(gap)}):复盘教训——这类场方向高方差、勿单选搏胆,覆盖或放弃`;
  else if (prediction.risk === "高") riskNote = `⚠️ 高风险:${prediction.upset ?? "弱势方有戏"},兼顾爆冷`;
  else riskNote = `✅ 信号尚清晰(信心${prediction.confidence}·概率差${pct(gap)})`;
  factors.push(riskNote);

  const pickLabel = prediction.pick?.label ?? "";
  const headline = `${fx.homeTeam} vs ${fx.awayTeam} — 主推 ${pickLabel}(主${pct(probs.home)}/平${pct(probs.draw)}/客${pct(probs.away)})`;
  // 跨玩法选择(2026-05-31):本场最值得玩法 —— 市场高把握→让球胜平负;联赛大小球信号明确→大小球;
  //   都无优势→建议跳过。把"选择"从单一胜平负扩到全玩法,只推有验证优势的玩法。
  const ouf = prediction._ouFusion;
  const ouStrong = ouf && Number.isFinite(ouf.blendOver) && (ouf.blendOver >= 0.58 || ouf.blendOver <= 0.42);
  let bestPlay;
  if (tier?.bankerEligible && gap >= 0.2) bestPlay = `🎲 本场首选玩法:让球胜平负/胜平负 ${pickLabel}(市场高把握档)`;
  else if (ouStrong) bestPlay = `🎲 本场首选玩法:大小球 ${ouf.pick}(联赛信号明确;胜平负无优势,别在胜平负上搏)`;
  else if (tier && tier.marketFavProb >= 0.55) bestPlay = `🎲 本场首选玩法:胜平负覆盖(${pickLabel}+平),不宜单选`;
  else bestPlay = `🎲 本场首选玩法:无明显优势玩法,建议跳过或仅小注覆盖`;
  factors.push(bestPlay);

  // 融合裁决:综合分层 + 风险给一句可执行结论
  let verdict;
  if (tier?.bankerEligible && (gap >= 0.2)) verdict = `裁决:🟢 高把握,可作胆/单选(${tier.label})`;
  else if (tier && tier.marketFavProb >= 0.55) verdict = `裁决:🟡 中等,建议覆盖(主+平 或 双选)而非单选`;
  else verdict = `裁决:⚪ 低把握硬币局,任选9/14场里优先覆盖或不纳入胆码`;

  return { headline, factors, verdict, text: `${headline}\n${factors.map((f) => "  " + f).join("\n")}\n  ${verdict}` };
}
