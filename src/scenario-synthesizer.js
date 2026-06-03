/**
 * 情景合成层(2026-06-02)——把"分析底层逻辑"显式拆解为可读情景 + 玩法指引。
 * ════════════════════════════════════════════════════════════════════
 * 用户要求(2026-06-02 原话):"你的分析底层逻辑思维要全面拆解 —— 根据预测是否会爆冷、
 *   是否会出现大小球、是否有平局,这又要结合联赛特性、球队特点、排名和比赛的重要程度。"
 *
 * 现状:这些信号已分散在 prediction 各字段(矩阵概率/大小球扩展盘/爆冷探测/逐场原型/联赛画像),
 *   但没有一个层把它们**合成为一场的"情景研判"并据此指引该推哪些玩法**。本模块补这一层:
 *   零重算、零假编 —— 只读 prediction 已算字段(遵 feedback_no_fabrication_live_only),
 *   缺字段就跳过该维度,绝不臆造。
 *
 * 输出 prediction.scenario = {
 *   headline,            // 一句话情景(逐场不同)
 *   dims: { strength, draw, goals, upset, scoreShape, importance },  // 六维结构化研判
 *   marketGuidance,      // [{market, lean, why}] —— 据情景指引该推/该避哪些玩法
 * }
 * 注:只研判 + 指引,不改 pick/概率方向、不替用户弃赛(遵 feedback_confidence_not_autosuppress + wld 锚)。
 */
import { leagueProfile } from "./league-profile.js";

const PCT = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");
const round3 = (v) => (Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 1000) / 1000 : null);

/* ── 赛事重要程度(免费可得:赛事名 + 世界杯上下文)── */
function classifyImportance(prediction) {
  const c = String(prediction?.fixture?.competition ?? "");
  if (/友谊|热身|friendly|表演|trophy|邀请赛|warm/i.test(c))
    return { level: "低", key: "friendly", note: "练兵/态度赛:主力常轮换、强度低,赔率参考性下降" };
  if (/决赛|半决赛|淘汰赛|附加赛|生死|保级|升级|final|semi|knock|play-?off|relegation/i.test(c))
    return { level: "高", key: "knockout", note: "关键/淘汰赛:打法趋保守,低比分与平局概率上升" };
  if (prediction?.probabilityAdjustment?.worldCup) return { level: "高", key: "world-cup", note: "世界杯正赛:强度高、爆冷不罕见" };
  return { level: "常规", key: "league", note: null };
}

/* ── 平局倾向(矩阵平局概率 + 联赛历史平局率)── */
function drawDim(prediction) {
  const draw = Number(prediction?.probabilities?.draw);
  if (!Number.isFinite(draw)) return null;
  const profile = leagueProfile(prediction?.fixture?.competition);
  const histDraw = Number(profile?.drawRate);
  let band, note;
  if (draw >= 0.30) { band = "高"; note = `平局概率 ${PCT(draw)} 偏高,单押任一方风险大 → 优先双选或胆平`; }
  else if (draw >= 0.26) { band = "中"; note = `平局概率 ${PCT(draw)},均势场可兼顾平局`; }
  else { band = "低"; note = `平局概率 ${PCT(draw)} 偏低,可较放心单押方向`; }
  if (Number.isFinite(histDraw) && histDraw >= 0.30 && band !== "高")
    note += `;但本联赛历史平局率 ${PCT(histDraw)} 偏高,留意`;
  return { prob: round3(draw), band, histDrawRate: round3(histDraw), note };
}

/* ── 大小球倾向(校准/盘口 over2.5 → 经验库 → λ合计 三级回退)── */
function goalsDim(prediction) {
  const ou = prediction?.extendedMarkets?.overUnder?.["2.5"];
  const over = Number(ou?.overCalibrated ?? ou?.over);
  const eg = prediction?.dixonColes?.expectedGoals ?? prediction?.simulation?.lambdas;
  const lamSum = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away) ? Number(eg.home) + Number(eg.away) : null;
  if (Number.isFinite(over)) {
    const source = ou?.calibration?.hasMarketLine ? "盘口" : "校准模型";
    let lean, note;
    if (over >= 0.56) { lean = "大球"; note = `大于2.5球 ${PCT(over)}(${source}):比分往 2-1/2-2/3-1 偏`; }
    else if (over <= 0.44) { lean = "小球"; note = `大于2.5球 ${PCT(over)}(${source}):低比分(1-0/1-1/0-0)为主`; }
    else { lean = "均衡"; note = `大小球接近五五(over ${PCT(over)},${source}),不偏押`; }
    return { lean, prob: round3(over), source, note };
  }
  if (Number.isFinite(lamSum)) {
    let lean, note;
    if (lamSum >= 2.9) { lean = "大球"; note = `期望总进球 ${lamSum.toFixed(2)}(λ合计),偏大球`; }
    else if (lamSum <= 2.3) { lean = "小球"; note = `期望总进球 ${lamSum.toFixed(2)}(λ合计),偏小球/低比分`; }
    else { lean = "均衡"; note = `期望总进球 ${lamSum.toFixed(2)}(λ合计),中性`; }
    return { lean, prob: null, source: "λ合计", note };
  }
  return null;
}

