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
import { buildHistoricalLenses } from "./historical-lens.js";

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
    // 让球覆盖是「主胜/走盘push/客胜」覆盖分布,whole-line 无真"平"→ 缺项不塞 NaN(无脏数据),
    //   只保留有限值;它是 kind:"handicap"、不进 wld 投票、不按 wld 归一审计。
    const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    lenses.push({
      key: "handicap", label: "让球盘口覆盖", kind: "handicap",
      probs: { home: fin(p.home), draw: fin(p.draw), away: fin(p.away) },
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

// 胜平负码 → 中文(本地映射,避免 import prediction-engine 造成循环依赖)。
const CODE_LABEL = { "3": "主胜", "1": "平局", "0": "客胜" };
function codeToLabel(code) { return CODE_LABEL[String(code)] ?? "—"; }

// "2-1" 比分串 → 胜平负码(distribution 缺该项时的兜底,纯算术不编造)。
function outcomeFromScoreString(score) {
  const m = /^(\d+)\s*[-:]\s*(\d+)$/.exec(String(score ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  return h > a ? "3" : h < a ? "0" : "1";
}

/**
 * 比分小模型(2026-05-31):各路对"本场比分"的处理并排 + 与 wld 锚一致性 + 模态裁决。
 * 只读已算好的真实中间量:DC 真泊松矩阵(scorePicks)、市场比分赔率(scoreOdds,无则 available:false)。
 * 严守 [[feedback_wld_anchor_inference]]:比分首选方向必须落在 wld 锚方向内,不反推 wld。
 */
export function analyzeScorePlay(prediction, regime = classifyRegime(prediction), h2hHist = null) {
  const sp = prediction?.scorePicks;
  const anchorCode = prediction?.pick?.code ?? null;
  const sources = [];
  // ① DC 真泊松矩阵(本模型核心比分源)
  const dcAvail = Boolean(sp?.primary) && Number.isFinite(Number(sp?.primaryProbability));
  sources.push({
    key: "dc-matrix", label: "DC真泊松矩阵",
    available: dcAvail,
    pick: dcAvail ? sp.primary : null,
    prob: dcAvail ? Number(sp.primaryProbability) : null,
    note: dcAvail ? (sp.source ?? "dixon-coles") : "无比分分布",
  });
  // ② 市场比分赔率(竞彩单场详情页;今日多无→诚实 available:false)
  const so = prediction?.marketSnapshot?.scoreOdds;
  const marketAvail = Boolean(so) && typeof so === "object" && Object.keys(so).length > 0;
  sources.push({
    key: "market-score", label: "市场比分赔率",
    available: marketAvail,
    pick: marketAvail ? topKeyByMinOdds(so) : null,
    prob: null,
    note: marketAvail ? "竞彩比分盘去赔率反推" : "本场未抓到比分赔率(不编造)",
  });
  // ③ 历史交锋常见比分(当前主队视角;数据稀疏则 available:false 不编造)
  const histScoreAvail = Boolean(h2hHist?.available && h2hHist.topScores?.length);
  sources.push({
    key: "h2h-score", label: "历史交锋常见比分",
    available: histScoreAvail,
    pick: histScoreAvail ? h2hHist.topScores[0].score : null,
    prob: null,
    note: histScoreAvail
      ? `交锋${h2hHist.n}场 Top: ${h2hHist.topScores.map((s) => `${s.score}×${s.count}`).join(" ")}`
      : (h2hHist?.note ?? "无交锋史(不编造)"),
  });
  // 与 wld 锚一致性:比对**推荐比分 primary**(已按 wld 方向约束)所属 outcome,而非全局最可能比分。
  //   注意:足球里全局最可能"比分"常是 1-1/0-0 平,但最可能"结果"可为主胜——那是正常,不算不一致。
  const primaryEntry = dcAvail ? (sp.distribution ?? []).find((d) => d.score === sp.primary) : null;
  const primaryOutcome = primaryEntry?.outcome ?? outcomeFromScoreString(sp?.primary);
  const wldConsistent = !dcAvail || primaryOutcome == null || anchorCode == null || primaryOutcome === anchorCode;
  const flags = [];
  if (dcAvail && !wldConsistent) {
    flags.push({ level: "warn", text: `⚠️ 比分首选 ${sp.primary}(属${codeToLabel(primaryOutcome)})与胜平负锚(${codeToLabel(anchorCode)})不一致` });
  }
  // 模态裁决:低进球联赛/软赛事比分倾向小分差。
  const lowScoring = ["east-asia", "soft-international"].includes(regime?.leagueMode);
  const regimeVerdict = lowScoring
    ? "低进球/软赛事 → 比分以小分差(1-0/0-0/1-1)为主,大比分谨慎"
    : "常规联赛 → DC 矩阵首选为主,备选覆盖近邻比分";
  return {
    playtype: "比分", available: dcAvail,
    anchor: dcAvail ? { label: sp.primary, prob: Number(sp.primaryProbability), alt: sp.secondary ?? null } : null,
    sources, wldConsistent, regimeVerdict, flags,
  };
}

/**
 * 半全场小模型(2026-05-31):泊松半全场联合分布 vs 市场半全场赔率,+ FT 段与 wld 锚一致性。
 */
export function analyzeHalfFullPlay(prediction, regime = classifyRegime(prediction)) {
  const hf = prediction?.halfFullPicks;
  const anchorCode = prediction?.pick?.code ?? null;
  const sources = [];
  const modelAvail = Boolean(hf?.primary) && Number.isFinite(Number(hf?.primaryProbability));
  sources.push({
    key: "poisson-joint", label: "泊松半全场联合分布",
    available: modelAvail,
    pick: modelAvail ? hf.primary : null,
    prob: modelAvail ? Number(hf.primaryProbability) : null,
    note: modelAvail ? (hf.source ?? "poisson-half-joint") : "无半全场分布",
  });
  const hfo = prediction?.marketSnapshot?.halfFullOdds;
  const marketAvail = Boolean(hfo) && typeof hfo === "object" && Object.keys(hfo).length > 0;
  sources.push({
    key: "market-hf", label: "市场半全场赔率",
    available: marketAvail,
    pick: marketAvail ? topKeyByMinOdds(hfo) : null,
    prob: null,
    note: marketAvail ? "半全场盘去赔率反推" : "本场未抓到半全场赔率(不编造)",
  });
  // FT 段(全场结果)必须与 wld 锚一致:"主胜-主胜" → FT="主胜"。
  const ftLabel = modelAvail ? String(hf.primary).split("-")[1] : null;
  const wldConsistent = !modelAvail || ftLabel == null || anchorCode == null || ftLabel === codeToLabel(anchorCode);
  const flags = [];
  if (modelAvail && !wldConsistent) {
    flags.push({ level: "warn", text: `⚠️ 半全场首选 ${hf.primary} 的全场段(${ftLabel})与胜负平锚(${codeToLabel(anchorCode)})不一致` });
  }
  const highDraw = regime?.leagueMode === "east-asia" || regime?.leagueMode === "soft-international";
  const regimeVerdict = highDraw
    ? "高平局模态 → 关注 平-主/平-客(慢热反超)与 平-平 路径"
    : "常规 → 联合分布首选为主,备选取同向次高频路径";
  return {
    playtype: "半全场", available: modelAvail,
    anchor: modelAvail ? { label: hf.primary, prob: Number(hf.primaryProbability), alt: hf.secondary ?? null } : null,
    sources, wldConsistent, regimeVerdict, flags,
  };
}

/**
 * 数据变化小模型(2026-05-31,用户重点要求):盘口资金流向 = 欧赔开→现漂移 + 亚盘水位早→晚 + 历史漂移经验 + 市场背离。
 * 全部读已算好的真实快照,无真实赔率则 available:false,绝不编造漂移。
 * 这是模型给"≠跟市场买热门"独立观点的正位(让球/比分的二阶 alpha,见 AS 档)。
 */
export function analyzeDataChangePlay(prediction) {
  const euro = prediction?.marketSnapshot?.europeanOdds;
  const init = euro?.initial, cur = euro?.current ?? euro?.final;
  const moves = [];
  let euroMoved = false;
  if (init && cur) {
    for (const k of KEYS) {
      const i = Number(init[k]), c = Number(cur[k]);
      if (Number.isFinite(i) && Number.isFinite(c) && i > 0) {
        const rel = (c - i) / i;
        if (Math.abs(rel) >= 0.03) { // <3% 视为未动
          euroMoved = true;
          moves.push({ outcome: CODE_LABEL[CODE[k][0]] ?? CODE[k][1], dir: rel < 0 ? "升温(降赔)" : "降温(升赔)", pct: Math.round(Math.abs(rel) * 100) });
        }
      }
    }
  }
  // 亚盘水位早→晚
  const aw = prediction?.asianWaterAnalysis;
  let waterNote = null, waterMoved = false;
  if (aw?.early && aw?.late) {
    const eh = Number(aw.early?.homeOdds), lh = Number(aw.late?.homeOdds);
    const ea = Number(aw.early?.awayOdds), la = Number(aw.late?.awayOdds);
    if ([eh, lh].every(Number.isFinite) && Math.abs(lh - eh) >= 0.03) {
      waterMoved = true;
      waterNote = `上盘水位 ${eh.toFixed(2)}→${lh.toFixed(2)}(${lh > eh ? "升水=资金不敢买上盘,警惕大热不过盘" : "降水=上盘被加注"})`;
    } else if ([ea, la].every(Number.isFinite) && Math.abs(la - ea) >= 0.03) {
      waterMoved = true;
      waterNote = `下盘水位 ${ea.toFixed(2)}→${la.toFixed(2)}(${la < ea ? "降水=受让方被加注,让球方危险" : "升水"})`;
    }
  }
  const md = prediction?.marketDivergence;
  const drift = prediction?.experienceContext?.drift;
  const available = Boolean((init && cur) || (aw?.early && aw?.late));
  const flags = [];
  if (md && md.aligned === false) flags.push({ level: "warn", text: `⚠️ ${md.tag ?? "逆市:模型方向非市场热门"}(逆市押独门是陷阱)` });
  if (waterMoved && waterNote) flags.push({ level: "warn", text: `💧 ${waterNote}` });
  const readingParts = [];
  if (euroMoved) readingParts.push("欧赔:" + moves.map((m) => `${m.outcome}${m.dir}${m.pct}%`).join("、"));
  else if (init && cur) readingParts.push("欧赔纹丝不动(无温差)");
  if (waterNote) readingParts.push("亚盘:" + waterNote);
  if (drift?.driftBand) readingParts.push(`历史漂移档「${drift.driftBand}」`);
  if (md) readingParts.push(md.aligned === false ? "⛔逆市" : "✓与市场同向");
  return {
    playtype: "数据变化", available,
    euroMoved, waterMoved,
    moves, waterNote,
    aligned: md ? md.aligned : null,
    reading: available ? readingParts.join(" | ") : "本场无开/收盘双价或亚盘双时点 → 无数据变化可读(不编造)",
    flags,
  };
}

// 从赔率对象取最低赔(=最被看好)的键,作市场首选。不编造:空对象返回 null。
function topKeyByMinOdds(odds) {
  let best = null;
  for (const [k, v] of Object.entries(odds ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1 && (!best || n < best.odds)) best = { key: k, odds: n };
  }
  return best ? best.key : null;
}

/**
 * 四玩法小模型汇总:方向(胜平负) + 比分 + 半全场 + 数据变化 + 历史比赛数据。
 * 每路只读真实中间量、各带模态裁决与 available 诚实标注。
 * @param {object} [history] 历史比赛库(loadHistoricalResults 结果);传入则附历史小模型,缺则历史 available:false。
 */
export function analyzePlaytypes(prediction, regime = classifyRegime(prediction), compare = compareLenses(prediction), history = null) {
  const historical = buildHistoricalLenses(prediction?.fixture, history);
  return {
    wld: {
      playtype: "方向(胜平负)",
      available: compare.voterCount > 0,
      anchor: compare.anchorOutcome ? { label: codeToLabel(CODE[compare.anchorOutcome]?.[0]), key: compare.anchorOutcome } : null,
      voters: compare.voters,
      consensus: compare.consensusOutcome,
      unanimous: compare.unanimous,
      split: compare.split,
      anchorVsConsensus: compare.anchorVsConsensus,
      flags: compare.flags,
      // 历史比赛数据小模型(独立证据:H2H 胜平负 + 近期状态;并排展示不反推 wld 锚)。
      historical: { h2h: historical.h2h, recentForm: historical.recentForm },
    },
    score: analyzeScorePlay(prediction, regime, historical.h2h),
    halfFull: analyzeHalfFullPlay(prediction, regime),
    dataChange: analyzeDataChangePlay(prediction),
    historical,
  };
}

/**
 * 单场完整多模态分析(分流 + 四玩法小模型 + 历史比赛数据 + 裁决)。
 * @param {object} prediction
 * @param {{history?:Array}} [options] history=历史比赛库(loadHistoricalResults),传入则附 H2H/近期 历史小模型。
 */
export function multimodalAnalysis(prediction, options = {}) {
  if (!prediction?.fixture || prediction?.unpredictable) return null;
  const history = options?.history ?? null;
  const regime = classifyRegime(prediction);
  const lenses = extractLenses(prediction);
  const compare = compareLenses(prediction, lenses);
  const dispatch = dispatchVerdict(regime, compare);
  const playtypes = analyzePlaytypes(prediction, regime, compare, history);
  const fx = prediction.fixture;
  // 一段可读叙述:模态画像 → 方向各路对比 → 比分/半全场/数据变化/历史 → 裁决。
  const lensLine = lenses
    .filter((l) => l.available)
    .map((l) => `${l.label}=${l.pick.label}(${pct(l.pick.prob)})`)
    .join(" | ");
  const scoreLine = playtypes.score.available ? `${playtypes.score.anchor.label}(${pct(playtypes.score.anchor.prob)})` : "—";
  const hfLine = playtypes.halfFull.available ? `${playtypes.halfFull.anchor.label}(${pct(playtypes.halfFull.anchor.prob)})` : "—";
  const hist = playtypes.historical;
  const histLine = hist.available
    ? [hist.h2h.available ? hist.h2h.note : null, hist.recentForm.available ? hist.recentForm.note : null].filter(Boolean).join(" | ")
    : "无足量历史交锋/近期数据(不编造)";
  const text = [
    `【模态】${regime.label}`,
    `【方向·各路对比】${lensLine}`,
    `【比分】${scoreLine} —— ${playtypes.score.regimeVerdict}`,
    `【半全场】${hfLine} —— ${playtypes.halfFull.regimeVerdict}`,
    `【数据变化】${playtypes.dataChange.reading}`,
    `【历史比赛数据】${histLine}`,
    `【主导处理】${dispatch.lead} —— ${dispatch.why}`,
    ...compare.flags.map((f) => `【${f.level === "ok" ? "一致" : "提示"}】${f.text}`),
    ...playtypes.score.flags.map((f) => `【提示】${f.text}`),
    ...playtypes.halfFull.flags.map((f) => `【提示】${f.text}`),
    ...playtypes.dataChange.flags.map((f) => `【提示】${f.text}`),
    `【信心】${dispatch.confidenceNote}`,
  ].join("\n");
  return { fixture: { homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, competition: fx.competition }, regime, lenses, compare, playtypes, dispatch, text };
}

/**
 * 每层全面审计(2026-05-31 用户要求"每层加一道全面审计,避免孤儿/假数据/降质量")。
 * 多模态是**纯读取层**,不改 pick/probabilities → 质量零影响;审计只验证本层是否如实:
 *   硬 blocker(让展示变假/变错):
 *     - 某路标 available:true 但概率非有限/不归一(展示了不存在的数);
 *     - compare 的锚 ≠ prediction.pick(本层误读了锚方向);
 *     - 比分/半全场标 available 却无支撑分布(凭空给路径)。
 *   warning(质量提示,不拦):锚偏离独立共识、方向不一致、逆市、数据变化分歧。
 * @returns {{ok, blockers:string[], warnings:string[], layers:object}}
 */
export function auditMultimodalLayer(prediction) {
  const blockers = [];
  const warnings = [];
  // 复用 prediction.multimodal(若已附,含 prediction-engine 传入的历史库结果),否则现算。
  const a = prediction?.multimodal ?? multimodalAnalysis(prediction);
  const tag = `${prediction?.fixture?.homeTeam ?? "?"} vs ${prediction?.fixture?.awayTeam ?? "?"}`;
  if (!a) return { ok: true, blockers, warnings, layers: { note: "unpredictable/无fixture → 本层正确跳过(不编造)" } };

  // wld 层:真胜平负分布(kind:"wld")展示的每路概率必须有限且归一;锚必须 == prediction.pick。
  //   让球覆盖路(kind:"handicap")是「主胜/走盘/客胜」覆盖分布,不按 wld 归一,只查 pick 存在。
  for (const l of a.lenses) {
    if (l.kind === "wld") {
      if (l.available) {
        const s = (l.probs?.home ?? 0) + (l.probs?.draw ?? 0) + (l.probs?.away ?? 0);
        if (!Number.isFinite(s) || Math.abs(s - 1) > 0.02) blockers.push(`[${tag}] 方向路「${l.label}」标 available 但概率不归一(${Number.isFinite(s) ? s.toFixed(3) : "NaN"})=假数据`);
      } else if (l.probs) {
        blockers.push(`[${tag}] 方向路「${l.label}」available=false 却带概率值=自相矛盾`);
      }
    } else if (l.available && !l.pick) {
      blockers.push(`[${tag}] 「${l.label}」标 available 却无首选=假`);
    }
  }
  if (a.compare.anchorOutcome && prediction?.pick?.key && a.compare.anchorOutcome !== prediction.pick.key) {
    blockers.push(`[${tag}] 多模态锚(${a.compare.anchorOutcome})≠ 模型 pick(${prediction.pick.key})=本层误读方向`);
  }
  if (a.compare.anchorVsConsensus === false) warnings.push(`[${tag}] 方向锚偏离独立共识(${a.compare.consensusOutcome})`);

  // 比分层:标 available 必须有 anchor.label;wld 不一致只 warn(已由 selfcheck 硬拦,避免双拦)。
  if (a.playtypes.score.available && !a.playtypes.score.anchor?.label) blockers.push(`[${tag}] 比分标 available 却无首选=假`);
  if (a.playtypes.score.available && !a.playtypes.score.wldConsistent) warnings.push(`[${tag}] 比分方向与 wld 锚不一致`);

  // 半全场层:同上。
  if (a.playtypes.halfFull.available && !a.playtypes.halfFull.anchor?.label) blockers.push(`[${tag}] 半全场标 available 却无首选=假`);
  if (a.playtypes.halfFull.available && !a.playtypes.halfFull.wldConsistent) warnings.push(`[${tag}] 半全场全场段与 wld 锚不一致`);

  // 数据变化层:标 available 必须有 reading;不可编造(available=false 时 reading 必须是"无…不编造"语)。
  const dc = a.playtypes.dataChange;
  if (!dc.available && (dc.euroMoved || dc.waterMoved)) blockers.push(`[${tag}] 数据变化 available=false 却报告了漂移=编造`);
  // 去掉开头的提示符号(emoji 含代理对,用"非中英数字"前缀剥除,避免 char class 拆坏代理对)。
  dc.flags.forEach((f) => warnings.push(`[${tag}] 数据变化:${String(f.text).replace(/^[^一-龥A-Za-z]+/, "")}`));

  // 历史比赛数据层:H2H 标 available 必须样本≥3且 wld 归一;available:false 不得带 wld/比分(防编造历史)。
  const hist = a.playtypes.historical;
  if (hist?.h2h) {
    const h = hist.h2h;
    if (h.available) {
      const s = (h.wld?.home ?? 0) + (h.wld?.draw ?? 0) + (h.wld?.away ?? 0);
      if (!(h.n >= 3) || !Number.isFinite(s) || Math.abs(s - 1) > 0.02) {
        blockers.push(`[${tag}] H2H 历史标 available 但样本不足/wld 不归一(n=${h.n},Σ=${Number.isFinite(s) ? s.toFixed(3) : "NaN"})=假历史`);
      }
    } else if (h.wld) {
      blockers.push(`[${tag}] H2H available=false 却带 wld=编造历史`);
    }
  }
  if (hist?.recentForm && !hist.recentForm.available && hist.recentForm.lean) {
    blockers.push(`[${tag}] 近期战绩 available=false 却给倾向=编造历史`);
  }

  return { ok: blockers.length === 0, blockers, warnings, layers: { regime: a.regime.label } };
}

/**
 * 批量多模态层审计(供 comprehensive-audit 第⑧道闸门)。
 * @returns {{ok, analyzed, blockers:string[], warnings:string[], byPlaytype:object}}
 */
export function auditMultimodalBatch(predictions) {
  const blockers = [];
  const warnings = [];
  let analyzed = 0;
  const byPlaytype = { 方向: { ok: 0, warn: 0 }, 比分: { ok: 0, warn: 0, na: 0 }, 半全场: { ok: 0, warn: 0, na: 0 }, 数据变化: { ok: 0, warn: 0, na: 0 }, 历史: { ok: 0, na: 0 } };
  for (const p of predictions ?? []) {
    if (p?.unpredictable || !p?.fixture) continue;
    analyzed += 1;
    const r = auditMultimodalLayer(p);
    blockers.push(...r.blockers);
    warnings.push(...r.warnings);
    const a = p.multimodal ?? multimodalAnalysis(p);
    if (!a) continue;
    byPlaytype.方向[a.compare.anchorVsConsensus === false ? "warn" : "ok"] += 1;
    for (const [pt, key] of [["比分", "score"], ["半全场", "halfFull"], ["数据变化", "dataChange"]]) {
      const sec = a.playtypes[key];
      if (!sec.available) byPlaytype[pt].na += 1;
      else byPlaytype[pt][sec.flags?.length ? "warn" : "ok"] += 1;
    }
    byPlaytype.历史[a.playtypes.historical?.available ? "ok" : "na"] += 1;
  }
  return { ok: blockers.length === 0, analyzed, blockers, warnings, byPlaytype };
}

/**
 * 汇总:把一批预测的多模态对比 roll-up 成总览(供 prediction-engine 返回 + 报告头部)。
 * 只统计真实可对比的场(有分析、≥1 路独立投票),诚实计数,不编造。
 * @returns {{analyzed,unanimous,split,insufficient,anchorDivergent,drawRisk,byLeagueMode,byOddsMode}}
 */
export function summarizeMultimodal(predictions) {
  const out = {
    analyzed: 0, unanimous: 0, split: 0, insufficient: 0,
    anchorDivergent: 0, drawRisk: 0,
    byLeagueMode: {}, byOddsMode: {},
  };
  for (const p of predictions ?? []) {
    if (p?.unpredictable) continue;
    const a = p?.multimodal ?? multimodalAnalysis(p);
    if (!a) continue;
    out.analyzed += 1;
    if (a.compare?.unanimous) out.unanimous += 1;
    else if (a.compare?.split) out.split += 1;
    else out.insufficient += 1;
    if (a.compare?.anchorVsConsensus === false) out.anchorDivergent += 1;
    if (a.compare?.flags?.some((f) => /平局率/.test(f.text))) out.drawRisk += 1;
    const lm = a.regime?.leagueModeLabel ?? "未归类";
    const om = a.regime?.oddsModeLabel ?? "无赔率";
    out.byLeagueMode[lm] = (out.byLeagueMode[lm] ?? 0) + 1;
    out.byOddsMode[om] = (out.byOddsMode[om] ?? 0) + 1;
  }
  return out;
}

/**
 * 批量:产出竞彩/14场 多模态对比表(xlsx 行),供 daily-report 接入。
 * 小模型按不同情况分析 → 汇总到大模型的最终表格:
 *   对阵 | 模态画像 | 方向各路(市场/DC/融合/经验/让球) | 一致性 | 比分 | 半全场 | 数据变化 | 主导处理裁决
 */
export function multimodalComparisonRows(predictions) {
  const cols = ["对阵", "模态画像", "市场赔率", "DC模型", "信号融合", "历史经验", "让球盘口",
    "最终锚", "一致性/分歧", "比分(小模型)", "半全场(小模型)", "数据变化(资金流向)", "历史比赛(H2H/近期)", "主导处理 + 裁决"];
  const header = ["⚡ 多模态协作 · 四玩法小模型 + 历史比赛数据 分情况分析 → 汇总", ...new Array(cols.length - 1).fill("")];
  const rows = [header, cols];
  const cell = (l) => (l && l.available ? `${l.pick.label} ${pct(l.pick.prob)}` : "—");
  for (const p of predictions ?? []) {
    if (p.unpredictable) continue;
    // 复用已附 history 的 p.multimodal(prediction-engine 传入历史库),无则现算(历史 available:false)。
    const a = p.multimodal ?? multimodalAnalysis(p);
    if (!a) continue;
    const byKey = Object.fromEntries(a.lenses.map((l) => [l.key, l]));
    const consensus = a.compare.unanimous
      ? `🟢 一致(${a.compare.voterCount}路)`
      : a.compare.split
        ? `🟡 分歧(${a.compare.agree}/${a.compare.voterCount}·极差${pct(a.compare.maxSpread)})`
        : `⚪ 投票路不足`;
    const sc = a.playtypes.score;
    const hf = a.playtypes.halfFull;
    const scoreCell = sc.available
      ? `${sc.anchor.label} ${pct(sc.anchor.prob)}${sc.wldConsistent ? "" : " ⚠向"}`
      : "—";
    const hfCell = hf.available
      ? `${hf.anchor.label} ${pct(hf.anchor.prob)}${hf.wldConsistent ? "" : " ⚠向"}`
      : "—";
    const hist = a.playtypes.historical;
    const histCell = hist?.available
      ? [hist.h2h?.available ? hist.h2h.note : null, hist.recentForm?.available ? `近期净差${hist.recentForm.ppgDiff > 0 ? "+" : ""}${hist.recentForm.ppgDiff}` : null].filter(Boolean).join("；")
      : "—(无足量历史)";
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
      scoreCell,
      hfCell,
      a.playtypes.dataChange.reading,
      histCell,
      `${a.dispatch.lead}`,
    ]);
  }
  return rows;
}
