/**
 * Lineup 信号增益回测(2026-05-31)—— 诚实验证"首发布阵姿态"信号到底有没有正增益。
 * ────────────────────────────────────────────────────────────
 * 数据:ESPN 历史首发阵型 + 真实赛果(backfill-espn-formations.mjs 回填)。
 * 用**生产信号同一段** lineupPostureLR(单一真相源),不另写一版逻辑。
 *
 * 三问:
 *   ① 方向验证:双摆防的真实平局率是否 > 全局平局率?双压上是否 < 全局?(Wilson 95% CI 是否排除全局)
 *   ② 概率增益:对每场用全局经验 3 路 base rate 作 baseline prior,套信号 LR 后,
 *      LogLoss / Brier 在**信号 fire 的子集**上是否改善?(全局 base rate 是常数 MLE baseline,
 *      对信号是**保守**对照——能赢它才算真增益。)
 *   ③ 样本量:fire 子集够不够大到结论可信。
 *
 * 遵 feedback-hitrate-closed-loop(改完回测验证)+ no-fabrication(只报真实数字、负结果照报)。
 */
import { lineupPostureLR } from "./lineup-source.js";

const OUTCOMES = ["home", "draw", "away"];
const MAX_TOTAL_SHIFT = 0.12;   // 与 signal-fusion-layer DEFAULT_MAX_TOTAL_SHIFT 一致

function round(v, p = 4) { const m = 10 ** p; return Math.round(v * m) / m; }

/** Wilson 95% 置信区间(二项比例)。 */
export function wilsonInterval(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: round(Math.max(0, center - half)), hi: round(Math.min(1, center + half)) };
}

/** 套 LR 到 prior(归一积),再对每个 outcome 位移按 ±MAX_TOTAL_SHIFT 封顶(与融合层一致)。 */
export function applyLR(prior, lr) {
  const raw = {};
  let sum = 0;
  for (const o of OUTCOMES) { raw[o] = Math.max(1e-9, prior[o] * (lr?.[o] ?? 1)); sum += raw[o]; }
  const norm = {};
  for (const o of OUTCOMES) norm[o] = raw[o] / sum;
  // 位移封顶
  const capped = {};
  for (const o of OUTCOMES) {
    const d = norm[o] - prior[o];
    capped[o] = prior[o] + Math.min(MAX_TOTAL_SHIFT, Math.max(-MAX_TOTAL_SHIFT, d));
  }
  let s2 = 0; for (const o of OUTCOMES) s2 += Math.max(0, capped[o]);
  const out = {}; for (const o of OUTCOMES) out[o] = Math.max(0, capped[o]) / (s2 || 1);
  return out;
}

function logLoss(prob, actual) { return -Math.log(Math.max(1e-12, prob[actual])); }
function brier(prob, actual) {
  let s = 0;
  for (const o of OUTCOMES) { const y = o === actual ? 1 : 0; s += (prob[o] - y) ** 2; }
  return s;
}

/**
 * @param {Array<{homeFormation,awayFormation,result:"home"|"draw"|"away"}>} records
 * @returns 完整诊断报告
 */
export function analyzeLineupSignal(records) {
  const valid = (records ?? []).filter((r) => r && r.homeFormation && r.awayFormation && OUTCOMES.includes(r.result));
  const n = valid.length;
  if (!n) return { ok: false, reason: "无有效样本" };

  // 全局经验 3 路 base rate(也是 baseline prior)
  const cnt = { home: 0, draw: 0, away: 0 };
  for (const r of valid) cnt[r.result] += 1;
  const base = { home: cnt.home / n, draw: cnt.draw / n, away: cnt.away / n };

  // 分桶 + 概率打分
  const buckets = { "both-defensive": [], "both-attacking": [], neutral: [] };
  let llBase = 0, llSig = 0, brBase = 0, brSig = 0;          // 全样本
  let llBaseFired = 0, llSigFired = 0, brBaseFired = 0, brSigFired = 0, firedN = 0;
  for (const r of valid) {
    const posture = lineupPostureLR(r.homeFormation, r.awayFormation);
    const kind = posture?.kind ?? "neutral";
    buckets[kind].push(r);
    const sigProb = posture ? applyLR(base, posture.lr) : base;
    llBase += logLoss(base, r.result); llSig += logLoss(sigProb, r.result);
    brBase += brier(base, r.result); brSig += brier(sigProb, r.result);
    if (posture) {
      firedN += 1;
      llBaseFired += logLoss(base, r.result); llSigFired += logLoss(sigProb, r.result);
      brBaseFired += brier(base, r.result); brSigFired += brier(sigProb, r.result);
    }
  }

  const drawRateOf = (rows) => {
    const k = rows.filter((r) => r.result === "draw").length;
    return { n: rows.length, draws: k, drawRate: rows.length ? round(k / rows.length) : null, ci: wilsonInterval(k, rows.length) };
  };
  const def = drawRateOf(buckets["both-defensive"]);
  const atk = drawRateOf(buckets["both-attacking"]);

  // 方向验证:双摆防平局率 CI 是否整体高于全局(lo > base.draw);双压上是否整体低于全局(hi < base.draw)
  const defConfirmed = def.n > 0 && def.ci.lo > base.draw;
  const atkConfirmed = atk.n > 0 && atk.ci.hi < base.draw;

  const firedImproves = firedN > 0 && (llSigFired / firedN) < (llBaseFired / firedN);

  return {
    ok: true,
    sampleSize: n,
    globalRates: { home: round(base.home), draw: round(base.draw), away: round(base.away) },
    direction: {
      bothDefensive: { ...def, vsGlobalDraw: round(def.n ? def.drawRate - base.draw : 0), confirmed: defConfirmed },
      bothAttacking: { ...atk, vsGlobalDraw: round(atk.n ? atk.drawRate - base.draw : 0), confirmed: atkConfirmed },
      neutralN: buckets.neutral.length
    },
    probabilisticGain: {
      firedN,
      firedRate: round(firedN / n),
      logLoss: { baseline: round(llBaseFired / Math.max(1, firedN)), signal: round(llSigFired / Math.max(1, firedN)), delta: round((llSigFired - llBaseFired) / Math.max(1, firedN)) },
      brier: { baseline: round(brBaseFired / Math.max(1, firedN)), signal: round(brSigFired / Math.max(1, firedN)), delta: round((brSigFired - brBaseFired) / Math.max(1, firedN)) },
      allSampleLogLoss: { baseline: round(llBase / n), signal: round(llSig / n) },
      firedImproves
    },
    verdict: buildVerdict(defConfirmed, atkConfirmed, firedImproves, firedN, def, atk)
  };
}

function buildVerdict(defConfirmed, atkConfirmed, firedImproves, firedN, def, atk) {
  if (firedN < 50) return `样本不足(fire ${firedN} 场 <50),结论不可信,建议扩大回填窗口再判。`;
  const dirHits = [defConfirmed ? "双摆防平局↑成立" : null, atkConfirmed ? "双压上平局↓成立" : null].filter(Boolean);
  if (firedImproves && dirHits.length) {
    return `✅ 正增益:${dirHits.join("、")};fire 子集 LogLoss 改善。信号可保留为生产激活。`;
  }
  if (firedImproves) {
    return `🟡 弱正:LogLoss 改善但方向 CI 未显著排除全局(摆防 ${def.drawRate}/压上 ${atk.drawRate} vs 全局),边际小,保留但低权。`;
  }
  return `❌ 无增益:fire 子集 LogLoss 未改善(摆防平局率 ${def.drawRate}、压上 ${atk.drawRate})。按"变好才留"应下调权重或休眠该信号。`;
}
