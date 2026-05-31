/**
 * 多模态协作 · 分流 + 对比分析层(2026-05-31)
 * ────────────────────────────────────────────────────────────
 * 用户诉求:"把面临不同联赛、不同情况、不同数据赔率,进行不同的处理方式,进行对比分析。"
 *
 * 本模块**不重算、不造假**——prediction 对象在 prediction-engine 里已经为每场算好了
 * 各路"处理模态"的真实中间结果:市场赔率隐含概率、DC 纯泊松、信号融合、历史经验基线、
 * 让球盘口覆盖、最终采纳概率。本层只做三件事:
 *   ① 分流(classifyRegime):按 联赛模态 × 数据模态 × 赔率模态 给每场打"处理画像";
 *   ② 对比(extractLenses + compareLenses):把各路处理对同一场的胜平负判断并排摆出,
 *      算一致性 / 分歧 / 离散度;
 *   ③ 裁决(dispatchVerdict):说明在该模态下模型该信任哪路处理、为什么(纯解释)。
 *
 * 严守既有硬规则:
 *   - 以胜负平为锚([[feedback_wld_anchor_inference]]):对比只读各路 argmax,锚仍是 prediction.pick,本层不改方向。
 *   - 不替用户弃赛([[feedback-confidence-not-autosuppress]]):分歧只下调信心提示、给覆盖/双选建议,绝不抑制玩法。
 *   - 实时跑通不造假([[feedback-no-fabrication-live-only]]):缺数据的处理路标 available:false,绝不编造。
 */
import { canonicalLeague, leagueProfile } from "./league-profile.js";
import { isSoftCompetition } from "./competition-soft-recalibration.js";

const TOP5 = new Set(["英超", "西甲", "德甲", "意甲", "法甲"]);
// football-data 扩展集 + /new/ 覆盖的欧洲次级联赛(有开/收盘赔率,历史类比可用)。
const SECOND_EURO = new Set([
  "英冠", "荷甲", "葡超", "土超", "比甲", "苏超", "希超",
  "西乙", "德乙", "意乙", "法乙", "英甲", "英乙",
  "挪超", "瑞超", "丹超", "芬超", "奥地利", "瑞士", "俄超",
]);
const EAST_ASIA = new Set(["日职", "韩K", "中超"]);
const OTHER_REGIONAL = new Set(["澳超", "美职", "巴甲", "沙特联", "阿甲", "墨超"]);
const CUP_RE = /(欧冠|欧联|欧协联|杯|盃|Cup|Champions\s*League|Europa|Conference)/i;

const CODE = { home: ["3", "主胜"], draw: ["1", "平局"], away: ["0", "客胜"] };
const KEYS = ["home", "draw", "away"];

function argmax(probs) {
  if (!probs) return null;
  let best = null;
  for (const k of KEYS) {
    const v = Number(probs[k]);
    if (!Number.isFinite(v)) continue;
    if (!best || v > best.prob) best = { key: k, code: CODE[k][0], label: CODE[k][1], prob: v };
  }
  return best;
}

const pct = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : "—");

/**
 * 分流:给一场比赛打"处理画像"——联赛模态 × 数据模态 × 赔率模态。
 * @returns {{leagueMode, leagueModeLabel, league, dataMode:string[], oddsMode, oddsModeLabel, favProb, label}}
 */