/* ── 爆冷倾向(爆冷探测器 → 实力差回退)── */
function upsetDim(prediction) {
  const t = prediction?.handicapPick?.upsetTrap;
  if (t && (t.upsetLevel || t.upsetRisk != null)) {
    return {
      band: t.upsetLevel ?? null,
      risk: Number.isFinite(t.upsetRisk) ? round3(t.upsetRisk) : null,
      tier: t.tier ?? null,
      verdict: t.trapVerdict ?? null,
      note: t.reason ?? null,
    };
  }
  const s = prediction?.differentialAnalysis?.archetype?.strength;
  if (!s) return null;
  const band = s.key === "even" ? "高" : s.key === "slight-edge" ? "中" : "低";
  return { band, risk: null, tier: s.label, verdict: null, note: `${s.label}(无开收盘漂移,按实力差估爆冷)` };
}

/* ── 比分形态(集中/分散,来自 totalGoalsBands)── */
function scoreShapeDim(prediction) {
  const da = prediction?.scorePicks?.deepAnalysis;
  if (!da?.concentration) return null;
  const note = da.concentration === "集中"
    ? `比分相对好猜(首选 ${PCT(da.topScoreProb)}),可小注精确比分/半全场`
    : da.concentration === "分散"
      ? `比分发散(首选仅 ${PCT(da.topScoreProb)}),别单押精确比分,改玩方向/大小球`
      : `比分集中度中等(首选 ${PCT(da.topScoreProb)})`;
  return { concentration: da.concentration, topProb: round3(da.topScoreProb), bands: da.bands, note };
}

/* ── 近期状态/打法(API-Football,描述性,不改概率)── */
function teamFormDim(prediction) {
  const t = prediction?.teamTraits;
  if (!t || (!t.home && !t.away)) return null;
  const h = t.home, a = t.away;
  const parts = [];
  if (h?.form) parts.push(`主近${h.matches}场 ${h.form}`);
  if (a?.form) parts.push(`客近${a.matches}场 ${a.form}`);
  let lean = null, note = parts.join(" · ");
  if (Number.isFinite(t.formDiff)) {
    if (t.formDiff >= 0.25) { lean = "主队状态明显更好"; }
    else if (t.formDiff <= -0.25) { lean = "客队状态明显更好"; }
    else { lean = "两队近况接近"; }
    note += `;状态差 ${t.formDiff >= 0 ? "+" : ""}${t.formDiff}(${lean})`;
  }
  // 进攻/防守画像(近期场均)
  const atk = [];
  if (Number.isFinite(h?.goalsForAvg)) atk.push(`主攻 ${h.goalsForAvg}/失 ${h.goalsAgainstAvg}`);
  if (Number.isFinite(a?.goalsForAvg)) atk.push(`客攻 ${a.goalsForAvg}/失 ${a.goalsAgainstAvg}`);
  if (atk.length) note += `;近期${atk.join("、")}`;
  return { lean, formDiff: t.formDiff ?? null, home: h, away: a, note };
}

/* ── xG 画像(FBref,描述性,不改概率)── */
function xgQualityDim(prediction) {
  const fb = prediction?.fbref;
  if (!fb || (!fb.home && !fb.away)) return null;
  const h = fb.home, a = fb.away;
  const parts = [];
  if (Number.isFinite(h?.xgFor)) parts.push(`主 xG ${h.xgFor}/xGA ${h.xgAgainst ?? "—"}`);
  if (Number.isFinite(a?.xgFor)) parts.push(`客 xG ${a.xgFor}/xGA ${a.xgAgainst ?? "—"}`);
  let lean = null, note = parts.join(" · ");
  if (Number.isFinite(fb.xgEdge)) {
    if (fb.xgEdge >= 0.4) lean = "主队 xG 占优";
    else if (fb.xgEdge <= -0.4) lean = "客队 xG 占优";
    else lean = "xG 接近";
    note += `;净 xG 优势 ${fb.xgEdge >= 0 ? "+" : ""}${fb.xgEdge}(${lean})`;
  }
  // 终结效率背离(进球持续 > xG = 抓得准/或将回归)
  const fin = [];
  if (Number.isFinite(h?.finishing) && Math.abs(h.finishing) >= 0.25) fin.push(`主终结${h.finishing > 0 ? "超" : "低于"} xG ${h.finishing}`);
  if (Number.isFinite(a?.finishing) && Math.abs(a.finishing) >= 0.25) fin.push(`客终结${a.finishing > 0 ? "超" : "低于"} xG ${a.finishing}`);
  if (fin.length) note += `;${fin.join("、")}(留意回归)`;
  return { lean, xgEdge: fb.xgEdge ?? null, home: h, away: a, note };
}

