/**
 * 软赛事(友谊/国家队/国际赛)平局重校准 —— 2026-05-31
 * ────────────────────────────────────────────────────────────
 * 根因(代码级实证):
 *   1. 生产 wld 概率经 calibration-trainer 的 isotonic 校准,而该校准用**五大联赛俱乐部**
 *      数据训练,把 65%+ 强热门统一映射到训练顶桶命中率 ≈0.807,残差机械二分给平/负 → 平局被钉 ~13%。
 *   2. competition-type 的平局加成(友谊 1.25 / 国家队友谊 1.30 / 国际赛 1.15)只在 signal-fusion
 *      层,而"有市场 prior 时整层关融合"(prediction-engine gateFusionOff)使它对竞彩永不触发。
 *   3. adjustLambdaByCompetition(友谊 λ 强度衰减)在全项目从未被调用。
 *   ⇒ 国际赛/友谊赛真实平局率 28-30%(模型自己的历史同情境样本数百场为证),却输出平局 13%、近乎全推主胜。
 *
 * 本模块只对**软赛事**(competition 命中 SOFT_RE:国际/友谊/国家/Nations 等)做平局重校准,
 * **完全不碰俱乐部联赛路径**(五大联赛/瑞超/日职/芬超…)—— 即回测验证过、市场已校准好的路径零改动,
 * 回测当回归护栏(软赛事不在 football-data 回测集内,改动不影响回测数字 = 不破坏既有结论)。
 *
 * 平局目标 = 两路数据源加权:
 *   ① competition-type drawProbBoost 调整后的平局(赛事性质先验);
 *   ② historical-analog 历史同情境平局率(模型自身经验库,按样本量加权,更实证)。
 * 把模型平局**有界地**(±MAX_DRAW_SHIFT,沿用融合层 ±12% 哲学)朝目标移动,
 * home/away 等比缩放保持相对强弱 —— 仍以 wld 为锚,只改 wld 本身这个锚,不反推。
 */
import { competitionProfile, adjustProbabilitiesByCompetition } from "./competition-type-model.js";

// 软赛事识别:国际/友谊/国家队/Nations 等。**刻意不匹配**任何俱乐部联赛名
//（英超/西甲/意甲/德甲/法甲/瑞超/日职/芬超/挪超…）→ 保证俱乐部=回测路径零改动。
const SOFT_RE = /(友谊|热身|国际|国家队|国家|Nations|International|Intercontinental|洲际|Friendly|World Cup|世预|世界杯)/i;

const MIN_HIST_N = 80;          // 历史同情境样本下限,低于此不采信其平局率
const HIST_FULL_N = 300;        // 历史样本达此量给满权
const MAX_DRAW_SHIFT = 0.15;    // 单次平局位移封顶(2026-06-01 12%→15%:均势场平局没提足,放宽)
const BLEND_ALPHA = 0.68;       // 朝目标移动的比例(2026-06-01 0.6→0.68:平局卡在 24%,更靠目标)
const MIN_APPLY = 0.005;        // 位移过小不动,避免无意义抖动

function round(v) {
  return Math.round((Number(v) + Number.EPSILON) * 10000) / 10000;
}

export function isSoftCompetition(competition) {
  return SOFT_RE.test(String(competition ?? ""));
}

/**
 * 软赛事 λ 强度缩放(给比分/半全场矩阵):友谊/国际赛进球偏低。
 * 取 competition intensityMultiplier 的**半强度**(避免与市场赔率已隐含的信息重复打折)。
 * 非软赛事恒返回 1(不改俱乐部路径)。
 */
export function softCompetitionLambdaScale(competition) {
  if (!isSoftCompetition(competition)) return 1;
  const p = competitionProfile(competition);
  const mult = Number(p?.intensityMultiplier);
  if (!Number.isFinite(mult) || mult <= 0) return 1;
  return 1 + (Math.min(mult, 1) - 1) * 0.5;
}

/**
 * 软赛事平局重校准。非软赛事直接原样返回 applied:false。
 * @returns {{applied:boolean, probabilities:{home,draw,away}, detail?:object}}
 */
export function recalibrateSoftCompetition(probabilities, competition, experienceBaseline) {
  if (!probabilities || !isSoftCompetition(competition)) return { applied: false, probabilities };
  const d0 = Number(probabilities.draw);
  const h0 = Number(probabilities.home);
  const a0 = Number(probabilities.away);
  if (![d0, h0, a0].every(Number.isFinite)) return { applied: false, probabilities };

  // 数据源①:赛事性质先验(competition draw boost 后的平局)
  const compDraw = adjustProbabilitiesByCompetition(probabilities, competition)?.adjusted?.draw;
  // 数据源②:历史同情境平局率(样本量加权)
  const histN = Number(experienceBaseline?.n) || 0;
  const histDraw = (histN >= MIN_HIST_N && Number.isFinite(experienceBaseline?.drawRate))
    ? Number(experienceBaseline.drawRate) : null;

  // 均势依赖的平局目标(2026-06-01):真实规律——主客越接近平局率越高(均势≈30%、悬殊≈16%)。
  //   **仅在均势场(强弱差小)作为提升目标加入**,且只增不减(不拉低悬殊场平局,法国vs海地仍≈16%)。
  const edge = Math.abs(h0 - a0);
  const balancedDraw = Math.max(0.16, Math.min(0.30, 0.30 - edge * 0.32));

  const targets = [];
  if (Number.isFinite(compDraw)) targets.push({ v: compDraw, w: 1 });
  if (histDraw != null) targets.push({ v: histDraw, w: Math.min(histN / HIST_FULL_N, 1) * 1.5 });
  // 只在均势(edge<0.20)且能提升平局(balancedDraw>当前)时加入,避免压低悬殊场平局。
  if (edge < 0.20 && balancedDraw > d0) targets.push({ v: balancedDraw, w: 1.2 });
  if (!targets.length) return { applied: false, probabilities };

  const tw = targets.reduce((s, t) => s + t.w, 0);
  const targetDraw = targets.reduce((s, t) => s + t.v * t.w, 0) / tw;

  // 有界朝目标移动
  let d1 = d0 + (targetDraw - d0) * BLEND_ALPHA;
  d1 = Math.max(d0 - MAX_DRAW_SHIFT, Math.min(d0 + MAX_DRAW_SHIFT, d1));
  d1 = Math.max(0.02, Math.min(0.6, d1));
  if (Math.abs(d1 - d0) < MIN_APPLY) return { applied: false, probabilities };

  // home/away 等比缩放保持相对强弱
  const restOld = 1 - d0;
  const restNew = 1 - d1;
  const scale = restOld > 1e-9 ? restNew / restOld : 0;
  let out = { home: h0 * scale, draw: d1, away: a0 * scale };
  const sum = out.home + out.draw + out.away;
  out = { home: round(out.home / sum), draw: round(out.draw / sum), away: round(out.away / sum) };

  return {
    applied: true,
    probabilities: out,
    detail: {
      from: round(d0),
      to: out.draw,
      compDraw: Number.isFinite(compDraw) ? round(compDraw) : null,
      histDraw: histDraw != null ? round(histDraw) : null,
      histN,
      note: `软赛事(${competition})平局重校准 ${(d0 * 100).toFixed(0)}%→${(out.draw * 100).toFixed(0)}%`
        + (histDraw != null ? `(历史同情境 ${(histDraw * 100).toFixed(0)}%/${histN}场)` : "(赛事性质先验)"),
    },
  };
}
