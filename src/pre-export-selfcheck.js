/**
 * 出表前自检闸门(2026-05-30 用户硬规则:见记忆 feedback-preexport-model-selfcheck)。
 *
 * 每次生成推荐 xlsx 之前必须先过这道闸门,逐场 × 逐玩法核验,任一 blocker → 不出表。
 * 覆盖用户要求的全部内容:胜负平 / 让球 / 比分 / 半全场 / 14场 / 任选9,外加
 *   ① 场次齐全(predictions==fixtures、竞彩不空、14场满 14)
 *   ② 方向不冲突(让球以 wld 为锚、比分/半全场方向 == wld、validatePredictionConsistency 0 错)
 *   ③ 数据准确(概率归一、比分进球数物理合理、竞彩有实时快照)
 *   ④ 真模型跑出(标注每场 DC 是否真跑/融合是否 fire;纯随机种子兜底 = blocker;
 *      纯赔率换算 = warning 并标注,让用户一眼看出"模型是否都在跑、在生成")
 *
 * blocker 阻断出表;warning 不阻断但写进自检表醒目提示。
 */
import {
  scoreOutcomeCode,
  halfFullFinalOutcomeCode,
  validatePredictionConsistency,
  fourteenSelectionRules,
} from "./prediction-engine.js";

// 比分进球数物理合理上限:单队 90 分钟极少 >5、总进球极少 >7。超出 = 数据失真(如 λ 爆炸出 8-0)。
const SCORE_TOTAL_MAX = 7;
const SCORE_SIDE_MAX = 5;

// λ(场均进球期望)物理合理区间 —— 比分/半全场/胜负平全从 λ 派生,λ 算错则三者一起错。
//   单队 90 分钟 λ 极少 >3.5、双方合计极少 >4.5。超出 = 真实先验被数学算错放大
//   (2026-05-30 市场推断 ratio 被平方,意图 λ=2.27 → 矩阵实际 4.5,比分被灌 4-0/5-0/6-0)。
//   关键:即便最终比分恰落在 5-0 以内、来源真实(非编造)、方向自洽,只要 λ 量级离谱
//   也必须拦——这正是旧"只查最终比分/只查 provenance"的盲区(总进球 4.28 才是铁证)。
const LAMBDA_SIDE_BLOCK = 4.0;   // 单队 λ 超此 = 确属算错(真实极限约 3.5)
const LAMBDA_TOTAL_BLOCK = 5.5;  // 双方合计超此 = 非物理
const LAMBDA_SIDE_WARN = 3.3;    // 偏高,人工确认
const LAMBDA_TOTAL_WARN = 4.6;

