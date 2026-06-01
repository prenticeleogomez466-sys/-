/**
 * 逐场差异化分析引擎(2026-05-31)
 * ──────────────────────────────────────────────────
 * 解决"每场分析千篇一律"——旧 buildReason / generateExplanation 是固定模板,
 * 不管英超强弱深盘还是意甲均势浅盘还是信息稀缺友谊赛,都念同一段话。
 *
 * 本引擎对每场 prediction:
 *   1) 赛事原型分类  archetype = 联赛性质 × 实力差 × 盘口深度(三维,逐场不同)
 *   2) 主导逻辑选择  从本场真实算出的信号里按 |影响力| 排序,只突出真正决定本场的 1-3 条
 *   3) 盘口针对性解读 按让球深度(深盘/标盘/浅盘/平手/受让)走不同读法
 *   4) 针对性风险    爆冷点按 archetype + riskTags 逐场定制
 *
 * 全部数字来源于 prediction 已算字段(零假编,遵 feedback_no_fabrication_live_only)。
 * 缺字段就跳过该条,绝不臆造。
 */
import { leagueProfile } from "./league-profile.js";

const PCT = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—");
// divergence 来自 clv-confidence-gate.gate(),已是 pp 单位(模型比市场高几个百分点),勿再 ×100。
const PPraw = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}pp` : "—");

/* ───────────────── 1. 赛事原型分类 ───────────────── */

function classifyLeague(competition, profile) {
  const c = String(competition ?? "");
  // 信息稀缺=友谊/热身/中性场国家队赛(按赛事名判定,不靠画像缺失误判)。
  const sparse = /友谊|热身|friendly|表演赛|trophy|超级杯|邀请赛/i.test(c);
  const tags = [];
  if (sparse) tags.push({ key: "sparse", text: "信息稀缺(友谊/中性场,态度>实力,赔率参考性低)" });
  // 画像缺失只是"数据覆盖不足"的诚实标注,不等于友谊赛。
  else if (profile?.matched === false) tags.push({ key: "no-profile", text: "无历史联赛画像(冷门联赛,统计先验弱、参考赔率为主)" });
  if (Number.isFinite(profile?.avgGoals)) {
    if (profile.avgGoals >= 2.9) tags.push({ key: "high-scoring", text: `进攻型联赛(场均 ${profile.avgGoals.toFixed(2)} 球,天然偏大球)` });
    else if (profile.avgGoals <= 2.45) tags.push({ key: "low-scoring", text: `防守型联赛(场均 ${profile.avgGoals.toFixed(2)} 球,天然偏小球/低比分)` });
  }
  if (Number.isFinite(profile?.drawRate) && profile.drawRate >= 0.30)
    tags.push({ key: "draw-heavy", text: `平局多发联赛(历史平局率 ${PCT(profile.drawRate)})` });
  if (Number.isFinite(profile?.homeWinRate) && profile.homeWinRate >= 0.48)
    tags.push({ key: "home-fortress", text: `主场优势强(历史主胜率 ${PCT(profile.homeWinRate)})` });
  return { sparse, tags };
}

function classifyStrengthGap(prediction) {
  const p = prediction.marketImpliedProbabilities ?? prediction.probabilities ?? {};
  const top = Math.max(Number(p.home) || 0, Number(p.draw) || 0, Number(p.away) || 0);
  const eg = prediction.dixonColes?.expectedGoals;
  const egDiff = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away) ? Math.abs(eg.home - eg.away) : null;
  let label, key;
  if (top >= 0.62) { key = "lopsided"; label = "实力悬殊(一边倒)"; }
  else if (top >= 0.50) { key = "clear-fav"; label = "一方明显占优"; }
  else if (top >= 0.40) { key = "slight-edge"; label = "小幅占优"; }
  else { key = "even"; label = "势均力敌(易平/难判)"; }
  return { key, label, topProb: top, egDiff };
}

function classifyHandicapDepth(prediction) {
  const snap = prediction.marketSnapshot;
  const line = Number(snap?.jingcaiHandicap?.line ?? snap?.handicapOdds?.line ?? prediction.handicapPick?.line);
  if (!Number.isFinite(line)) return { key: "none", label: "无让球盘(或仅开胜平负)", line: null };
  const abs = Math.abs(line);
  let key, label;
  if (abs >= 2) { key = "deep"; label = `深盘(让 ${line})`; }
  else if (abs >= 1) { key = "standard"; label = `标准盘(让 ${line})`; }
  else if (abs >= 0.5) { key = "shallow"; label = `浅盘(让 ${line},均势)`; }
  else { key = "level"; label = "平手盘(零让球,纯对抗)"; }
  return { key, label, line };
}

/* ───────────────── 2. 主导逻辑选择 ───────────────── */
// 把本场所有可用信号收成候选,每条带 weight(影响力 0-1)+ text(挂真实数字)。
// 只突出 weight 最高的几条 → 实现"每场抓不同重点"。

function collectDrivers(prediction, archetype) {
  const d = [];
  const snap = prediction.marketSnapshot;
  const eg = prediction.dixonColes?.expectedGoals;

  // 让球盘覆盖(深盘场=核心)
  const cover = prediction.handicapPick?.coverProbability;
  if (Number.isFinite(cover)) {
    const depth = archetype.handicap.key;
    const w = depth === "deep" ? 0.95 : depth === "standard" ? 0.75 : 0.55;
    const hpLabel = prediction.handicapPick.handicapWld?.pick ?? prediction.handicapPick.direction ?? "让球";
    d.push({ w, key: "handicap", text: `让球盘覆盖率 ${PCT(cover)}（${hpLabel}）` });
  }

  // 亚盘水位异动(庄家临场加固/松动)
  const aw = prediction.asianWaterAnalysis;
  if (aw?.signal && aw.signal !== "neutral") {
    d.push({ w: 0.85, key: "asian-water", text: `亚盘水位${aw.summary ?? aw.signal}（庄家临场${aw.direction === "home" ? "加固主队" : "倾向客队"}）` });
  }

  // 期望进球结构(强弱差具体化)
  if (eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)) {
    d.push({ w: 0.6, key: "xg", text: `DC 期望进球 主 ${eg.home.toFixed(2)} / 客 ${eg.away.toFixed(2)}（差 ${Math.abs(eg.home - eg.away).toFixed(2)}）` });
  }

  // 伤停/疲劳/轮换等硬风险标签(逐场不同)
  const tags = prediction.advancedFeatures?.riskTags ?? [];
  const tagText = {
    "injury-key-out": "关键球员伤停",
    "rotation-risk": "轮换风险",
    "schedule-congestion": "密集赛程疲劳",
    "long-travel": "长途客场",
    "derby": "德比强度(平局/红牌偏多)",
    "large-odds-drift": "赔率大幅漂移",
    "large-asian-line-move": "亚盘大幅移动",
    "missing-top-tier-team-intelligence": "缺顶级球队情报",
  };
  for (const t of tags) {
    if (tagText[t]) d.push({ w: t.startsWith("injury") || t === "derby" ? 0.8 : 0.65, key: `tag:${t}`, text: tagText[t] });
  }

  // 联赛极端特性(进攻/防守/平局多)— 来自 archetype
  for (const lt of archetype.league.tags) {
    if (["low-scoring", "high-scoring", "draw-heavy"].includes(lt.key))
      d.push({ w: 0.55, key: `league:${lt.key}`, text: lt.text });
  }

  // 历史同情境平局告警(均势场=核心)
  const drawAlert = prediction.experienceContext?.drawAlert;
  if (drawAlert) d.push({ w: archetype.strength.key === "even" ? 0.8 : 0.5, key: "draw-alert", text: drawAlert.replace(/^⚠️\s*/, "") });

  // 市场背离(逆市押独门=陷阱)
  const md = prediction.marketDivergence;
  if (md?.tag && md.tag !== "aligned") {
    d.push({ w: 0.7, key: "divergence", text: `模型与市场分歧 ${PPraw(md.divergence)}（${md.tag}）— 分歧越大越该谨慎` });
  }

  // 联赛专家门控:本联赛历史样本撑度(低样本=结论靠大模型兜底,该降信心)
  const le = prediction.leagueExpert;
  if (le && Number.isFinite(le.weight)) {
    // 样本越少越要提醒(权重低=本场判断更依赖全局先验,差异化空间小)
    const w = le.samples < 20 ? 0.7 : 0.45;
    d.push({ w, key: "league-expert", text: le.explain });
  }

  // ensemble 分歧
  const ev = prediction.ensembleView?.probabilities;
  const main = prediction.probabilities;
  if (ev && main && Number.isFinite(ev.home) && Math.abs(ev.home - main.home) > 0.05) {
    d.push({ w: 0.5, key: "ensemble", text: `${prediction.ensembleView.methodCount}-模型 ensemble 主胜 ${PCT(ev.home)} vs 主路径 ${PCT(main.home)}（内部分歧）` });
  }

  return d.sort((a, b) => b.w - a.w);
}

/* ───────────────── 3. 盘口针对性解读 ───────────────── */

function readHandicap(prediction, archetype) {
  const h = archetype.handicap;
  const eg = prediction.dixonColes?.expectedGoals;
  const egDiff = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away) ? eg.home - eg.away : null;
  const pick = prediction.handicapPick;
  switch (h.key) {
    case "deep": {
      const margin = egDiff != null ? Math.abs(egDiff) : null;
      const cushion = (margin != null && Number.isFinite(h.line))
        ? (margin > Math.abs(h.line) ? "期望净胜球已超盘口,安全垫足" : "期望净胜球未达盘口,无安全垫(深盘陷阱)")
        : null;
      return `深盘读法:庄家要求赢 ${Math.abs(h.line)} 球+。${cushion ?? "看强队能否打出预期净胜球。"}${pick?.label ? `本场取 ${pick.label}。` : ""}`;
    }
    case "standard":
      return `标盘读法:让 1 球是分水岭,核心看主队能否净胜≥${Math.abs(h.line)}。${pick?.coverProbability != null ? `覆盖率 ${PCT(pick.coverProbability)}。` : ""}`;
    case "shallow":
      return `浅盘读法:均势盘,走盘/平局概率高,${archetype.strength.key === "even" ? "优先兼顾平局而非单吃一边。" : "小优方需打出但别指望大胜。"}`;
    case "level":
      return `平手盘读法:纯实力对抗无让步,庄家认为两队接近,胜平负三选一、慎重单押。`;
    default:
      return archetype.handicap.label.includes("仅开") ? "本场可能只开让球盘未开胜平负(深盘特征),按让球玩法解读。" : null;
  }
}

/* ─────────── 3b. 让球↔胜负平 桥接(消除"赢球却推让球反方向"的表面矛盾) ───────────
 * 胜负平问"谁赢"(锚 wld),让球玩法问"这条盘口是否过"(独立走覆盖矩阵)。深盘/标盘场强队常
 * 赢球(主胜)但吃不下盘口 → 让球玩法转买受让方(让球客胜),人眼并排看像自相矛盾。这里挑明
 * 两者问的是不同问题,并挂比分众数佐证。**纯解释、不改任何字段、仍以 wld 为锚(遵硬规则)。**/
function bridgeHandicapWld(prediction) {
  const hp = prediction.handicapPick;
  const hw = hp?.handicapWld;
  const wld = prediction.pick;
  if (!hw || !wld || !Number.isFinite(hp.line) || hp.line === 0) return null;
  if (wld.code !== "3" && wld.code !== "0") return null;        // 仅解释主/客胜方向
  const favCoversCode = wld.code === "3" ? "3" : "0";           // 胜负平赢家"过盘"对应的让球态
  if (hw.pickCode === favCoversCode) return null;               // 让球玩法与胜负平同向 → 无歧义,不必解释
  const lineTxt = hp.line > 0 ? `受让+${hp.line}` : `让${hp.line}`;
  // 注:让球玩法取整条比分分布的覆盖概率(非单一比分众数),故不挂"众数同时满足两者"——
  //   受让/走盘边界场众数可能落在另一侧,挂众数会出现"0-1 满足让球主胜"这类假陈述。
  return `让球↔胜负平 看似不一致实则不矛盾(两个不同问题):胜负平问"谁赢"→推 ${wld.label};让球问"${lineTxt} 这条盘口是否过"→按整条比分分布的覆盖概率推 ${hw.pick}。强队常赢球但未必赢够盘口,故二者可不同向。`;
}

/* ───────────────── 4. 针对性风险 ───────────────── */

function readRisk(prediction, archetype) {
  const risks = [];
  if (archetype.league.sparse) risks.push("友谊/中性场:球队态度与轮换不可控,赔率隐含信息弱,标的整体降档");
  for (const lt of archetype.league.tags) {
    if (lt.key === "draw-heavy" && prediction.pick?.code !== "1") risks.push("平局多发联赛而本场未推平 → 提防爆平");
    if (lt.key === "home-fortress" && prediction.pick?.code === "0") risks.push("主场强队联赛却推客胜 → 逆主场优势,风险偏高");
  }
  const tags = prediction.advancedFeatures?.riskTags ?? [];
  if (tags.includes("rotation-risk")) risks.push("轮换风险:可能非最强阵,降低强队兑现度");
  if (/杯|cup|淘汰赛/i.test(String(prediction.fixture?.competition ?? ""))) risks.push("杯赛:落后方反扑/保守战术常见,爆冷高于联赛");
  if (archetype.strength.key === "even") risks.push("均势场:单押任一方命中率物理上限低,双重机会更稳");
  const md = prediction.marketDivergence;
  if (md?.tag === "逆市" || md?.tag === "contrarian") risks.push("逆市场方向:实证逆市押独门长期吃亏,严控仓位");
  return risks;
}

/* ───────────────── 主入口 ───────────────── */

export function analyzeMatch(prediction) {
  if (!prediction?.fixture) return null;
  const profile = leagueProfile(prediction.fixture.competition);
  const archetype = {
    league: classifyLeague(prediction.fixture.competition, profile),
    strength: classifyStrengthGap(prediction),
    handicap: classifyHandicapDepth(prediction),
    profile,
  };
  const drivers = collectDrivers(prediction, archetype);
  const handicapRead = readHandicap(prediction, archetype);
  const handicapBridge = bridgeHandicapWld(prediction);
  const riskRead = readRisk(prediction, archetype);

  // 原型一句话(逐场不同的"画像")
  const archetypeLine = [
    archetype.strength.label,
    archetype.handicap.label,
    ...archetype.league.tags.map((t) => t.text),
  ].filter(Boolean).join(" · ");

  // 主导逻辑:只取 top 3,且 weight≥0.5(真有影响力的)
  const topDrivers = drivers.filter((x) => x.w >= 0.5).slice(0, 3);

  return {
    archetype,
    archetypeLine,
    drivers: topDrivers,
    handicapRead,
    handicapBridge,
    riskRead,
    // 拼成一段"针对本场"的叙述(替代旧固定模板)
    narrative: buildNarrative(prediction, archetypeLine, topDrivers, handicapRead, riskRead, handicapBridge),
  };
}

function buildNarrative(prediction, archetypeLine, topDrivers, handicapRead, riskRead, handicapBridge) {
  const pick = prediction.pick;
  const probPct = pick ? PCT(pick.probability) : "—";
  const parts = [];
  parts.push(`【本场定性】${archetypeLine}`);
  if (pick) parts.push(`【方向】${pick.label}(概率 ${probPct},信心 ${prediction.confidence ?? "—"}/风险 ${prediction.risk ?? "—"})`);
  if (topDrivers.length) parts.push(`【主导逻辑】${topDrivers.map((d, i) => `${i + 1}) ${d.text}`).join("；")}`);
  if (handicapRead) parts.push(`【盘口】${handicapRead}`);
  if (handicapBridge) parts.push(`【让球↔胜负平】${handicapBridge}`);
  if (riskRead.length) parts.push(`【针对性风险】${riskRead.join("；")}`);
  return parts.join("\n");
}
