/**
 * 历史比赛数据 · 独立小模型层(2026-05-31)
 * ────────────────────────────────────────────────────────────
 * 用户要求:"从独立小模型的各个结构建立做全面补充添加,还有最重要的历史比赛数据。"
 *
 * 现状痛点:历史比赛数据库有 3 万+ 带赛果场次,h2h/近期/类比信号本已在 signal-fusion 算,
 *   但"有市场先验→整层关融合"使它们对竞彩永远休眠(fired=[]),历史数据在最终输出里**完全没露出**。
 * 本模块把历史比赛数据直接建成**独立小模型**(读 3 万场真实赛果),供多模态层并排展示与裁决:
 *   ① H2H 交锋史(h2hLens):同两队历史交手 → 当前主队视角 胜平负 + 常见比分 + 场均进球 + 模式;
 *   ② 近期战绩(recentFormLens):双方各自最近 N 场 W/D/L → 状态分(PPG)与强弱倾向。
 *
 * 严守硬规则:
 *   - 数据稀疏(国际赛/小球队常 h2h=0)即 available:false,**绝不编造**历史(遵 [[feedback-no-fabrication-live-only]]);
 *   - 以胜负平为锚:历史只作独立证据并排展示,不反推、不覆盖最终 wld([[feedback_wld_anchor_inference]]);
 *   - 复用既有 analyzeH2H(先把历史记录队名归一成中文再传,绕开其跨语言 === 定向 bug)+ recentMatchesFor,不重造。
 */
import { canonicalTeamName } from "./team-aliases.js";
import { h2hMatchesFor, recentMatchesFor } from "./fusion-context-builder.js";
import { analyzeH2H } from "./head-to-head-history.js";

const H2H_MIN = 3;          // 交锋史样本下限(与 analyzeH2H 一致)
const FORM_MIN = 3;         // 单队近期样本下限
const FORM_WINDOW = 10;     // 近期取最近 10 场
const round = (v) => Math.round((Number(v) + Number.EPSILON) * 1000) / 1000;

// 把历史记录的队名统一归一到中文 canonical(历史库存英文,fixture 用中文)。
function canonMatch(m) {
  return { ...m, homeTeam: canonicalTeamName(m.homeTeam), awayTeam: canonicalTeamName(m.awayTeam) };
}

/**
 * H2H 交锋史小模型:当前主队视角的 胜平负 + 常见比分 + 场均进球。
 * @returns {{available, n, wld?, avgGoals?, topScores?, pattern?, note}}
 */
export function h2hLens(fixture, history) {
  const homeC = canonicalTeamName(fixture?.homeTeam);
  const awayC = canonicalTeamName(fixture?.awayTeam);
  const raw = h2hMatchesFor(history ?? [], fixture?.homeTeam, fixture?.awayTeam) ?? [];
  if (raw.length < H2H_MIN) {
    return { available: false, n: raw.length, note: `交锋史不足(${raw.length}<${H2H_MIN}场)→ 不编造` };
  }
  const matches = raw.map(canonMatch);
  // 复用 analyzeH2H(队名已归一,team1=当前主队)→ 加权 wld + 模式 + 场均进球。
  const a = analyzeH2H(matches, homeC, awayC);
  if (!a?.ok) return { available: false, n: raw.length, note: a?.reason ?? "h2h-unusable" };
  // 当前主队视角常见比分(自算,analyzeH2H 不产比分)。
  const scoreCount = {};
  for (const m of matches) {
    const curHome = m.homeTeam === homeC; // 当前主队是否为该场主场
    const cg = curHome ? m.homeGoals : m.awayGoals;
    const og = curHome ? m.awayGoals : m.homeGoals;
    if (!Number.isFinite(cg) || !Number.isFinite(og)) continue;
    const k = `${cg}-${og}`;
    scoreCount[k] = (scoreCount[k] ?? 0) + 1;
  }
  const topScores = Object.entries(scoreCount).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([score, c]) => ({ score, count: c }));
  return {
    available: true,
    n: a.sampleSize,
    wld: { home: round(a.team1WinRate), draw: round(a.drawRate), away: round(a.team2WinRate) },
    avgGoals: a.avgGoalsPerMatch,
    topScores,
    pattern: a.pattern,
    note: `交锋 ${a.sampleSize} 场(主视角胜${Math.round(a.team1WinRate * 100)}/平${Math.round(a.drawRate * 100)}/客${Math.round(a.team2WinRate * 100)}%)`,
  };
}

// 一支球队近期 W/D/L → 状态分。won 字段已是该队视角(fusion-context-builder 装配)。
function formOf(matches) {
  const list = (matches ?? []).filter((m) => ["W", "D", "L"].includes(m?.won)).slice(0, FORM_WINDOW);
  if (list.length < FORM_MIN) return null;
  const w = list.filter((m) => m.won === "W").length;
  const d = list.filter((m) => m.won === "D").length;
  const l = list.filter((m) => m.won === "L").length;
  const gf = list.reduce((s, m) => s + (Number(m.goalsFor) || 0), 0);
  const ga = list.reduce((s, m) => s + (Number(m.goalsAgainst) || 0), 0);
  return {
    n: list.length, w, d, l,
    ppg: round((w * 3 + d) / list.length),     // 场均积分(状态强度)
    gfpg: round(gf / list.length), gapg: round(ga / list.length),
    string: list.map((m) => m.won).join(""),    // 形如 "WWDLW"(近在前)
  };
}

/**
 * 近期战绩小模型:双方各自最近 N 场状态 → PPG 净差倾向(独立于赔率/DC 的实证状态)。
 * @returns {{available, home?, away?, lean?, ppgDiff?, note}}
 */
export function recentFormLens(fixture, history) {
  const home = formOf(recentMatchesFor(history ?? [], fixture?.homeTeam, FORM_WINDOW));
  const away = formOf(recentMatchesFor(history ?? [], fixture?.awayTeam, FORM_WINDOW));
  if (!home && !away) return { available: false, note: "双方近期赛果均不足 → 不编造" };
  if (!home || !away) {
    return { available: false, home, away, note: `仅一方有近期数据(主${home?.n ?? 0}/客${away?.n ?? 0})→ 不足以比对` };
  }
  const ppgDiff = round(home.ppg - away.ppg);
  // 净差仅作状态倾向提示(不转概率、不改锚);阈值参考让球净差经验。
  const lean = ppgDiff > 0.5 ? "home" : ppgDiff < -0.5 ? "away" : "even";
  return {
    available: true, home, away, ppgDiff, lean,
    note: `近期状态 主 ${home.string}(${home.ppg}分/场) vs 客 ${away.string}(${away.ppg}分/场),净差 ${ppgDiff > 0 ? "+" : ""}${ppgDiff}`,
  };
}

/**
 * 汇总历史比赛数据小模型(供多模态层并排)。history 缺失时整体 available:false,绝不编造。
 * @returns {{available, h2h, recentForm}}
 */
export function buildHistoricalLenses(fixture, history) {
  if (!fixture || !Array.isArray(history) || history.length === 0) {
    return { available: false, h2h: { available: false, n: 0, note: "无历史库" }, recentForm: { available: false, note: "无历史库" } };
  }
  const h2h = h2hLens(fixture, history);
  const recentForm = recentFormLens(fixture, history);
  return { available: h2h.available || recentForm.available, h2h, recentForm };
}