/* ── 综合 → 玩法指引(据各维度给该推/该避)── */
function buildMarketGuidance(dims) {
  const g = [];
  if (dims.draw?.band === "高") g.push({ market: "胜平负/让球", lean: "兼顾平局或双选", why: `平局 ${PCT(dims.draw.prob)} 偏高` });
  if (dims.goals?.lean === "大球") g.push({ market: "大小球", lean: "偏大球", why: dims.goals.note });
  else if (dims.goals?.lean === "小球") g.push({ market: "大小球·比分", lean: "偏小球·压低比分", why: dims.goals.note });
  if (dims.upset && /高/.test(String(dims.upset.band ?? ""))) g.push({ market: "单关信心", lean: "降档·防冷门", why: dims.upset.note ?? "爆冷风险高" });
  if (dims.scoreShape?.concentration === "分散") g.push({ market: "精确比分", lean: "别单押,转方向/大小球", why: "比分发散" });
  else if (dims.scoreShape?.concentration === "集中") g.push({ market: "精确比分·半全场", lean: "可小注", why: "比分集中度高" });
  if (dims.teamForm?.lean && dims.teamForm.lean !== "两队近况接近")
    g.push({ market: "胜平负", lean: `参考近况(${dims.teamForm.lean})`, why: dims.teamForm.note });
  if (dims.xgQuality?.lean && dims.xgQuality.lean !== "xG 接近")
    g.push({ market: "胜平负·让球", lean: `xG 支持(${dims.xgQuality.lean})`, why: dims.xgQuality.note });
  if (dims.importance?.level === "低") g.push({ market: "全玩法", lean: "降参考权重", why: dims.importance.note });
  else if (dims.importance?.level === "高" && dims.importance.key !== "world-cup") g.push({ market: "大小球·比分", lean: "偏保守低球", why: dims.importance.note });
  return g;
}

/**
 * 合成本场情景研判。返回 null 当缺少最基本字段(fixture/probabilities)。
 */
export function synthesizeScenario(prediction) {
  if (!prediction?.fixture || !prediction?.probabilities) return null;
  const strengthRaw = prediction?.differentialAnalysis?.archetype?.strength;
  const dims = {
    strength: strengthRaw ? { label: strengthRaw.label, key: strengthRaw.key } : null,
    draw: drawDim(prediction),
    goals: goalsDim(prediction),
    upset: upsetDim(prediction),
    scoreShape: scoreShapeDim(prediction),
    importance: classifyImportance(prediction),
    teamForm: teamFormDim(prediction),
    xgQuality: xgQualityDim(prediction),
  };
  const bits = [];
  if (dims.strength) bits.push(dims.strength.label);
  if (dims.draw) bits.push(`平局${dims.draw.band}`);
  if (dims.goals) bits.push(dims.goals.lean);
  if (dims.upset?.band) bits.push(`爆冷${String(dims.upset.band).replace(/[⚠\s]/g, "")}`);
  if (dims.teamForm?.lean && dims.teamForm.lean !== "两队近况接近") bits.push(dims.teamForm.lean);
  if (dims.xgQuality?.lean && dims.xgQuality.lean !== "xG 接近") bits.push(dims.xgQuality.lean);
  if (dims.importance && dims.importance.level !== "常规") bits.push(`重要度${dims.importance.level}`);
  const headline = bits.filter(Boolean).join(" · ");
  return { headline, dims, marketGuidance: buildMarketGuidance(dims) };
}

/** 把情景研判拼成一段挂进 narrative 的文本(供 xlsx 选择理由列展示)。 */
export function scenarioNarrative(scenario) {
  if (!scenario) return "";
  const parts = [`【情景研判】${scenario.headline}`];
  const d = scenario.dims;
  const lines = [d.teamForm?.note, d.xgQuality?.note, d.draw?.note, d.goals?.note, d.scoreShape?.note, d.upset?.note, d.importance?.note].filter(Boolean);
  if (lines.length) parts.push(`  ${lines.join("；")}`);
  if (scenario.marketGuidance?.length)
    parts.push(`【玩法指引】${scenario.marketGuidance.map((g) => `${g.market}→${g.lean}`).join("；")}`);
  return parts.join("\n");
}