export function runPreExportSelfCheck(recommendations) {
  const blockers = [];
  const warnings = [];
  const perFixture = [];
  const preds = recommendations?.predictions ?? [];

  // ===== 场次齐全 =====
  if (!preds.length) blockers.push("无任何预测场次(predictions 为空)");
  if (recommendations?.fixtures != null && recommendations.fixtures !== preds.length) {
    blockers.push(`场次数不一致:fixtures=${recommendations.fixtures} 但 predictions=${preds.length}`);
  }
  const jingcai = preds.filter((p) => p.fixture?.marketType === "jingcai");

  for (const p of preds) {
    const f = p.fixture ?? {};
    const name = `${f.homeTeam ?? "?"} vs ${f.awayTeam ?? "?"}`;
    const checks = {};
    const fail = (key, msg) => { checks[key] = "✗"; blockers.push(`[${name}] ${msg}`); };
    const pass = (key) => { if (checks[key] !== "✗") checks[key] = "✓"; };
    const wld = p.pick?.code;

    // 胜负平
    if (!["3", "1", "0"].includes(wld) || !p.pick?.label) fail("胜负平", `胜负平缺失或非法:${wld}`);
    else pass("胜负平");
    const probSum = Object.values(p.probabilities ?? {}).reduce((s, v) => s + Number(v || 0), 0);
    if (Math.abs(probSum - 1) > 0.02) fail("胜负平", `胜平负概率未归一:${probSum.toFixed(3)}`);

    // 让球(以 wld 为锚)
    if (!p.handicapPick) fail("让球", "缺让球推荐");
    else if (!Number.isFinite(Number(p.handicapPick.line))) fail("让球", "让球盘口 line 无效");
    else if (p.handicapPick.direction !== p.pick?.label) fail("让球", `让球方向 ${p.handicapPick.direction} 未以 wld(${p.pick?.label})为锚`);
    else pass("让球");

    // 比分(2026-06-02 改:首选=真实最可能比分,可含平局,不再核它与 wld 方向一致;
    //   方向一致改核"与方向一致比分"wldConsistent。两者都做进球物理合理性核。)
    const score = p.scorePicks?.primary;
    const wldScore = p.scorePicks?.wldConsistent ?? p.scorePicks?.primary; // 回退兼容旧对象
    const saneGoals = (s) => {
      const mm = String(s ?? "").match(/^(\d+)\s*-\s*(\d+)$/);
      if (!mm) return `比分格式异常:${s}`;
      const h = Number(mm[1]), a = Number(mm[2]);
      if (h + a > SCORE_TOTAL_MAX || h > SCORE_SIDE_MAX || a > SCORE_SIDE_MAX) return `比分 ${s} 进球数异常(总>${SCORE_TOTAL_MAX} 或 单队>${SCORE_SIDE_MAX})— 疑 λ 失真`;
      return null;
    };
    if (!score) {
      fail("比分", "缺比分首选");
    } else if (!wldScore) {
      fail("比分", "缺与方向一致比分(wldConsistent)");
    } else {
      const wc = scoreOutcomeCode(wldScore);
      const errMode = saneGoals(score);   // 真实众数进球合理性
      const errWld = saneGoals(wldScore); // 方向一致比分进球合理性
      if (wc !== wld) fail("比分", `方向一致比分 ${wldScore} 方向(${wc})与 wld(${wld})冲突`);
      else if (errMode) fail("比分", errMode);
      else if (errWld) fail("比分", errWld);
      else pass("比分");
    }

    // 进球量级(λ)合理性 —— 比分/半全场/胜负平的共同底座,λ 算错则三者同错。
    //   读 DC 期望进球(无 DC 时回退 simulation.lambdas);任一侧或合计超物理上限 → blocker。
    //   抓的是"真实来源 + 数学算错"这类旧闸门盲区(provenance 真、方向自洽、比分≤5-0 但 λ 爆)。
    const eg = p.dixonColes?.expectedGoals ?? p.simulation?.lambdas;
    const lh = Number(eg?.home), la = Number(eg?.away);
    if (Number.isFinite(lh) && Number.isFinite(la)) {
      const lt = lh + la;
      if (lh > LAMBDA_SIDE_BLOCK || la > LAMBDA_SIDE_BLOCK || lt > LAMBDA_TOTAL_BLOCK) {
        fail("比分", `进球期望 λ 异常(主${lh.toFixed(2)}/客${la.toFixed(2)}/合计${lt.toFixed(2)})— 超物理上限,疑 λ 被算错放大,比分/半全场/胜负平连带失真`);
      } else if (lh > LAMBDA_SIDE_WARN || la > LAMBDA_SIDE_WARN || lt > LAMBDA_TOTAL_WARN) {
        warnings.push(`[${name}] 进球期望偏高(主${lh.toFixed(2)}/客${la.toFixed(2)}/合计${lt.toFixed(2)})— 请人工确认非 λ 失真`);
      }
    }

    // 半全场(全场方向一致)
    const hf = p.halfFullPicks?.primary;
    if (!hf) fail("半全场", "缺半全场首选");
    else if (halfFullFinalOutcomeCode(hf) !== wld) fail("半全场", `半全场 ${hf} 全场方向与 wld(${wld})冲突`);
    else pass("半全场");

    // 方向不冲突(综合,复用现成校验)
    const consErrs = validatePredictionConsistency(p);
    if (consErrs.length) { checks["方向一致"] = "✗"; consErrs.forEach((e) => blockers.push(`[${name}] ${e}`)); }
    else checks["方向一致"] = "✓";

    // 真模型跑出 —— 以 provenance(每场胜平负先验真实来源)为准,不再只看可空的 dixonColes.source。
    //   provenance=data-missing / unpredictable ⇒ 无真实先验、属编造,直接 blocker(2026-05-30 根因修复)。
    const dc = p.dixonColes;
    const prov = p.provenance ?? dc?.source ?? "";
    const src = prov;
    const fired = p.probabilityAdjustment?.fusion?.fired?.length ?? 0;
    if (p.unpredictable || /seed|fallback|data-missing/i.test(prov)) {
      checks["模型"] = "✗";
      blockers.push(`[${name}] 非真模型结果(${prov || "数据缺失"})——禁止编造方向,需补抓该场实时赔率`);
    }
    else if (!dc) { checks["模型"] = "⚠仅赔率"; warnings.push(`[${name}] DC 未覆盖(纯赔率换算,模型核心未参与)`); }
    else checks["模型"] = fired > 0 ? "✓DC+融合" : "✓DC";

    // 数据(竞彩需实时快照)
    if (f.marketType === "jingcai" && !p.marketSnapshot) fail("数据", "竞彩缺实时赔率快照");
    else if (checks["数据"] !== "✗") checks["数据"] = "✓";

    perFixture.push({
      seq: f.sequence ?? "?",
      match: name,
      checks,
      model: { dcRan: Boolean(dc), source: src || "纯赔率", fusionFired: fired },
    });
  }

  // ===== 14 场 + 任选9 =====
  const ft = recommendations?.fourteen ?? {};
  const fourteenCheck = { available: Boolean(ft.available) };
  if (ft.available) {
    const sels = ft.selections ?? [];
    if (sels.length !== 14) blockers.push(`14场场次不全:${sels.length}/14`);
    const rules = fourteenSelectionRules();
    const bankers = sels.filter((s) => s.type === "胆").length;
    if (bankers > rules.maxBankers) blockers.push(`14场定胆过多:${bankers}/${rules.maxBankers}`);
    for (const s of sels) {
      if (!s.single || !s.compound || !s.type) blockers.push(`14场第${s.index}场字段缺失(单式/覆盖/类型)`);
      if (s.type === "胆" && s.risk === "高") blockers.push(`14场高风险禁止定胆:第${s.index} ${s.match}`);
    }
    fourteenCheck.count = sels.length;
    fourteenCheck.bankers = bankers;

    const rx = ft.renxuan9;
    if (!rx || rx.ok === false) warnings.push("任选9 不可用/未生成");
    else if (!(rx.picks?.length >= 9)) blockers.push(`任选9 候选不足9场:${rx.picks?.length ?? 0}`);
    else fourteenCheck.renxuan9 = rx.picks.length;
  }

  return {
    ok: blockers.length === 0,
    verdict: blockers.length ? "blocked" : "pass",
    summary: {
      fixtures: preds.length,
      jingcai: jingcai.length,
      fourteen: ft.available ? (ft.selections?.length ?? 0) : 0,
      renxuan9: ft.renxuan9?.picks?.length ?? 0,
      dcRan: perFixture.filter((r) => r.model?.dcRan).length,
      oddsOnly: perFixture.filter((r) => r.model && !r.model.dcRan).length,
      fusionFired: perFixture.filter((r) => r.model?.fusionFired > 0).length,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    perFixture,
    fourteen: fourteenCheck,
    blockers,
    warnings,
  };
}

// xlsx "出表自检" sheet 的行(供 daily-report 调用)
export function selfCheckRows(selfCheck) {
  const s = selfCheck.summary;
  const header = ["序", "对阵", "胜负平", "让球", "比分", "半全场", "方向一致", "模型", "数据"];
  const rows = [
    [`自检结论:${selfCheck.verdict === "pass" ? "✅ 通过,可出表" : "⛔ 拦截,不出表"}`,
      `场次 ${s.fixtures} · 竞彩 ${s.jingcai} · 14场 ${s.fourteen} · 任选9 ${s.renxuan9}`,
      `DC真跑 ${s.dcRan} · 仅赔率 ${s.oddsOnly} · 融合fire ${s.fusionFired}`,
      `拦截 ${s.blockers} · 提示 ${s.warnings}`, "", "", "", "", ""],
    header,
  ];
  for (const r of selfCheck.perFixture) {
    rows.push([
      r.seq, r.match,
      r.checks["胜负平"] ?? "", r.checks["让球"] ?? "", r.checks["比分"] ?? "",
      r.checks["半全场"] ?? "", r.checks["方向一致"] ?? "", r.checks["模型"] ?? "", r.checks["数据"] ?? "",
    ]);
  }
  if (selfCheck.blockers.length) {
    rows.push(["⛔ 拦截原因", "", "", "", "", "", "", "", ""]);
    selfCheck.blockers.forEach((b) => rows.push([b, "", "", "", "", "", "", "", ""]));
  }
  if (selfCheck.warnings.length) {
    rows.push(["⚠ 提示", "", "", "", "", "", "", "", ""]);
    selfCheck.warnings.forEach((w) => rows.push([w, "", "", "", "", "", "", "", ""]));
  }
  return rows;
}