export function classifyRegime(prediction) {
  const fx = prediction?.fixture ?? {};
  const comp = fx.competition ?? "";
  const canon = canonicalLeague(comp);

  // —— 联赛模态(先判软赛事,再判杯赛,最后俱乐部联赛分层)——
  let leagueMode, leagueModeLabel;
  if (isSoftCompetition(comp)) {
    leagueMode = "soft-international";
    leagueModeLabel = "软赛事(国际/友谊/国家队)";
  } else if (CUP_RE.test(comp)) {
    leagueMode = "cup";
    leagueModeLabel = "杯赛/欧战";
  } else if (TOP5.has(canon)) {
    leagueMode = "club-top5";
    leagueModeLabel = "五大联赛(俱乐部)";
  } else if (SECOND_EURO.has(canon)) {
    leagueMode = "club-2nd-euro";
    leagueModeLabel = "欧洲次级联赛";
  } else if (EAST_ASIA.has(canon)) {
    leagueMode = "east-asia";
    leagueModeLabel = "东亚联赛(高平局/弱主场)";
  } else if (OTHER_REGIONAL.has(canon)) {
    leagueMode = "regional";
    leagueModeLabel = "其他地区联赛";
  } else {
    leagueMode = "other";
    leagueModeLabel = "其他/未归类";
  }

  // —— 数据模态(看本场真实带了哪些处理路的输入)——
  const dataMode = [];
  const hasMarket = Boolean(prediction?.marketImpliedProbabilities);
  const hasDc = Boolean(prediction?.dixonColes?.independentProbs);
  const teamStrength = prediction?.dixonColes?.teamStrength;
  // DC 球队强度是否真有差异(全中性=空转,见 project_football_soft_draw_recal 生产空转 bug)。
  const dcNonNeutral = Boolean(teamStrength && (
    Math.abs(Number(teamStrength.homeAttack ?? 1) - 1) > 0.02 ||
    Math.abs(Number(teamStrength.awayAttack ?? 1) - 1) > 0.02
  ));
  const hasExperience = Boolean(prediction?.experienceContext?.wld);
  const hasHandicap = Boolean(prediction?.handicapPick?.handicapWld);
  const hasAsianWater = Boolean(prediction?.asianWaterAnalysis);
  const hasOu = Number.isFinite(Number(prediction?.experienceContext?.overUnder)) ||
    Boolean(prediction?._ouFusion);
  // 历史类比信号是否真 fire(在融合层 fired 清单里)。
  const fired = prediction?.probabilityAdjustment?.fusion?.fired ?? [];
  const hasAnalog = Array.isArray(fired) && fired.some((f) => /analog/i.test(f?.name ?? ""));

  if (hasMarket) dataMode.push("market-odds");
  if (hasDc) dataMode.push(dcNonNeutral ? "dixon-coles" : "dixon-coles-neutral");
  if (hasExperience) dataMode.push("experience");
  if (hasAnalog) dataMode.push("analog");
  if (hasHandicap) dataMode.push("handicap");
  if (hasAsianWater) dataMode.push("asian-water");
  if (hasOu) dataMode.push("over-under");
  if (!hasMarket && !dcNonNeutral) dataMode.push("cold-start");

  // —— 赔率模态(市场隐含热门强度 + 漂移)——
  const favProb = Number(
    prediction?.selectionTier?.marketFavProb ??
      argmax(prediction?.marketImpliedProbabilities ?? prediction?.probabilities)?.prob ??
      NaN
  );
  let oddsMode, oddsModeLabel;
  if (!Number.isFinite(favProb)) {
    oddsMode = "no-odds";
    oddsModeLabel = "无赔率(冷启动)";
  } else if (favProb >= 0.65) {
    oddsMode = "strong-fav";
    oddsModeLabel = "强热门(≥65%)";
  } else if (favProb >= 0.55) {
    oddsMode = "lean-fav";
    oddsModeLabel = "中等倾向(55-65%)";
  } else {
    oddsMode = "coin-flip";
    oddsModeLabel = "均势/硬币局(<55%)";
  }
  const drift = prediction?.experienceContext?.drift;
  const driftSignificant = Boolean(drift && drift.driftBand && /大|强|sharp|steam/i.test(String(drift.driftBand)));

  return {
    leagueMode, leagueModeLabel,
    league: canon,
    dataMode,
    oddsMode, oddsModeLabel,
    favProb: Number.isFinite(favProb) ? favProb : null,
    driftSignificant,
    label: `${leagueModeLabel} · ${oddsModeLabel} · 数据[${dataMode.join("/")}]`,
  };
}

/**
 * 抽取各路"处理模态"对本场胜平负的判断(全部读已算好的真实中间量)。
 * @returns {Array<{key,label,kind,probs,pick,available,note}>}
 */
export function extractLenses(prediction) {
  const pa = prediction?.probabilityAdjustment ?? {};
  const lenses = [];

  const push = (key, label, probs, note, kind = "wld") => {
    const available = Boolean(probs) && KEYS.some((k) => Number.isFinite(Number(probs?.[k])));
    lenses.push({
      key, label, kind,
      probs: available ? { home: Number(probs.home), draw: Number(probs.draw), away: Number(probs.away) } : null,
      pick: available ? argmax(probs) : null,
      available,
      note: note ?? null,
    });
  };

  push("market", "市场赔率(去vig)", prediction?.marketImpliedProbabilities,
    prediction?.marketImpliedProbabilities ? "含全部公开信息(伤停/阵容/盘口),回测命中上限~54%" : "本场未抓到赔率");
  push("dixon-coles", "DC 纯泊松模型", prediction?.dixonColes?.independentProbs,
    prediction?.dixonColes?.source ?? "球队 attack/defense 强度");
  const fusionGated = pa.fusionGatedOff;
  push("fusion", "信号融合层", pa.fusion?.probabilities,
    fusionGated ? "有市场先验→默认关闭(融合对市场路径净负,见 backtest:odds)" : `fire ${pa.fusion?.fired?.length ?? 0} 信号`);
  push("experience", "历史经验基线", prediction?.experienceContext?.wld,
    prediction?.experienceContext?.source ?? "同联赛同情境历史频率");
  push("final", "最终采纳(锚)", prediction?.probabilities,
    `provenance: ${prediction?.provenance ?? "—"}`);

  // 让球盘口是独立玩法(深盘场常只开此盘),单列、不进胜平负一致性投票。
  const hw = prediction?.handicapPick?.handicapWld;
  if (hw?.probabilities) {
    const p = hw.probabilities;
    lenses.push({
      key: "handicap", label: "让球盘口覆盖", kind: "handicap",
      probs: { home: Number(p.home), draw: Number(p.draw), away: Number(p.away) },
      pick: argmax(p),
      available: true,
      note: `让球线 ${hw.line ?? prediction?.handicapPick?.line ?? "—"}·${hw.source ?? "DC-τ覆盖"}`,
    });
  }
  return lenses;
}

