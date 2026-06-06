import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";
import { judgmentFactorColumns, judgmentFactorRow } from "./factor-analysis.js";
import { recommendFixtures, outcomeCodeToChinese, competitionCategory, coherentHandicapView } from "./prediction-engine.js";
import { deepFusionAnalysis } from "./deep-fusion-analysis.js";
import { auditRecommendations, writeRecommendationAudit } from "./recommendation-audit.js";
import { runPreExportSelfCheck, selfCheckRows } from "./pre-export-selfcheck.js";
import { runComprehensiveAudit, comprehensiveAuditRows } from "./comprehensive-audit.js";
import { multimodalComparisonRows } from "./multimodal-collab.js";
import { worldCupContextLine } from "./worldcup-context.js";
import { assertLatestRealtimeSourceGate } from "./realtime-source-gate.js";
import { writeXlsxWorkbook } from "./xlsx-writer.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const ledgerPath = join(exportDir, "recommendation-ledger.json");

// 联赛可信度 profile(由 build-league-reliability.mjs 写);进程内缓存。
let _leagueReliabilityCache;
export function loadLeagueReliability() {
  if (_leagueReliabilityCache !== undefined) return _leagueReliabilityCache;
  try {
    const p = join(exportDir, "league-reliability.json");
    _leagueReliabilityCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch { _leagueReliabilityCache = null; }
  return _leagueReliabilityCache;
}
export function _resetLeagueReliabilityCache() { _leagueReliabilityCache = undefined; }

export function buildDailyRecommendationPackage(date, options = {}) {
  mkdirSync(exportDir, { recursive: true });
  const sourceGate = assertLatestRealtimeSourceGate(date, { skip: options.skipRealtimeGate === true });
  const recommendations = recommendFixtures(date);
  const audit = auditRecommendations(recommendations);
  const auditPath = writeRecommendationAudit(date, audit);
  const selfCheck = runPreExportSelfCheck(recommendations);
  // 全面审计总闸门(2026-05-30 用户要求"每道模块运行都设全面审计,最后推荐生成保证质量"):
  //   一次编排 模块结构/缺陷/能力 + 推荐内容 + 逐场自检 + 真实性 roll-up,任一硬 blocker 不出表。
  //   复用上面已算好的 audit/selfCheck,避免重复跑;模块审计(结构/缺陷/能力)在此随出表一并跑。
  const comprehensive = runComprehensiveAudit({ date, recommendations, precomputed: { recAudit: audit, selfCheck } });
  if (!comprehensive.ok) {
    throw new Error(`全面审计未通过(${comprehensive.blockers.length}项硬问题,已拦截出表)：${comprehensive.blockers.slice(0, 6).join("；")}${comprehensive.blockers.length > 6 ? " …" : ""}`);
  }
  const jingcai = sortByKickoff(recommendations.predictions.filter((prediction) => prediction.fixture.marketType !== "shengfucai"));
  const fourteen = recommendations.fourteen.selections;
  // 硬规则:无真实 14 场时,14 场 sheet 给诚实说明行,不把竞彩比赛冒充成 14 场。
  const fourteenRows = recommendations.fourteen.available === false || !fourteen.length
    ? [fourteenHeaders(), ["—", "", recommendations.fourteen.note ?? "今日无 14 场胜负彩,按硬规则不发 14 场。", ...new Array(7).fill("")]]
    : [fourteenHeaders(), ...fourteen.map(toFourteenRow)];
  const recapRows = recommendations.predictions.map(toLedgerRow);
  const ledger = updateLedger(date, recapRows);
  const dailyPath = join(exportDir, `神选-竞彩推荐-${date}.xlsx`);
  const internalPath = join(exportDir, `神选-内部核验-${date}.xlsx`);
  const masterPath = join(exportDir, "神选-复盘总表.xlsx");
  // 用户面向:极简两表(竞彩 + 14场),无 14 场则只一张竞彩。每行只胜负平/让胜负平/比分/半全场。
  const simpleFourteenRows = recommendations.fourteen.available === false || !fourteen.length
    ? null
    : [simpleFourteenHeaders(), ...fourteen.map(toSimpleFourteenRow)];
  writeXlsxWorkbook(dailyPath, [
    { name: "竞彩", rows: [simpleJingcaiHeaders(), ...jingcai.map(toSimpleJingcaiRow)] },
    ...(simpleFourteenRows ? [{ name: "14场", rows: simpleFourteenRows }] : [])
  ]);
  // 内部核验:原 13 张明细/审计/复盘/健康表全保留(不丢、供追溯),与极简表同次运行同源。
  writeXlsxWorkbook(internalPath, [
    { name: "全面审计", rows: comprehensiveAuditRows(comprehensive) },
    { name: "出表自检", rows: selfCheckRows(selfCheck) },
    { name: "神选·竞彩", rows: [jingcaiHeaders(), ...jingcai.map(toJingcaiRow)] },
    { name: "神选·多玩法", rows: multiPlayRows(recommendations.predictions) },
    { name: "神选·深度分析", rows: deepAnalysisRows(recommendations.predictions) },
    { name: "神选·14场", rows: fourteenRows },
    { name: "神选·任选9", rows: renxuan9Rows(recommendations.fourteen.available === false ? { ok: false, reason: recommendations.fourteen.note ?? "今日无 14 场胜负彩,任选9 不适用。" } : recommendations.fourteen.renxuan9) },
    { name: "赔率变化", rows: [oddsComparisonHeaders(), ...recommendations.predictions.map(toOddsComparisonRow)] },
    { name: "融合判断", rows: [judgmentHeaders(), ...recommendations.predictions.map(toJudgmentRow)] },
    { name: "多模态协作", rows: multimodalComparisonRows(recommendations.predictions) },
    { name: "大小球·阵容", rows: [totalGoalsLineupHeaders(), ...recommendations.predictions.map(toTotalGoalsLineupRow)] },
    { name: "复盘对比", rows: [recapHeaders(), ...recapRows.map(Object.values)] },
    { name: "模型健康", rows: modelHealthRows(sourceGate, audit) },
    { name: "数据缺失·未预测", rows: unpredictableRows(recommendations.unpredictable) }
  ]);
  writeXlsxWorkbook(masterPath, [{ name: "复盘总表", rows: [recapHeaders(), ...ledger.map(Object.values)] }]);
  return { date, dailyPath, internalPath, masterPath, recommendations, audit, auditPath, selfCheck, sourceGate, health: { ok: true }, ledgerRows: ledger.length };
}

// 2026-05-30 诚实披露:无真实先验被剔除的场(未捕获赔率且不在 DC 训练集),
//   如实列出+原因,不静默消失、更不用 seeded 假方向凑数。空则给一行说明。
function unpredictableRows(unpredictable = []) {
  const header = ["序号", "对阵", "玩法类型", "未预测原因"];
  if (!Array.isArray(unpredictable) || !unpredictable.length) {
    return [header, ["—", "（无）", "", "本期所有场次均有真实先验(赔率/DC),无剔除场。"]];
  }
  return [
    header,
    ...unpredictable.map((u) => [
      u.sequence ?? "—",
      `${u.homeTeam} vs ${u.awayTeam}`,
      u.marketType === "shengfucai" ? "14场胜负彩" : (u.marketType === "jingcai" ? "竞彩" : (u.marketType ?? "")),
      u.reason ?? "数据缺失·未预测"
    ])
  ];
}

function toJingcaiRow(prediction) {
  const fixture = prediction.fixture;
  // 世界杯单场:理由列前缀赛会级背景(双方出线/夺冠%);非世界杯/无超算数据→""(休眠)。
  const wcCtx = worldCupContextLine(fixture?.homeTeam, fixture?.awayTeam, fixture?.competition);
  const probs = prediction.probabilities ?? {};
  const upset = upsetRiskLabel(probs.home, probs.draw, probs.away);
  const probSummary = `主 ${pct(probs.home)} / 平 ${pct(probs.draw)} / 客 ${pct(probs.away)}`;
  const tier = bettingTier(prediction.probabilities, fixture?.competition);
  const ev = prediction.bankroll?.ev;
  const stake = prediction.bankroll?.stakeUnitsPer100;
  // 资金决策合到信心列尾巴:用户一眼看到信心+EV+下注分级 不用 3 列分开
  const confDetail = [confidenceLabel(prediction.confidence), tier]
    .concat(Number.isFinite(ev) ? [`EV ${(ev*100).toFixed(1)}%`] : [])
    .concat(Number.isFinite(stake) && stake > 0 ? [`${stake}/100`] : [])
    .concat(marketDivergenceTag(prediction) ? [marketDivergenceTag(prediction)] : [])
    .join(" · ");
  return [
    fixture.sequence,                                            // 1 序号
    competitionCategory(fixture?.competition),                   // 2 赛事类型
    `${fixture.homeTeam} vs ${fixture.awayTeam}`,                // 3 对阵
    fixture.kickoff?.slice(5, 16) ?? "",                         // 4 开赛(月-日 时:分)
    wldDisplayCell(prediction),                    // 5 胜平负(不让球);未开售/让0赔率缺失会标注,均势场标注双选含平
    jingcaiLetqiuText(prediction),                               // 6 让球胜平负(竞彩主玩法,真实让球赔率)
    buildScoreCandidates(prediction),                            // 7 比分(首选 + 备选,不再单一)
    buildHalfFullCandidates(prediction),                         // 8 半全场(首选 + 备选)
    probSummary,                                                 // 9 三概率(主/平/客 合一列)
    upset,                                                       // 10 爆冷
    marketFlowCell(prediction),                                  // 11 盘口资金流向(欧赔漂移+亚盘水位变化+独立解读)
    experienceCell(prediction),                                  // 12 历史经验(同情境:平局/大小球/赔率漂移)
    confDetail,                                                  // 13 信心+分级+EV+注码
    (wcCtx ? `🏆赛会 ${wcCtx} · ` : "") + enrichedRationale(prediction), // 14 选择理由(世界杯场前缀赛会出线/夺冠)
    prediction.provenance ?? "—"                                 // 15 来源(胜平负先验 provenance,可追溯)
  ];
}

// 盘口资金流向 / 数据变化(2026-05-31)—— 用户要"深度分析数据的变化,不要只全押市场热门"。
// 欧赔 开盘→当前 漂移(谁升温/降温)+ 亚盘水位 早→晚 变化(sharp money 方向)+ 独立解读。
// 这是模型给出"≠跟市场买热门"的真观点处:大热让球盘水位异动常预示"赢球不过盘"→ 影响让球/比分。
// 纯透明展示+提示,不替用户弃赛(遵 feedback_confidence_not_autosuppress)。
export function marketFlowCell(prediction) {
  const lines = [];
  // ① 欧赔开→现漂移
  const eo = prediction.marketSnapshot?.europeanOdds;
  if (eo?.initial && eo?.current) {
    const drift = europeanDrift(eo.initial, eo.current);
    lines.push(drift ? `欧赔:${drift}` : "欧赔:开盘→当前未动");
  }
  // ② 亚盘水位变化(真·sharp 信号)+ 独立解读
  const a = prediction.asianWaterAnalysis;
  if (a?.movement) {
    const sig = a.signal ? `[${asianSignalLabel(a.signal)}]` : "";
    lines.push(`亚盘(让${a.line}):${a.movement}${sig}`);
    if (a.implication) lines.push(a.implication.replace(/\*\*/g, ""));
    // 大热让球盘的独立观点:升水/反向警告 → 比分倾向小分差,而非跟着市场吃大分让球
    const indep = asianIndependentView(a, prediction.pick?.code);
    if (indep) lines.push(`独立观点:${indep}`);
  }
  return lines.length ? lines.join("\n") : "盘口无变化数据";
}

// 欧赔开→现漂移:哪一方赔率下降(=升温/资金进)、上升(=降温)。变化<3% 视为未动。
function europeanDrift(init, cur) {
  const seg = [];
  for (const [k, label] of [["home", "主"], ["draw", "平"], ["away", "客"]]) {
    const i = Number(init[k]), c = Number(cur[k]);
    if (!(i > 1 && c > 1)) continue;
    const pct = (c - i) / i;
    if (Math.abs(pct) < 0.03) continue;
    seg.push(`${label}${c < i ? "↓升温" : "↑降温"}${(Math.abs(pct) * 100).toFixed(0)}%`);
  }
  return seg.length ? seg.join("/") : null;
}

function asianSignalLabel(signal) {
  return {
    "warn-home": "警惕主队反向", "warn-away": "警惕客队反向",
    "danger-home": "主让球危险", "danger-away": "客让球危险",
    "favorite-strongly-backed": "热门强力支撑", "favorite-suspicious": "热门可疑",
    "slight-up": "轻度升水", "slight-down": "轻度降水", "neutral": "中性",
  }[signal] ?? signal;
}

// 把水位信号翻译成对让球/比分的独立可执行观点(不改 wld 锚,只提示玩法层)。
function asianIndependentView(a, wldCode) {
  const heavyFav = Math.abs(Number(a.line)) >= 1.5; // 大热让 1.5 球以上
  if ((a.signal === "warn-home" || a.signal === "warn-away") && heavyFav) {
    return `大热让${a.line}但资金不敢跟 → 警惕赢球不过盘,比分倾向小分差(1-0/2-1),让球盘谨慎`;
  }
  if (a.signal === "danger-home" || a.signal === "danger-away") {
    return `受让方被大量加注 → 让球方危险,可考虑受让/平本身,别盲跟让球`;
  }
  return null;
}

// 市场背离标签(2026-05-31):clv-confidence-gate 接生产后的展示。实证=逆市押独门是陷阱。
// 同向不刷屏(只略标✓);次热/逆市给醒目降档建议。纯提示,买不买由用户定(不替弃赛)。
function marketDivergenceTag(prediction) {
  const md = prediction.marketDivergence;
  if (!md || md.fightLevel === "unknown") return "";
  if (md.fightLevel === "同向") return "✓市场同向";
  const gc = Number.isFinite(md.gatedConfidence) ? `→建议信心${md.gatedConfidence}` : "";
  if (md.fightLevel === "次热") return `⚠押市场次热·略降档${gc}`;
  return `⛔逆市(市场看${outcomeCodeToChinese(marketPickCode(md.marketPick))})·建议降档${gc}`;
}

function marketPickCode(pick) {
  return pick === "home" ? "3" : pick === "draw" ? "1" : pick === "away" ? "0" : "";
}

// 历史经验列(2026-05-30/31):把 experienceContext 学到的"同联赛同情境真实结果"读数
// 汇总成一格 —— 平局风险 / 大小球倾向 / 赔率开→收漂移兑现。纯透明展示,不改 wld 锚、不替用户弃赛。
export function experienceCell(prediction) {
  const ec = prediction.experienceContext;
  if (!ec) return "—";
  const lines = [];
  if (ec.drawAlert) lines.push(ec.drawAlert);
  if (ec.overUnderHint) lines.push(ec.overUnderHint);
  if (ec.driftHint) lines.push(ec.driftHint);
  if (!lines.length) {
    // 无具体提示时,至少给样本量+来源让用户知道经验依据
    if (Number.isFinite(ec.n) && ec.source) return `历史${ec.n}场(${ec.source})`;
    return "—";
  }
  return lines.join("\n");
}

// 胜平负列(2026-06-01「永远没平」修复):均势场(平局进前二且≥26%)标注双选含平,提示该兼顾平局。
//   主推 prediction.pick.code **不变**(复盘仍按 primary 结算,口径一致),这里只是展示层的双选建议。
//   悬殊场/主推明显场不加,避免滥推平。
// 胜平负显示闸(2026-06-04):区分三种"让0胜平负不可直接投/不可靠"的情形,避免把脏数据当干净推荐。
//  ① sfcSold===false:竞彩明确只让球,让0未开售 → ⛔。
//  ② sfcSold!==true 且存在非0官方让球线:让0胜平负赔率缺失/未抓全(伊拉克等悬殊盘只剩让球档),
//     此时 wld 概率是用让球赔率反推的,直胜数字不可靠 → 标注"仅参考",但不抑制玩法(守"信心不替用户弃赛")。
//  ③ 正常 → 原 wldCellWithDraw。
function wldDisplayCell(prediction) {
  const lq = prediction.jingcaiLetqiu;
  if (lq && lq.sfcSold === false) return "⛔ 未开售(本场只让球)";
  const line = Number(prediction.handicapPick?.line);
  if (lq && lq.sfcSold !== true && Number.isFinite(line) && line !== 0) {
    return `⚠️ 让0赔率缺失(本场让${line},直胜仅参考):${wldCellWithDraw(prediction)}`;
  }
  return wldCellWithDraw(prediction);
}

function wldCellWithDraw(prediction) {
  const code = prediction.pick?.code;
  const base = outcomeCodeToChinese(code);
  const p = prediction.probabilities ?? {};
  const draw = Number(p.draw);
  const dc = prediction.doubleChance;
  // 双选升一等公民(2026-06-05):中低档(市场热门<0.65)单选命中物理偏低 → 主推双选(回测背书),
  //   单选降为参考;强档(≥0.65)仍单关。只升玩法建议、不改 pick.code(复盘 1X2 仍按 primary 结算)。
  if (dc?.recommended && dc.pick && dc.shortCode) {
    const dHit = Number.isFinite(dc.backtestHit) ? `回测~${Math.round(dc.backtestHit * 100)}%` : "";
    return `双选 ${dc.pick}(${dc.shortCode}·${dHit}) ⟨单选${base}仅参考·命中~${Math.round((dc.singleBacktestHit ?? 0) * 100)}%⟩`;
  }
  if (!Number.isFinite(draw) || code === "1") return base; // 主推已是平、或无概率
  const arr = [["3", p.home], ["1", p.draw], ["0", p.away]]
    .filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  const drawRank = arr.findIndex(([c]) => c === "1");
  // 平局须进前二(仅次于主推)且 ≥26% → 均势闷局,提示双选含平。
  if (draw >= 0.26 && drawRank === 1) {
    return `${base} / 平(均势·平${Math.round(draw * 100)}%·可双选)`;
  }
  return base;
}

// 比分候选(2026-06-02 二次修正):头条 = 与胜负平方向一致的最可能比分(自洽:主胜→1-0/2-1,
//   平局pick→1-1/0-0,客胜→0-1/1-2),后接同方向备选,末尾小字披露"均势最高 X-X"(全矩阵众数)。
//   背景:首版(同日)曾把头条改成全矩阵众数以求"敢报平",但低进球均势场众数恒为 1-1,导致整版
//   比分全 1-1 且与"主胜/半全场主胜-主胜"自相矛盾(用户反馈"太降智")。改回方向一致作头条消除矛盾,
//   仍保留 1-1 披露(诚实不藏);平局/均势 pick(drawLean)时方向一致比分本就是平局 → 仍敢报平。
function buildScoreCandidates(prediction) {
  const wldCode = prediction.pick?.code;
  const sp = prediction.scorePicks ?? {};
  const dcTops = prediction.dixonColes?.topScores ?? [];
  const matchesWld = (s) => {
    const m = String(s ?? "").match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return false;
    const h = Number(m[1]), a = Number(m[2]);
    if (wldCode === "3") return h > a;
    if (wldCode === "1") return h === a;
    if (wldCode === "0") return h < a;
    return false;
  };
  const pct = (v) => (Number.isFinite(v) ? ` (${Math.round(v * 100)}%)` : "");
  const probOf = new Map((sp.distribution ?? []).map((d) => [String(d.score).trim(), d.probability]));
  const setProb = (s, v) => { const k = String(s ?? "").trim(); if (k && Number.isFinite(v)) probOf.set(k, v); };
  setProb(sp.primary, sp.primaryProbability);
  setProb(sp.secondary, sp.secondaryProbability);
  setProb(sp.wldConsistent, sp.wldConsistentProbability);
  setProb(sp.wldConsistentSecondary, sp.wldConsistentSecondaryProbability);

  // ① 头条 = 与胜负平方向一致的最可能比分(2026-06-02 二次修正:头条不再用全矩阵众数,
  //    避免均势低分场头条恒为平局 1-1 而与"主胜/客胜"pick + 半全场方向自相矛盾、整版雷同)。
  const wldOrdered = [sp.primary, sp.wldConsistent, sp.secondary, sp.wldConsistentSecondary]
    .concat((sp.distribution ?? []).map((d) => d.score))
    .concat(dcTops.map((t) => t?.score));
  const wldCands = [];
  const seen = new Set();
  for (const s of wldOrdered) {
    const clean = String(s ?? "").trim();
    if (!clean || seen.has(clean) || !matchesWld(clean)) continue;
    seen.add(clean);
    wldCands.push(`${clean}${pct(probOf.get(clean))}`);
    if (wldCands.length >= 3) break;
  }
  if (!wldCands.length) {
    // 极端兜底:方向一致比分取不到(几乎不会发生)→ 退回众数,至少有真实输出
    const gm = String(sp.globalMode ?? sp.primary ?? "").trim();
    return gm ? `${gm}${pct(probOf.get(gm))}` : "—";
  }
  // ② 均势最可能单一比分(全矩阵众数,可含平局)若与头条不同 → 小字披露(诚实不藏)
  const mode = String(sp.globalMode ?? "").trim();
  const headScore = String(wldCands[0]).split(" ")[0];
  const modeNote = (mode && mode !== headScore && !seen.has(mode))
    ? ` · 均势最高 ${mode}${pct(sp.globalModeProbability ?? probOf.get(mode))}` : "";
  const head = wldCands[0];
  const rest = wldCands.slice(1, 3);
  return (rest.length ? `${head} | 备 ${rest.join(", ")}` : head) + modeNote;
}

// 半全场候选:首选(wld 锚)+ 备选,备选 first-half 必须跟首选不同
// 避免 "主胜-主胜 备 主胜-主胜" 这种重复
function buildHalfFullCandidates(prediction) {
  const hp = prediction.halfFullPicks ?? {};
  const primary = hp.primary;
  if (!primary) return "—";
  const pct = (v) => (Number.isFinite(v) ? ` (${Math.round(v * 100)}%)` : "");
  // 2026-05-31 用户要"多给几个半全场":从真实联合分布里取**终场方向 = wld 锚**的 top 路径(不只 1 备)。
  const wld = prediction.pick?.code; // 3主/1平/0客
  const ftLabel = wld === "3" ? "主胜" : wld === "1" ? "平局" : wld === "0" ? "客胜" : null;
  const dist = Array.isArray(hp.distribution) ? hp.distribution.slice() : [];
  if (ftLabel && dist.length) {
    const consistent = dist
      .filter((d) => String(d.halfFull).split("-")[1] === ftLabel) // 终场半场=wld 方向
      .sort((a, b) => b.probability - a.probability);
    const picks = [];
    const seen = new Set();
    for (const d of [{ halfFull: primary, probability: hp.primaryProbability }, ...consistent]) {
      const hf = String(d.halfFull);
      if (!hf || seen.has(hf) || hf.split("-")[1] !== ftLabel) continue;
      seen.add(hf);
      picks.push(`${hf}${pct(d.probability)}`);
      if (picks.length >= 3) break;
    }
    if (picks.length) {
      const base = picks.length === 1 ? picks[0] : `${picks[0]} | 备 ${picks.slice(1).join(", ")}`;
      // "最可能走势"(全9类真实众数,可含平局-主胜/平局-平局)若与首选不同,附上让用户看到真实走势
      const tml = hp.trueMostLikely;
      if (tml?.halfFull && tml.halfFull !== primary) return `${base} · 最可能走势 ${tml.halfFull}${pct(tml.probability)}`;
      return base;
    }
  }
  const main = `${primary}${pct(hp.primaryProbability)}`;
  if (hp.primaryAlt?.halfFull) return `${main} | 另 ${hp.primaryAlt.halfFull}${pct(hp.primaryAlt.probability)}`;
  return main;
}

// ============================================================================
// 极简两表(2026-06-06 用户硬规则 feedback_jingcai_simple_table):
//   日报对用户只出「竞彩」+「14场」两张表(无14场则一张),每行只看
//   胜负平 / 让胜负平 / 比分 / 半全场(再加序/开赛/对阵/信心),一眼看懂、四者同向。
//   四列全部从 pick.code(wld)一条主线派生,与 validatePredictionConsistency 同源 → 永不矛盾:
//     胜负平   = wldDisplayCell(pick.code + ⛔/⚠️ 真实性闸 + 均势双选)
//     让胜负平 = coherentHandicapView(头条恒与 wld 同向,没把握给"双选+走盘",绝不反向)
//     比分     = scorePicks.wldConsistent(与 wld 方向一致的最可能比分)
//     半全场   = halfFullPicks.primary(终场=wld 方向)
//   明细/审计/复盘/健康等 13 张表移到「神选-内部核验-{date}.xlsx」,不丢、供核验。
// ============================================================================
function simpleJingcaiHeaders() {
  return ["开赛", "对阵", "胜负平", "让胜负平", "比分", "半全场", "近5场", "H2H交锋", "实力·主客场画像", "信心"];
}

// 实力画像单元(2026-06-06):主队主场实力 vs 客队客场实力 + 市场存疑标。无画像="未取到"(标缺)。
function dcProfile(prediction) {
  const tp = prediction.teamProfile;
  if (!tp || (!tp.home && !tp.away)) return "未取到";
  const h = tp.home, a = tp.away;
  const parts = [];
  // 永久铁律:ppg=0(薄样本/全负噪声,多见国家队混合历史)=不可信→标缺不摆 0 脏数据。
  if (h && h.ppg > 0) parts.push(`主综合${h.ppg}(主场${h.homePpg ?? "—"})`);
  if (a && a.ppg > 0) parts.push(`客综合${a.ppg}(客场${a.awayPpg ?? "—"})`);
  if (!parts.length) return "未取到";
  let s = parts.join(" / ");
  if (tp.edge?.marketWatch) s += `\n⚠市场存疑:${tp.edge.note}`;
  return s || "未取到";
}

// 深度情景单元(2026-06-06):优先用 ESPN 真实开赛时间;近5状态/H2H/近期交锋来自 deepContext。
//   永久铁律:无该场 deepContext=标"未取到",不臆造。本层只展示不改 wld 概率。
function dcKickoff(prediction) {
  const dc = prediction.deepContext;
  if (dc?.kickoffBeijing) return dc.kickoffBeijing;          // 真实时间(北京)
  const ko = prediction.fixture?.kickoff;
  return ko && /\d{2}:\d{2}/.test(ko) ? ko.slice(5, 16) : (ko?.slice(5, 10) ?? "");
}
function dcForm(prediction) {
  const dc = prediction.deepContext;
  if (!dc) return "未取到";
  const h = dc.home?.form, a = dc.away?.form;
  if (!h && !a) return "未取到";
  return `主:${h ?? "—"} 客:${a ?? "—"}`;
}
function dcH2h(prediction) {
  const dc = prediction.deepContext;
  if (!dc) return "未取到";
  const parts = [];
  if (dc.h2h) parts.push(dc.h2h.replace(/\d{4}-/g, ""));     // 紧凑:去年份前缀
  if (dc.recentMeeting?.score) parts.push(`⚠近期交锋${dc.recentMeeting.score}`);
  return parts.length ? parts.join(" · ") : "无记录";
}

// 让胜负平极简格(2026-06-06 二次修正·方向统一):铁律让球方向跟随胜负平(feedback_wld_anchor_inference),
//   不独立重排。主选/次选 = 胜负平主选/次选方向直接映射让球标签(同序),保证四市场完美同向。不带概率。
export function simpleHandicapCell(prediction) {
  const v = coherentHandicapView(prediction);
  if (!v) return "—";
  const line = v.lineStr ? `（${v.lineStr}）` : "";
  const lbl = (c) => (c === "3" ? "让球主胜" : c === "0" ? "让球客胜" : "走盘");
  const p = prediction.probabilities ?? {};
  const order = [["3", p.home], ["1", p.draw], ["0", p.away]]
    .filter(([, x]) => Number.isFinite(x)).sort((a, b) => b[1] - a[1]);
  if (order.length >= 2) return `主选 ${lbl(order[0][0])} / 次选 ${lbl(order[1][0])}${line}`;
  return `${String(v.headline ?? "").replace(/\s*\d+%.*$/, "").trim()}${line}`;
}

// 比分极简格(2026-06-06 二次修正·方向统一):用户指出比分/半全场与胜负平方向打架不知信哪个→
//   恢复"四市场同向":比分主选=与胜负平主选同向的最可能比分(真市场盘 scoreFromMarket 出),
//   次选=与胜负平次选同向的比分。平局由"胜负平本身敢选平/双选"体现,不让比分擅自跳平。不带概率。
export function simpleScoreCell(prediction) {
  const sp = prediction.scorePicks ?? {};
  const main = sp.wldConsistent ?? sp.primary;
  if (!main) return "—";
  const sub = sp.wldConsistentSecondary ?? sp.secondary;
  return sub && sub !== main ? `主选 ${main} / 次选 ${sub}` : `主选 ${main}`;
}

// 半全场极简格(方向统一):主选=与胜负平主选同向的半全场路径(真市场盘),次选=次选同向。平局由胜负平体现。
export function simpleHalfFullCell(prediction) {
  const hp = prediction.halfFullPicks ?? {};
  if (!hp.primary) return "—";
  const sub = hp.secondary;
  return sub && sub !== hp.primary ? `主选 ${hp.primary} / 次选 ${sub}` : `主选 ${hp.primary}`;
}

// 信心极简格:信心档 + 下注分级(含弱联赛降级⚠️),不再堆 EV/注码。
function simpleConfidenceCell(prediction) {
  const tier = bettingTier(prediction.probabilities, prediction.fixture?.competition);
  return `${confidenceLabel(prediction.confidence)} · ${tier}`;
}

// 胜负平极简格:只给方向(主胜/平局/客胜),均势→"主胜/平 双选",中低档→"双选 主/客";
//   保留 ⛔未开售 / ⚠️直胜仅参考 两个真实性闸(脏数据不冒充干净推荐),去掉回测/单选命中率尾巴
//   (那些明细在内部核验表的完整竞彩 sheet 里,此处求一眼看懂)。方向恒 = pick.code,与其余三列同源。
// 胜负平极简格(2026-06-06 用户要主选+副选,同比分/半全场):取三概率前二=主选/副选(带%),
//   保留⛔未开售/⚠️直胜仅参考真实性闸;模型主推双选时附"(主推双选)"提示。方向与比分/半全场同源(argmax)。
export function simpleWldCell(prediction) {
  const lq = prediction.jingcaiLetqiu;
  if (lq && lq.sfcSold === false) return "⛔ 未开售(只让球)";
  const line = Number(prediction.handicapPick?.line);
  const flag = (lq && lq.sfcSold !== true && Number.isFinite(line) && line !== 0) ? "⚠️直胜仅参考 " : "";
  const p = prediction.probabilities ?? {};
  const arr = [["3", p.home], ["1", p.draw], ["0", p.away]]
    .filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  if (arr.length < 2) return `${flag}${outcomeCodeToChinese(prediction.pick?.code)}`;
  // 主选+次选,不带概率(2026-06-06 用户)。平局若是前二则自然显示;否则在比分(1-1)/半全场(平-平)里体现。
  return `${flag}主选 ${outcomeCodeToChinese(arr[0][0])} / 次选 ${outcomeCodeToChinese(arr[1][0])}`;
}

function toSimpleJingcaiRow(prediction) {
  const f = prediction.fixture;
  return [
    dcKickoff(prediction),                   // 开赛(优先 ESPN 真实北京时间)
    `${f.homeTeam} vs ${f.awayTeam}`,        // 对阵
    simpleWldCell(prediction),               // 胜负平(方向+双选,含⛔/⚠️真实性闸)
    simpleHandicapCell(prediction),          // 让胜负平(恒与胜负平同向)
    simpleScoreCell(prediction),             // 比分(方向一致)
    simpleHalfFullCell(prediction),          // 半全场(终场=胜负平方向)
    dcForm(prediction),                      // 近5场状态(ESPN真实,无=未取到)
    dcH2h(prediction),                       // H2H交锋 + 近期交锋线索
    dcProfile(prediction),                   // 实力·主客场画像 + 市场存疑标
    simpleConfidenceCell(prediction)         // 信心 · 分级
  ];
}

// 按真实开赛时间排序(有 deepContext 时间的在前升序,缺时间的按序号兜底排后)。
function sortByKickoff(predictions) {
  return [...predictions].sort((x, y) => {
    const tx = x.deepContext?.kickoffIso, ty = y.deepContext?.kickoffIso;
    if (tx && ty) return new Date(tx) - new Date(ty);
    if (tx) return -1;
    if (ty) return 1;
    return (x.fixture?.sequence ?? 0) - (y.fixture?.sequence ?? 0);
  });
}

export function simpleFourteenHeaders() {
  return ["序", "赛事", "比赛", "胜负平", "覆盖", "信心"];
}

export function toSimpleFourteenRow(selection) {
  return [
    selection.index,
    selection.competitionType ?? "—",
    selection.match,
    selection.single,                        // 单式胜负平方向
    selection.compound,                      // 覆盖(单/双/全)
    confidenceLabel(selection.confidence)
  ];
}

// 爆冷指数:模型不看好的弱势一方仍占 ≥22% 时,14 场/竞彩历史上常爆冷于此
function upsetRiskLabel(homeProb, drawProb, awayProb) {
  const weaker = Math.min(Number(homeProb ?? 0), Number(awayProb ?? 0));
  const draw = Number(drawProb ?? 0);
  if (weaker >= 0.25) return "⚠ 高(弱势 ≥25%)";
  if (weaker >= 0.22) return "🟡 中(弱势 ≥22%)";
  if (draw >= 0.30) return "🟡 平局可期(≥30%)";
  if (weaker >= 0.15) return "标准";
  return "公认 favorite";
}

// 让球胜平负(竞彩主玩法):用真实让球赔率去vig的隐含概率 + 方向 + 让球线。深盘场只开此盘。
function jingcaiLetqiuText(prediction) {
  // 让球一致化(2026-06-05):头条永远以 wld 为锚、不与主推冲突;没把握给双选+谨慎(coherentHandicapView)。
  const v = coherentHandicapView(prediction);
  if (!v) return "—";
  return `[${v.lineStr}] ${v.headline}${v.detail ? ` · ${v.detail}` : ""}`;
}

// 让球推荐方向:展示"模型从比分锚点派生"的让球方向,跟胜平负/比分一致
function handicapRecommendText(prediction) {
  const h = prediction.handicapPick;
  if (!h) return "—";
  const lineStr = h.line === 0 ? "平盘" : (h.line > 0 ? `+${h.line}` : `${h.line}`);
  const cover = Number.isFinite(h.coverProbability) ? ` 覆盖${pct(h.coverProbability)}` : "";
  // Skellam 独立交叉校验(2026-05-30):矩阵与 Skellam 让球分歧大时附「低信心」提示,
  // 让用户自己判断下不下——只提示、不抑制玩法(用户硬规则)。
  const sk = h.skellamCheck && !h.skellamCheck.agree ? ` ｜${h.skellamCheck.note}` : "";
  // 让球玩法最优方向(DC-τ argmax,leak-safe 回测 +4.37pp 覆盖命中 vs 跟 wld 主推方向):
  //   方向(头条)仍锚 wld(用户硬规则 2026-05-29:玩让球买的就是主推方向、不纠结)。
  //   但当"让球这门独立玩法"的最优方向与 wld 不一致时,把它标注出来供用户自己选——不替弃赛、不改头条。
  //   口径与 2026-06-02"比分解锁出 wld、改真实众数、wldConsistent 另存"一致:头条守一致,边上给最优。
  const hw = h.handicapWld;
  const optimal = (hw && hw.pickCode && h.directionCode && hw.pickCode !== h.directionCode)
    ? ` ｜🎯让球玩法最优: ${hw.pick} ${pct(hw.probability)}(${hw.source === "market-asian-water" ? "亚盘水位" : "DC-τ"},回测+4.4pp,与主推不同向)`
    : "";
  return `让 ${lineStr} → ${h.direction}${cover}${sk}${optimal}`;
}

// 信心从裸数字变成"等级(数字)"对用户更友好
function confidenceLabel(conf) {
  const n = Number(conf);
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  if (n >= 40) return `🟢 较高 (${rounded})`;
  if (n >= 25) return `🟡 中等 (${rounded})`;
  if (n >= 15) return `🟠 偏低 (${rounded})`;
  return `🔴 低 (${rounded})`;
}

// 理由从纯模板变成"模板 + evidence 支撑因素 + 信号 dormant 风险"
function enrichedRationale(prediction) {
  const base = prediction.rationale ?? "";
  const fusion = prediction.probabilityAdjustment?.fusion;
  if (!fusion?.applied) return base;
  const fired = (fusion.evidence ?? []).filter((e) => e?.lr || e?.ratio);
  if (!fired.length) return base;
  const top = fired.slice(0, 3).map((e) => e.detail ? `${e.name}(${e.detail})` : e.name).join("、");
  return `${base}；融合信号: ${top}`;
}

// 下注分级:按首选(top-prob)分桶,阈值依据 recommend:coverage 曲线
// (≥65%→历史命中~73%,50-65%→~64-67%,<50%→低于全推基线 54%)。
// 仅是「帮你挑高把握场」的过滤,不改变模型预测本身。
// 联赛可信度修正:若该联赛回测可靠且命中明显偏弱(如阿甲/墨超~37%),自动降一档并加⚠️,
// 避免🟢在弱联赛误导重注。联赛不在 profile / 样本不足 → 不降级(无数据不臆断)。
export function bettingTier(probabilities, league = null) {
  const top = Math.max(probabilities?.home ?? 0, probabilities?.draw ?? 0, probabilities?.away ?? 0);
  let level = top >= 0.65 ? 2 : top >= 0.50 ? 1 : 0;
  const labels = ["⚪ 慎选/观望", "🟡 可选", "🟢 建议下注"];
  if (league) {
    const prof = loadLeagueReliability();
    const lg = prof?.leagues?.[league];
    if (lg?.reliable && Number.isFinite(lg.accuracy) && lg.accuracy < (prof.weakThreshold ?? 0.42) && level > 0) {
      return `${labels[level - 1]} ⚠️弱联赛(${league}回测命中${Math.round(lg.accuracy * 100)}%)`;
    }
  }
  return labels[level];
}

function toFourteenRow(selection) {
  const p = selection.probabilities ?? {};
  const probSummary = `主 ${p.home ?? "—"} / 平 ${p.draw ?? "—"} / 客 ${p.away ?? "—"}`;
  return [
    selection.index,
    selection.competitionType ?? "—",
    selection.match,
    selection.single,
    selection.compound,
    selection.type,
    probSummary,
    selection.upsetRisk ?? "—",
    confidenceLabel(selection.confidence),
    selection.reason
  ];
}

function toOddsComparisonRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  const europeanInitial = snapshot?.europeanOdds?.initial;
  const europeanCurrent = snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final;
  const asianInitial = snapshot?.asianHandicap?.initial;
  const asianCurrent = snapshot?.asianHandicap?.current ?? snapshot?.asianHandicap?.final;
  const handicapInitial = snapshot?.handicapOdds?.initial;
  const handicapCurrent = snapshot?.handicapOdds?.current ?? snapshot?.handicapOdds?.final;
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    snapshot?.collectedAt ?? "",
    snapshot ? "已接入实时赔率" : "缺少实时赔率",
    numberOrBlank(europeanInitial?.home),
    numberOrBlank(europeanInitial?.draw),
    numberOrBlank(europeanInitial?.away),
    numberOrBlank(europeanCurrent?.home),
    numberOrBlank(europeanCurrent?.draw),
    numberOrBlank(europeanCurrent?.away),
    oddsDelta(europeanCurrent?.home, europeanInitial?.home),
    oddsDelta(europeanCurrent?.draw, europeanInitial?.draw),
    oddsDelta(europeanCurrent?.away, europeanInitial?.away),
    numberOrBlank(asianInitial?.line),
    numberOrBlank(asianInitial?.homeWater),
    numberOrBlank(asianInitial?.awayWater),
    numberOrBlank(asianCurrent?.line),
    numberOrBlank(asianCurrent?.homeWater),
    numberOrBlank(asianCurrent?.awayWater),
    oddsDelta(asianCurrent?.line, asianInitial?.line),
    oddsDelta(asianCurrent?.homeWater, asianInitial?.homeWater),
    oddsDelta(asianCurrent?.awayWater, asianInitial?.awayWater),
    numberOrBlank(handicapInitial?.home),
    numberOrBlank(handicapInitial?.draw),
    numberOrBlank(handicapInitial?.away),
    numberOrBlank(handicapCurrent?.home),
    numberOrBlank(handicapCurrent?.draw),
    numberOrBlank(handicapCurrent?.away),
    oddsDelta(handicapCurrent?.home, handicapInitial?.home),
    oddsDelta(handicapCurrent?.draw, handicapInitial?.draw),
    oddsDelta(handicapCurrent?.away, handicapInitial?.away),
    marketOddsText(snapshot?.scoreOdds),
    marketOddsText(snapshot?.halfFullOdds),
    snapshot?.source ?? "",
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.scorePicks.primary,
    prediction.scorePicks.secondary,
    prediction.halfFullPicks.primary,
    prediction.halfFullPicks.secondary,
    prediction.risk,
    prediction.confidence,
    prediction.rationale
  ];
}

function toTotalGoalsLineupRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  const totalMarket = totalGoalsMarket(snapshot);
  const totalInitial = totalMarket?.initial;
  const totalCurrent = totalMarket?.current ?? totalMarket?.final;
  const model = modelTotalGoals(prediction);
  const fixtureData = prediction.advancedFeatures?.external?.fixtureData ?? {};
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    totalMarket ? "已接入大小球盘口" : "未抓到大小球盘口，使用模型派生",
    numberOrBlank(totalInitial?.line),
    numberOrBlank(totalInitial?.overWater ?? totalInitial?.over ?? totalInitial?.bigWater ?? totalInitial?.big),
    numberOrBlank(totalInitial?.underWater ?? totalInitial?.under ?? totalInitial?.smallWater ?? totalInitial?.small),
    numberOrBlank(totalCurrent?.line),
    numberOrBlank(totalCurrent?.overWater ?? totalCurrent?.over ?? totalCurrent?.bigWater ?? totalCurrent?.big),
    numberOrBlank(totalCurrent?.underWater ?? totalCurrent?.under ?? totalCurrent?.smallWater ?? totalCurrent?.small),
    oddsDelta(totalCurrent?.line, totalInitial?.line),
    oddsDelta(totalCurrent?.overWater ?? totalCurrent?.over ?? totalCurrent?.bigWater ?? totalCurrent?.big, totalInitial?.overWater ?? totalInitial?.over ?? totalInitial?.bigWater ?? totalInitial?.big),
    oddsDelta(totalCurrent?.underWater ?? totalCurrent?.under ?? totalCurrent?.smallWater ?? totalCurrent?.small, totalInitial?.underWater ?? totalInitial?.under ?? totalInitial?.smallWater ?? totalInitial?.small),
    model.expectedGoals,
    pct(model.over25),
    pct(model.under25),
    pct(model.over35),
    model.bias,
    teamStyle("home", prediction),
    teamStyle("away", prediction),
    formText(fixtureData.form?.home),
    formText(fixtureData.form?.away),
    eloText(fixtureData.elo?.home),
    eloText(fixtureData.elo?.away),
    injuryText(fixtureData.injuries),
    projectedLineupText(fixtureData.lineups, fixture),
    actualLineupText(fixtureData.lineups, fixture),
    lineupSourceText(fixtureData.lineups),
    prediction.rationale
  ];
}