/**
 * 对比各路独立处理对胜平负的判断,算一致性 / 分歧 / 离散度。
 * 独立投票路 = market / dixon-coles / experience(+ fusion 仅在未被市场关闭时)。
 * "final" 是综合结论(锚),展示但不计入投票避免重复计数。
 */
export function compareLenses(prediction, lenses = extractLenses(prediction)) {
  const fusionGated = prediction?.probabilityAdjustment?.fusionGatedOff;
  const voters = lenses.filter((l) =>
    l.kind === "wld" && l.available &&
    (l.key === "market" || l.key === "dixon-coles" || l.key === "experience" ||
      (l.key === "fusion" && !fusionGated))
  );
  const picks = voters.map((v) => v.pick.key);
  // 一致性:统计各 outcome 被多少路独立处理选为 argmax。
  const tally = {};
  for (const k of picks) tally[k] = (tally[k] ?? 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? null;
  const agree = top ? top[1] : 0;
  const total = voters.length;
  const unanimous = total >= 2 && agree === total;
  const split = total >= 2 && agree < total;

  // 离散度:各独立路 P(home)/P(draw)/P(away) 的极差,取最大维度。
  let maxSpread = 0;
  for (const k of KEYS) {
    const vals = voters.map((v) => v.probs[k]).filter(Number.isFinite);
    if (vals.length >= 2) maxSpread = Math.max(maxSpread, Math.max(...vals) - Math.min(...vals));
  }

  // 锚(最终采纳)与多数处理是否同向。
  const anchor = argmax(prediction?.probabilities);
  const anchorVsConsensus = top && anchor ? (anchor.key === top[0]) : null;

  const flags = [];
  if (unanimous) flags.push({ level: "ok", text: `🟢 多模态一致:${total} 路独立处理同选 ${CODE[picks[0]]?.[1] ?? picks[0]}` });
  if (split) flags.push({
    level: "warn",
    text: `🟡 多模态分歧:${total} 路只 ${agree} 路同向(极差${pct(maxSpread)})——信心下调,建议覆盖/双选,不宜单选搏胆`,
  });
  if (anchorVsConsensus === false) flags.push({
    level: "warn",
    text: `⚠️ 最终锚(${anchor.label})偏离多数处理共识(${CODE[top[0]]?.[1] ?? top[0]})——校准/软赛事重校准介入,留意`,
  });
  // 历史平局高但锚不推平(透明提示,不改向)。
  const dr = Number(prediction?.experienceContext?.historicalDrawRate);
  if (Number.isFinite(dr) && dr >= 0.28 && anchor?.key !== "draw") {
    flags.push({ level: "warn", text: `⚠️ 历史同情境平局率 ${pct(dr)},锚未推平——可双选兼顾` });
  }

  return {
    voters: voters.map((v) => ({ key: v.key, label: v.label, pick: v.pick.label, prob: v.pick.prob })),
    voterCount: total,
    agree,
    unanimous,
    split,
    maxSpread,
    consensusOutcome: top ? top[0] : null,
    anchorOutcome: anchor?.key ?? null,
    anchorVsConsensus,
    flags,
  };
}

/**
 * 模态裁决:在该 联赛×数据×赔率 模态下,模型该信任哪路处理、为什么(纯解释,不改锚)。
 */
export function dispatchVerdict(regime, compare) {
  const { leagueMode, oddsMode, dataMode } = regime;
  const hasMarket = dataMode.includes("market-odds");
  const dcNeutral = dataMode.includes("dixon-coles-neutral") || dataMode.includes("cold-start");

  let lead, why;
  if (leagueMode === "soft-international") {
    lead = "软赛事重校准 + 历史经验平局率";
    why = "国际赛/友谊赛真实平局率28-30%,五大联赛 isotonic 会把强热门压到~81%、机械钉平局~13%;软赛事按赛事性质先验+历史同情境有界重校准平局(俱乐部路径零改动)。";
  } else if (leagueMode === "east-asia") {
    lead = "DC球队强度 + 联赛经验(警惕高平局)";
    why = "东亚联赛弱主场优势(日职主场仅+7.6pp)、高平局,且市场赔率覆盖薄;以 DC 强度与联赛经验为主,均势场优先覆盖平局。";
  } else if (leagueMode === "club-top5" && hasMarket && oddsMode === "strong-fav") {
    lead = "市场赔率主导(DC/经验交叉验证)";
    why = "五大联赛流动性最高,收盘赔率已含全部公开信息;DC与历史经验作交叉验证,不叠加结构性修正(回测证融合层对市场路径净负)。";
  } else if (leagueMode === "club-2nd-euro" && hasMarket) {
    lead = "市场赔率 + 历史类比(同联赛盘口情境)";
    why = "欧洲次级联赛有开/收盘赔率与半场,历史类比引擎可按同联赛热门强度+盘口漂移匹配相近样本;市场为锚、类比作情境参照。";
  } else if (leagueMode === "cup") {
    lead = "市场赔率 + 阵容/轮换信号(若有)";
    why = "杯赛轮换/赛制(主客两回合/中立场)使纯历史强度失真;以市场为锚,阵容信号到位时纳入。";
  } else if (!hasMarket || dcNeutral) {
    lead = "DC泊松 + 联赛经验(冷启动降级)";
    why = "本场无可靠市场赔率/或 DC 球队系数中性空转;退到联赛经验基线λ与全局先验,诚实标注低置信、优先覆盖。";
  } else {
    lead = "市场赔率为锚 + 多路交叉验证";
    why = "常规有赔率场:市场为锚,DC/经验/盘口多路交叉验证一致性。";
  }

  // 模态对信心的修正(只提示)。
  let confidenceNote;
  if (compare?.unanimous) confidenceNote = "多模态一致 → 该模态下可信度相对高";
  else if (compare?.split) confidenceNote = "多模态分歧 → 信心下调,建议覆盖/双选(不弃赛,玩法由你定)";
  else confidenceNote = "可投票处理路不足,以锚为准";

  return { lead, why, confidenceNote };
}

/** 单场完整多模态分析(对比 + 分流 + 裁决)。 */
export function multimodalAnalysis(prediction) {
  if (!prediction?.fixture || prediction?.unpredictable) return null;
  const regime = classifyRegime(prediction);
  const lenses = extractLenses(prediction);
  const compare = compareLenses(prediction, lenses);
  const dispatch = dispatchVerdict(regime, compare);
  const fx = prediction.fixture;
  // 一段可读叙述:模态画像 → 各路对比 → 裁决。
  const lensLine = lenses
    .filter((l) => l.available)
    .map((l) => `${l.label}=${l.pick.label}(${pct(l.pick.prob)})`)
    .join(" | ");
  const text = [
    `【模态】${regime.label}`,
    `【对比】${lensLine}`,
    `【主导处理】${dispatch.lead} —— ${dispatch.why}`,
    ...compare.flags.map((f) => `【${f.level === "ok" ? "一致" : "提示"}】${f.text}`),
    `【信心】${dispatch.confidenceNote}`,
  ].join("\n");
  return { fixture: { homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, competition: fx.competition }, regime, lenses, compare, dispatch, text };
}

/**
 * 批量:产出竞彩/14场 多模态对比表(xlsx 行),供 daily-report 接入。
 * 列:对阵 | 模态画像 | 市场 | DC | 融合 | 经验 | 让球 | 最终锚 | 一致性 | 主导处理
 */
export function multimodalComparisonRows(predictions) {
  const header = [
    "⚡ 多模态协作 · 分联赛分情况对比分析", "", "", "", "", "", "", "", "", "",
  ];
  const cols = ["对阵", "模态画像", "市场赔率", "DC模型", "信号融合", "历史经验", "让球盘口", "最终锚", "一致性/分歧", "主导处理 + 裁决"];
  const rows = [header, cols];
  const cell = (l) => (l && l.available ? `${l.pick.label} ${pct(l.pick.prob)}` : "—");
  for (const p of predictions ?? []) {
    if (p.unpredictable) continue;
    const a = multimodalAnalysis(p);
    if (!a) continue;
    const byKey = Object.fromEntries(a.lenses.map((l) => [l.key, l]));
    const consensus = a.compare.unanimous
      ? `🟢 一致(${a.compare.voterCount}路)`
      : a.compare.split
        ? `🟡 分歧(${a.compare.agree}/${a.compare.voterCount}·极差${pct(a.compare.maxSpread)})`
        : `⚪ 投票路不足`;
    rows.push([
      `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
      a.regime.label,
      cell(byKey.market),
      cell(byKey["dixon-coles"]),
      cell(byKey.fusion),
      cell(byKey.experience),
      cell(byKey.handicap),
      cell(byKey.final),
      consensus,
      `${a.dispatch.lead}`,
    ]);
  }
  return rows;
}