function toJudgmentRow(prediction) {
  const fixture = prediction.fixture;
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.scorePicks.primary,
    prediction.halfFullPicks.primary,
    prediction.confidence,
    prediction.risk,
    ...judgmentFactorRow(prediction)
  ];
}

// 取某选项(pickCode 3=主/1=平/0=客)在一组欧赔里的小数赔率。
function pickDecimalOdds(europeanOdds, pickCode) {
  const key = pickCode === "3" ? "home" : pickCode === "1" ? "draw" : pickCode === "0" ? "away" : null;
  if (!key) return null;
  const v = Number(europeanOdds?.[key]);
  return Number.isFinite(v) && v > 1 ? v : null;
}

function toLedgerRow(prediction) {
  const fixture = prediction.fixture;
  const actual = fixture.result ? resultCode(fixture.result) : "";
  // CLV(分析师建议的真 KPI):记录下注时该选项的小数赔率 + 开盘价 + 捕获时刻,
  // 结算时与收盘快照对比算 CLV。current 是我们生成推荐时的"下注价"。
  const snap = prediction.marketSnapshot;
  const euBet = snap?.europeanOdds?.current ?? snap?.europeanOdds?.final;
  const euOpen = snap?.europeanOdds?.initial;
  return {
    date: fixture.date,
    sequence: fixture.sequence,
    competition: fixture.competition,
    match: `${fixture.homeTeam} 对 ${fixture.awayTeam}`,
    primary: outcomeCodeToChinese(prediction.pick.code),
    secondary: outcomeCodeToChinese(prediction.secondaryPick.code),
    scorePrimary: prediction.scorePicks.primary,
    scoreSecondary: prediction.scorePicks.secondary,
    // 全矩阵真实众数(可含平局,头条已改为方向一致比分)——复盘覆盖口径纳入,保住高频比分命中率不回退。
    scoreMode: prediction.scorePicks.globalMode ?? null,
    // 来源标记(2026-06-06 闭环纪律):记下比分/半全场用的是真市场盘(market)还是DC估算→
    //   复盘可按来源分桶对比命中率,客观验证"用真盘是否真提命中"。见 feedback_fetch_all_then_audit。
    scoreSource: prediction.scorePicks.source ?? null,
    halfFullSource: prediction.halfFullPicks.source ?? null,
    halfFullPrimary: prediction.halfFullPicks.primary,
    halfFullSecondary: prediction.halfFullPicks.secondary,
    // 让球胜平负(2026-05-31 复盘需求):记下让球玩法预测 + 让球线,结算时按比分算实际让球结果对比。
    handicapLine: prediction.handicapPick?.line ?? "",
    handicapWld: prediction.handicapPick?.handicapWld?.pick ?? "",
    handicapWldCode: prediction.handicapPick?.handicapWld?.pickCode ?? "",
    probabilityHome: prediction.probabilities.home,
    probabilityDraw: prediction.probabilities.draw,
    probabilityAway: prediction.probabilities.away,
    baseProbabilityHome: prediction.baseProbabilities?.home ?? "",
    baseProbabilityDraw: prediction.baseProbabilities?.draw ?? "",
    baseProbabilityAway: prediction.baseProbabilities?.away ?? "",
    monteCarloHome: prediction.simulation?.outcomeProbabilities?.home ?? "",
    monteCarloDraw: prediction.simulation?.outcomeProbabilities?.draw ?? "",
    monteCarloAway: prediction.simulation?.outcomeProbabilities?.away ?? "",
    monteCarloTopScores: prediction.simulation?.topScores?.slice(0, 3).map((item) => `${item.score}:${pct(item.probability)}`).join(" / ") ?? "",
    risk: prediction.risk,
    confidence: prediction.confidence,
    tier: bettingTier(prediction.probabilities, prediction.fixture?.competition),
    bankrollDecision: prediction.bankroll?.decision ?? "",
    ev: prediction.bankroll?.ev ?? null,
    stakeUnitsPer100: prediction.bankroll?.stakeUnitsPer100 ?? null,
    // D 档接入(2026-05-28):ensembleView 概率落盘,backtest 算其 RPS 跟主路径对比
    ensembleHome: prediction.ensembleView?.probabilities?.home ?? "",
    ensembleDraw: prediction.ensembleView?.probabilities?.draw ?? "",
    ensembleAway: prediction.ensembleView?.probabilities?.away ?? "",
    ensembleMethods: prediction.ensembleView?.methodCount ?? 0,
    // 信号去偏学习闭环原料(2026-06-03 修):回写本场实际触发的信号 key,
    // 供 signal-weight-tuner.signalPresent 判断,否则 signalWeights 永远 0 样本空转。
    adjustmentSignals: (prediction.probabilityAdjustment?.signals ?? []).map((s) => s?.key).filter(Boolean),
    // 双选(双重机会)落档(2026-06-05):codes=覆盖的两个结果,结算时实际落其内即命中;
    //   recommended=本场是否主推双选(市场热门<0.65),供复盘单独统计"双选主推命中率"。
    doubleChanceCodes: prediction.doubleChance?.codes ?? null,
    doubleChanceShort: prediction.doubleChance?.shortCode ?? "",
    doubleChanceRecommended: prediction.doubleChance?.recommended === true,
    reason: prediction.rationale,
    // CLV 原料(结算时用):primaryOdds=下注价,primaryOpeningOdds=开盘价,betCapturedAt=捕获时刻
    primaryOdds: pickDecimalOdds(euBet, prediction.pick.code),
    primaryOpeningOdds: pickDecimalOdds(euOpen, prediction.pick.code),
    betCapturedAt: snap?.collectedAt ?? null,
    actual: outcomeCodeToChinese(actual),
    actualScore: fixture.result ? `${fixture.result.home}-${fixture.result.away}` : "",
    hit: actual ? actual === prediction.pick.code : null
  };
}

function updateLedger(date, rows) {
  const existing = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")).filter((row) => row.date !== date) : [];
  const next = [...existing, ...rows];
  writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

// 神选·多玩法(2026-05-31 通宵进化):每场一站式覆盖竞彩各玩法推荐
//   (让球胜平负 + 大小球2.5 + 单双 + 半全场 + 比分),满足"竞彩多玩法/要全"。
function multiPlayRows(predictions) {
  const rows = [
    ["⚡ 神选 · 竞彩多玩法(每场全玩法)", "", "", "", "", "", "", ""],
    ["对阵", "胜平负", "让球胜平负", "大小球2.5", "上半场(弱信号·多平)", "单双(无信号·参考)", "半全场", "比分top3(覆盖~32%)"],
  ];
  for (const p of predictions ?? []) {
    if (p.unpredictable || p.fixture?.marketType === "shengfucai") continue;
    const lq = p.jingcaiLetqiu;
    const ln = Number(lq?.line);
    const lqText = lq?.pick ? `[${ln > 0 ? "受让+" + ln : ln < 0 ? "让" + ln : "平手"}] ${lq.pick.label} ${pct(lq.pick.probability)}` : "—";
    const sfc = lq && lq.sfcSold === false ? "⛔未开售" : outcomeCodeToChinese(p.pick?.code);
    // 大小球:用深度分析融合结论(联赛大球率+模型),deepFusionAnalysis 已写 p._ouFusion
    const ou = p._ouFusion ?? (() => { deepFusionAnalysis(p); return p._ouFusion; })();
    const ouText = ou ? `${ou.pick}(${pct(ou.blendOver)})` : "—";
    // 单双:回测证零信号(命中50.2% vs 基线50%、Brier 0.2504≈瞎猜)→ 诚实标注仅参考,勿单押。
    const oe = p.extendedMarkets?.totalGoalsOddEven;
    const oeText = oe ? `${oe.odd >= oe.even ? "单" : "双"} ≈掷硬币` : "—";
    // 上半场胜平负:回测弱信号(命中43.6% vs 基线40.9%,半场多平),诚实标注。
    const fh = p.extendedMarkets?.firstHalf;
    const fhText = fh ? (() => {
      const o = [["主胜", fh.home], ["平局", fh.draw], ["客胜", fh.away]].sort((a, b) => b[1] - a[1])[0];
      return `${o[0]} ${pct(o[1])}`;
    })() : "—";
    rows.push([
      `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
      sfc,
      lqText,
      ouText,
      fhText,
      oeText,
      // 半全场 + 信心档(cycle10 回测:高信心档命中显著更高,≥40%档→43.2% vs 均27%)。只贴档不弃赛。
      (() => { const hf = p.halfFullPicks; const t = hf?.confidenceTier; return hf?.primary ? `${hf.primary}${pct(hf.primaryProbability)}${t ? ` ${t.label}档${Math.round(t.backtestHit * 100)}%` : ""}` : "—"; })(),
      // 比分:回测 top-1 仅12.4%(物理天花板),top-3 覆盖31.8% → 给 top-3 覆盖才实用(治"单一");附首选信心档。
      (() => {
        const t = p.scorePicks?.confidenceTier;
        const tops = (Array.isArray(p.scorePicks?.distribution) && p.scorePicks.distribution.length
          ? p.scorePicks.distribution.slice(0, 3).map((s) => `${s.score}(${pct(s.probability)})`).join(" / ")
          : (p.scorePicks?.primary ?? "—"));
        return t ? `${tops} ${t.label}档${Math.round(t.backtestHit * 100)}%` : tops;
      })(),
    ]);
  }
  return rows;
}

// 大融合·每场深度分析(2026-05-31):多因素融合叙述(联赛特点+球队强度+选择分层+让球+历史+复盘裁决)。
function deepAnalysisRows(predictions) {
  const rows = [["⚡ 神选 · 大融合每场深度分析", "", "", ""], ["对阵", "主推", "深度分析(多因素融合)", "裁决"]];
  for (const p of predictions ?? []) {
    if (p.unpredictable) continue;
    const a = deepFusionAnalysis(p);
    if (!a) continue;
    rows.push([`${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`, p.pick?.label ?? "", a.factors.join("\n"), a.verdict]);
  }
  return rows;
}

function jingcaiHeaders() {
  return [
    "序", "赛事类型", "对阵", "开赛",
    "胜平负(不让球)", "让球胜平负(竞彩主玩法)", "比分", "半全场",
    "概率分布(主/平/客)", "爆冷",
    "盘口资金流向(数据变化)",
    "历史经验(同情境)",
    "信心 · 分级 · EV", "选择理由",
    "来源"
  ];
}

function fourteenHeaders() {
  return ["序", "赛事类型", "比赛", "单式", "覆盖", "类型", "概率(主/平/客)", "爆冷", "信心", "选择理由"];
}

// 任选9 sheet:同 14 场结构,每场独立胆/双选/全选 + 概率 + 信心 + 理由。
function renxuan9Rows(renxuan9) {
  const header = ["序", "赛事类型", "比赛", "单式", "覆盖", "类型", "概率(主/平/客)", "信心", "选择理由"];
  const empty = (n) => new Array(n).fill("");
  if (!renxuan9?.ok) {
    return [header, ["—", "", renxuan9?.reason ?? "任选9 不可用(可选场次不足 9)", ...empty(6)]];
  }
  const rows = renxuan9.picks.map((p) => {
    const prob = p.probabilities ?? {};
    const probSummary = `主 ${prob.home ?? "—"} / 平 ${prob.draw ?? "—"} / 客 ${prob.away ?? "—"}`;
    return [
      p.rank,
      p.competitionType ?? "—",
      p.match,
      p.pick,
      p.compound ?? p.pick,
      p.type ?? "—",
      probSummary,
      confidenceLabel(p.confidence),
      p.reason ?? ""
    ];
  });
  const ind = renxuan9.parlay?.jointProbabilityIndependent ?? null;
  const adj = renxuan9.parlay?.jointProbabilityCorrelated ?? null;
  const ot = renxuan9.optimizedTicket;
  const summary = [
    empty(9),
    ["单式串", "", renxuan9.singleLine, ...empty(6)],
    ["9 串联合命中率", "", ind != null ? `独立估计 ${pct(ind)}` : "—", adj != null ? `相关性修正 ${pct(adj)}` : "—", ...empty(5)],
    ["覆盖串", "", renxuan9.picks.map((p) => p.compound ?? p.pick).join(" | "), ...empty(6)],
    ...(ot ? [
      empty(9),
      [`⭐ 最优票(${ot.cost}注·预算${ot.budget})`, "", `整票全中 ${pct(ot.jointHitProb)}(全单选仅 ${pct(ot.allSingleHitProb)})`, ...empty(6)],
      ["最优覆盖", "", ot.legs.map((l) => `${l.match.split(" 对 ")[0] ?? ""}${l.type === "胆" ? "" : "(" + l.cover + ")"}`).join(" | "), ...empty(6)],
    ] : []),
    ["说明", "", renxuan9.note, ...empty(6)]
  ];
  return [header, ...rows, ...summary];
}

function judgmentHeaders() {
  return ["日期", "场次", "市场", "赛事", "主队", "客队", "开赛", "首选", "备选", "比分首选", "半全场首选", "信心", "风险", ...judgmentFactorColumns()];
}

function oddsComparisonHeaders() {
  return [
    "日期",
    "场次",
    "市场",
    "赛事",
    "主队",
    "客队",
    "开赛时间",
    "赔率采集时间",
    "实时状态",
    "欧赔初始主胜",
    "欧赔初始平局",
    "欧赔初始客胜",
    "欧赔实时主胜",
    "欧赔实时平局",
    "欧赔实时客胜",
    "欧赔主胜变化",
    "欧赔平局变化",
    "欧赔客胜变化",
    "亚盘初始盘口",
    "亚盘初始主水",
    "亚盘初始客水",
    "亚盘实时盘口",
    "亚盘实时主水",
    "亚盘实时客水",
    "亚盘盘口变化",
    "亚盘主水变化",
    "亚盘客水变化",
    "让球初始主胜",
    "让球初始平局",
    "让球初始客胜",
    "让球实时主胜",
    "让球实时平局",
    "让球实时客胜",
    "让球主胜变化",
    "让球平局变化",
    "让球客胜变化",
    "比分赔率",
    "半全场赔率",
    "赔率来源",
    "胜平负首选",
    "胜平负备选",
    "比分首选",
    "比分备选",
    "半全场首选",
    "半全场备选",
    "风险",
    "信心",
    "模型理由"
  ];
}

function totalGoalsLineupHeaders() {
  return [
    "日期",
    "场次",
    "市场",
    "赛事",
    "主队",
    "客队",
    "开赛时间",
    "大小球数据状态",
    "大小球初始盘口",
    "初始大球水",
    "初始小球水",
    "大小球实时盘口",
    "实时大球水",
    "实时小球水",
    "大小球盘口变化",
    "大球水变化",
    "小球水变化",
    "模型预期总进球",
    "大2.5概率",
    "小2.5概率",
    "大3.5概率",
    "大小球倾向",
    "主队特色",
    "客队特色",
    "主队近期状态",
    "客队近期状态",
    "主队Elo",
    "客队Elo",
    "伤停信息",
    "预计阵容",
    "实际阵容",
    "阵容来源状态",
    "模型理由"
  ];
}

function recapHeaders() {
  return ["日期", "场次", "赛事", "比赛", "首选", "次选", "比分首选", "比分次选", "半全场首选", "半全场次选", "让球线", "让球胜平负", "让球编码", "主胜概率", "平局概率", "客胜概率", "原始主胜概率", "原始平局概率", "原始客胜概率", "蒙特卡洛主胜", "蒙特卡洛平局", "蒙特卡洛客胜", "蒙特卡洛比分Top3", "风险", "信心", "资金决策", "EV", "每100单位建议", "理由", "实际赛果", "实际比分", "命中"];
}

function modelHealthRows(sourceGate, audit) {
  return [
    ["检查项", "状态", "说明"],
    ["实时数据源闸门", sourceGate.ok ? "通过" : "失败", `闸门年龄 ${sourceGate.ageMinutes ?? 0} 分钟`],
    ["推荐内容审核", audit.ok ? "通过" : "失败", `${audit.summary.totalChecks} 场已审核`],
    ["14场输出规则", "启用", "表格主输出胜平负、胆/双选/全选；比分和半全场只从已定胜平负派生并通过冲突审计"],
    ["严格赔率门槛", process.env.SOURCE_GATE_REQUIRE_FULL_ODDS === "1" ? "启用" : "降级允许", "启用后缺少全量赔率会阻断正式生成"]
  ];
}

function oddsText(oddsSet) {
  const point = oddsSet?.current ?? oddsSet?.final ?? oddsSet?.initial;
  if (!point) return "缺失";
  if ("line" in point) return `盘口 ${point.line}，主水 ${point.homeWater}，客水 ${point.awayWater}`;
  return `胜 ${point.home}，平 ${point.draw}，负 ${point.away}`;
}

function marketOddsText(oddsSet) {
  if (!oddsSet) return "缺失";
  if (Array.isArray(oddsSet)) return oddsSet.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  if (Array.isArray(oddsSet.top)) return oddsSet.top.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  const point = oddsSet.current ?? oddsSet.final ?? oddsSet.initial ?? oddsSet;
  if (Array.isArray(point)) return point.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  return formatMarketOddsPoint(point) || oddsText(oddsSet);
}

function formatMarketOddsPoint(point) {
  if (!point || typeof point !== "object") return "";
  if ("score" in point) return `${point.score}:${point.odds ?? point.value ?? ""}`;
  if ("halfFull" in point) return `${point.halfFull}:${point.odds ?? point.value ?? ""}`;
  if ("label" in point) return `${point.label}:${point.odds ?? point.value ?? ""}`;
  if ("home" in point || "draw" in point || "away" in point) return `胜 ${point.home ?? ""}，平 ${point.draw ?? ""}，负 ${point.away ?? ""}`;
  return "";
}

function numberOrBlank(value) {
  return Number.isFinite(value) ? value : "";
}

function oddsDelta(current, initial) {
  if (!Number.isFinite(current) || !Number.isFinite(initial)) return "";
  const delta = Math.round((current - initial) * 1000) / 1000;
  if (Object.is(delta, -0)) return "0";
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function totalGoalsMarket(snapshot) {
  const total = snapshot?.totalGoalsOdds ?? snapshot?.overUnderOdds ?? snapshot?.totalsOdds ?? snapshot?.totals ?? null;
  if (!total) return null;
  if (total.initial || total.current || total.final) return total;
  return { initial: total, current: total };
}

function modelTotalGoals(prediction) {
  const lambdas = prediction.simulation?.lambdas ?? {};
  const expectedGoals = round((lambdas.home ?? 0) + (lambdas.away ?? 0));
  const over25 = round(1 - poissonCdf(2, expectedGoals));
  const under25 = round(1 - over25);
  const over35 = round(1 - poissonCdf(3, expectedGoals));
  return {
    expectedGoals,
    over25,
    under25,
    over35,
    bias: over25 >= 0.58 ? "偏大球" : under25 >= 0.58 ? "偏小球" : "中性"
  };
}

function teamStyle(side, prediction) {
  const lambdas = prediction.simulation?.lambdas ?? {};
  const own = side === "home" ? lambdas.home ?? 0 : lambdas.away ?? 0;
  const opponent = side === "home" ? lambdas.away ?? 0 : lambdas.home ?? 0;
  const total = own + opponent;
  if (own >= 2.1) return "高压强攻/进球上限高";
  if (own >= 1.65 && own - opponent >= 0.35) return "进攻优势/主动压制";
  if (own <= 1.05 && opponent >= 1.55) return "防守承压/反击为主";
  if (total <= 2.25) return "节奏偏慢/小比分属性";
  if (Math.abs(own - opponent) <= 0.2) return "均衡对抗/容错偏低";
  return "均衡偏主动";
}

function formText(form) {
  if (!form || !Number.isFinite(form.matches) || form.matches <= 0) return "缺失";
  return `近${form.matches}场 ${numberOrBlank(form.pointsPerMatch)}分/场，净胜球${numberOrBlank(form.goalDiff)}`;
}

function eloText(elo) {
  if (!elo) return "缺失";
  const value = elo.Elo ?? elo.elo ?? elo.rating;
  return Number.isFinite(Number(value)) ? `Elo ${Math.round(Number(value))}` : "缺失";
}

function injuryText(injuries) {
  const rows = injuries?.injuries ?? injuries?.rows ?? (Array.isArray(injuries) ? injuries : []);
  if (!Array.isArray(rows) || !rows.length) return "缺失/未返回";
  const names = rows.map((row) => row.player?.name ?? row.playerName ?? row.name).filter(Boolean).slice(0, 8);
  return `${rows.length}条${names.length ? `：${names.join("、")}` : ""}`;
}

function projectedLineupText(lineups, fixture) {
  const projected = lineups?.projected ?? lineups?.predicted ?? lineups?.probable ?? lineups?.expected;
  if (projected) return formatLineupRows(projected, fixture);
  if (lineups?.lineups?.length) return "未提供预计阵容；已有确认阵容见实际阵容";
  return "缺失：未配置/未返回 LINEUP_SOURCE_URL";
}

function actualLineupText(lineups, fixture) {
  const actual = lineups?.actual ?? lineups?.confirmed ?? lineups?.lineups;
  if (actual) return formatLineupRows(actual, fixture);
  return "未公布/未返回；通常赛前约1小时才有";
}

function lineupSourceText(lineups) {
  if (!lineups) return "缺 LINEUP_SOURCE_URL/API-Football 未匹配";
  if (lineups.error) return `阵容源错误：${lineups.error}`;
  if (lineups.providerFixtureId) return `API-Football fixture=${lineups.providerFixtureId}`;
  return "授权阵容源";
}

function formatLineupRows(value, fixture) {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => {
    const team = row.team?.name ?? row.teamName ?? row.name ?? "";
    const formation = row.formation ? ` ${row.formation}` : "";
    const starters = row.startXI ?? row.startingXI ?? row.players ?? row.lineup ?? [];
    const names = Array.isArray(starters)
      ? starters.map((item) => item.player?.name ?? item.name ?? item.playerName).filter(Boolean).slice(0, 11)
      : [];
    const label = team || (sameText(row.side, "home") ? fixture.homeTeam : sameText(row.side, "away") ? fixture.awayTeam : "阵容");
    return `${label}${formation}${names.length ? `：${names.join("、")}` : ""}`;
  }).filter(Boolean).join(" | ") || "未返回球员明细";
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function poissonCdf(maxGoals, lambda) {
  if (!Number.isFinite(lambda) || lambda < 0) return 0;
  let sum = 0;
  for (let goals = 0; goals <= maxGoals; goals += 1) {
    sum += Math.exp(-lambda) * (lambda ** goals) / factorial(goals);
  }
  return Math.max(0, Math.min(1, sum));
}

function factorial(value) {
  let result = 1;
  for (let index = 2; index <= value; index += 1) result *= index;
  return result;
}

function resultCode(result) {
  if (result.home > result.away) return "3";
  if (result.home === result.away) return "1";
  return "0";
}

function pct(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
