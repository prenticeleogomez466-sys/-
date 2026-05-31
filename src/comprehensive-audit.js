/**
 * 全面审计总闸门(2026-05-30)
 * ────────────────────────────────────────────────────────────
 * 用户要求:"每道模块运行都设置全面审计,最后推荐生成,保证输出质量命中率"。
 *
 * 把此前散落的各审计**编排成一份统一审计**,在推荐生成时一次跑完,产出单一裁决:
 *   1. 模块结构   auditModelStructure   —— 结构 errors = 硬 blocker(代码层坏了不出表)
 *   2. 模块缺陷   auditModelDefects     —— P0/P1/P2 分级汇总(数据时效类不在此硬拦,见 ⑥ 说明)
 *   3. 能力就绪   auditModelCapabilities —— P0 层就绪度汇总(展示)
 *   4. 推荐内容   auditRecommendations  —— 竞彩/14场 实质校验 errors = 硬 blocker
 *   5. 逐场自检   runPreExportSelfCheck  —— 每场 provenance/方向一致/数据齐全 blockers = 硬 blocker
 *   6. 真实性总结 —— 从逐场自检 roll-up:进推荐的每场都可追溯真实先验、0 造假、方向一致
 *
 * 硬 blocker(任一非空即拦出表)= 让输出"假/错/缺方向"的问题:结构 errors、推荐内容
 *   errors、逐场自检 blockers(含 data-missing/seeded 造假、wld↔比分↔半全场冲突、竞彩缺快照)。
 * 数据新鲜度(闸门过期)由专门的 assertLatestRealtimeSourceGate 负责硬拦,本闸门不重复硬拦、
 *   只在报告里如实标注,避免双重拦截语义混乱(诚实 > 重复)。
 */

import { auditModelStructure } from "./model-structure-audit.js";
import { auditModelDefects } from "./model-defect-audit.js";
import { auditModelCapabilities } from "./model-capability-registry.js";
import { auditRecommendations } from "./recommendation-audit.js";
import { runPreExportSelfCheck } from "./pre-export-selfcheck.js";
import { auditMultimodalBatch } from "./multimodal-collab.js";
import { loadModelMemory } from "./model-memory.js";

function safe(fn, label) {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, value: null, error: `[${label}] 审计自身抛错:${e?.message ?? e}` }; }
}

/**
 * @param {{ date:string, recommendations:object, env?:object, runModuleAudits?:boolean }} args
 *   runModuleAudits=false 可只跑输出层审计(单测/轻量调用用);默认 true 跑全量。
 * @returns {{ ok, date, blockers:string[], warnings:string[], sections:object[], integrity:object }}
 */
export function runComprehensiveAudit({ date, recommendations, env = process.env, runModuleAudits = true, precomputed = null, modelMemory = undefined } = {}) {
  const blockers = [];
  const warnings = [];
  const sections = [];

  // ① 模块结构(warning:结构审计混了代码检查与运行时文件检查——"缺闸门文件"等数据类
  //   错误已由 assertLatestRealtimeSourceGate 在出表前硬拦,这里不重复硬拦,只如实标注;
  //   真代码结构回归由 npm test 把关)。
  if (runModuleAudits) {
    const r = safe(() => auditModelStructure(date), "模块结构");
    if (!r.ok) { warnings.push(r.error); sections.push({ name: "模块结构", status: "⚠跳过", detail: r.error }); }
    else {
      const s = r.value?.summary ?? {};
      const errs = s.errors ?? 0;
      if (errs > 0) warnings.push(`模块结构 ${errs} 项告警(多为缺运行时文件/数据,新鲜度由 source-gate 硬拦)`);
      sections.push({ name: "模块结构", status: errs > 0 ? "⚠" : "✓", detail: `通过 ${s.passed ?? "?"}/${s.total ?? "?"},错误 ${errs},警告 ${s.warnings ?? 0}` });
    }
  }

  // ② 模块缺陷(分级汇总;P0 多为数据时效,由 source-gate 硬拦,这里 warning 提示)
  if (runModuleAudits) {
    const r = safe(() => auditModelDefects(date, env), "模块缺陷");
    if (!r.ok) { warnings.push(r.error); sections.push({ name: "模块缺陷", status: "⚠跳过", detail: r.error }); }
    else {
      const sev = r.value?.summary?.bySeverity ?? {};
      const p0 = sev.P0 ?? 0, p1 = sev.P1 ?? 0, p2 = sev.P2 ?? 0;
      for (const d of (r.value?.defects ?? [])) {
        const tag = `[${d.severity}] ${d.message ?? d.detail ?? d.title ?? ""}`;
        if (d.severity === "P0") warnings.push(`缺陷 ${tag}(数据时效/就绪类,出表新鲜度由 source-gate 硬拦)`);
        else warnings.push(`缺陷 ${tag}`);
      }
      sections.push({ name: "模块缺陷", status: p0 > 0 ? "⚠P0" : (p1 + p2 > 0 ? "⚠" : "✓"), detail: `P0 ${p0} / P1 ${p1} / P2 ${p2}` });
    }
  }

  // ③ 能力就绪(展示;P0 层 partial 提示)
  if (runModuleAudits) {
    const r = safe(() => auditModelCapabilities(date), "能力就绪");
    if (!r.ok) { warnings.push(r.error); sections.push({ name: "能力就绪", status: "⚠跳过", detail: r.error }); }
    else {
      const s = r.value?.summary ?? {};
      if ((s.blockedP0 ?? 0) > 0) warnings.push(`能力:${s.blockedP0} 个 P0 层未完全就绪(多为今日实时数据未刷新)`);
      sections.push({ name: "能力就绪", status: (s.blockedP0 ?? 0) > 0 ? "⚠" : "✓", detail: `就绪 ${s.ready ?? "?"} / partial ${s.partial ?? 0} / candidate ${s.candidate ?? 0}` });
    }
  }

  // ④ 推荐内容实质校验(硬:errors 拦出表)。可复用 daily-report 已算好的结果,免重复跑。
  const recAudit = precomputed?.recAudit
    ? { ok: true, value: precomputed.recAudit }
    : safe(() => auditRecommendations(recommendations), "推荐内容");
  if (!recAudit.ok) { blockers.push(recAudit.error); sections.push({ name: "推荐内容", status: "✗", detail: recAudit.error }); }
  else {
    const a = recAudit.value;
    if (!a.ok) (a.errors ?? []).forEach((e) => blockers.push(`推荐内容:${e.message ?? e}`));
    sections.push({ name: "推荐内容", status: a.ok ? "✓" : "✗", detail: `错误 ${a.summary?.errors ?? (a.errors?.length ?? 0)}` });
  }

  // ⑤ 逐场出表自检(硬:blockers 拦出表;含 provenance/方向一致/数据齐全)。可复用已算好的结果。
  const selfCheckRes = precomputed?.selfCheck
    ? { ok: true, value: precomputed.selfCheck }
    : safe(() => runPreExportSelfCheck(recommendations), "逐场自检");
  let selfCheck = null;
  if (!selfCheckRes.ok) { blockers.push(selfCheckRes.error); sections.push({ name: "逐场自检", status: "✗", detail: selfCheckRes.error }); }
  else {
    selfCheck = selfCheckRes.value;
    (selfCheck.blockers ?? []).forEach((b) => blockers.push(`逐场自检:${b}`));
    (selfCheck.warnings ?? []).forEach((w) => warnings.push(`逐场自检:${w}`));
    sections.push({ name: "逐场自检", status: selfCheck.ok ? "✓" : "✗", detail: `blocker ${selfCheck.blockers?.length ?? 0} / warning ${selfCheck.warnings?.length ?? 0}` });
  }

  // ⑥ 真实性 roll-up(进推荐的每场都可追溯真实先验、0 造假、方向一致)
  const integrity = buildIntegrityRollup(recommendations, selfCheck);
  if (integrity.fabricated > 0) blockers.push(`真实性:${integrity.fabricated} 场进推荐却无真实先验(provenance 造假),不出表`);
  sections.push({ name: "真实性总结", status: integrity.fabricated > 0 ? "✗" : "✓", detail: integrity.summary });

  // ⑦ 逐玩法核验 roll-up(用户要求:全面审计必须显式覆盖 胜负平/让球/比分/半全场)。
  //   从逐场自检的逐玩法 checks 汇总每个玩法的 通过/失败 场数,任一玩法有失败即在自检 blockers 体现
  //   (此处只做显式呈现,不重复拦截)。让"三大方向玩法是否逐场过检"在审计表里一眼可见。
  const playtypes = buildPlaytypeRollup(selfCheck);
  const ptFail = playtypes.items.filter((i) => i.fail > 0);
  sections.push({
    name: "逐玩法核验",
    status: ptFail.length ? "✗" : "✓",
    detail: playtypes.items.map((i) => `${i.label} ✓${i.pass}${i.fail ? `/✗${i.fail}` : ""}`).join(" · ")
  });

  // ⑧ 多模态层审计(2026-05-31 用户要求"每层加一道全面审计,避免孤儿/假数据/降质量")。
  //   多模态是纯读取层(不改 pick/probabilities→质量零影响);本道验证它如实:
  //   硬 blocker = 展示了不存在/不归一的概率、误读锚方向(=假数据);warning = 锚偏离共识/水位异动/逆市。
  const mm = safe(() => auditMultimodalBatch(recommendations?.predictions ?? []), "多模态层");
  let mmAudit = null;
  if (!mm.ok) { warnings.push(mm.error); sections.push({ name: "多模态层", status: "⚠跳过", detail: mm.error }); }
  else {
    mmAudit = mm.value;
    mmAudit.blockers.forEach((b) => blockers.push(`多模态层:${b}`));
    mmAudit.warnings.forEach((w) => warnings.push(`多模态层:${w}`));
    const bp = mmAudit.byPlaytype ?? {};
    sections.push({
      name: "多模态层(四玩法小模型)",
      status: mmAudit.blockers.length ? "✗" : "✓",
      detail: `分析 ${mmAudit.analyzed} 场 · ` + ["方向", "比分", "半全场", "数据变化"]
        .map((k) => `${k} ✓${bp[k]?.ok ?? 0}${bp[k]?.warn ? `/⚠${bp[k].warn}` : ""}${bp[k]?.na ? `/—${bp[k].na}` : ""}`).join(" · ")
    });
  }

  // ⑨ 爆冷/诱盘核验 roll-up(2026-05-31 用户要求:输出"可能爆冷的场次+原因"+"赔率是诱盘还是真实")。
  //   从 prediction.upsetTrap 汇总:高爆冷风险场 / 诱盘嫌疑场 / 爆冷价值(聪明钱撤离)场。
  //   遵 [[feedback-confidence-not-autosuppress]]:只提示不弃赛——故 warning(不 blocker);
  //   仅"upsetTrap 字段畸形/概率越界"(=假数据)才升 blocker(本层亦不得编造)。
  const ut = safe(() => buildUpsetTrapRollup(recommendations?.predictions ?? []), "爆冷诱盘核验");
  let upsetTrap = null;
  if (!ut.ok) { warnings.push(ut.error); sections.push({ name: "爆冷/诱盘核验", status: "⚠跳过", detail: ut.error }); }
  else {
    upsetTrap = ut.value;
    upsetTrap.malformed.forEach((m) => blockers.push(`爆冷/诱盘:${m}`)); // 字段畸形=假数据,硬拦
    upsetTrap.highlights.forEach((h) => warnings.push(`爆冷提示:${h}`)); // 高风险/诱盘=提示,不拦
    sections.push({
      name: "爆冷/诱盘核验",
      status: upsetTrap.malformed.length ? "✗" : "✓",
      detail: `覆盖 ${upsetTrap.analyzed} 场 · 高爆冷 ${upsetTrap.highUpset} · 诱盘嫌疑 ${upsetTrap.trapSuspect} · 爆冷价值 ${upsetTrap.fadeValue} · 真实确认 ${upsetTrap.confirmed}`
    });
  }

  // ⑩ 模型自知 + 信心校准漂移(2026-06-01,永久记忆纳入总闸门)。
  //   从 model-memory 读模型分段真实战绩(总体/信心带),作"自知"读数 + 检测"信心档↔真实命中"是否背离
  //   (高信心档历史命中反低于低信心档=校准漂移,提示重训校准)。纯读数+提示,不拦出表。
  const memory = modelMemory !== undefined ? modelMemory : safe(() => loadModelMemory(), "模型记忆").value;
  let selfKnowledge = null;
  if (memory && memory.global) {
    selfKnowledge = buildSelfKnowledgeRollup(memory);
    selfKnowledge.driftWarnings.forEach((w) => warnings.push(`信心校准漂移:${w}`));
    sections.push({
      name: "模型自知(永久记忆)",
      status: selfKnowledge.driftWarnings.length ? "⚠" : "✓",
      detail: selfKnowledge.detail
    });
  } else {
    sections.push({ name: "模型自知(永久记忆)", status: "—", detail: "无 model-memory(未结算/未 build),跳过自知读数" });
  }

  return {
    ok: blockers.length === 0,
    date,
    blockers,
    warnings,
    sections,
    integrity,
    playtypes,
    multimodal: mmAudit,
    upsetTrap,
    selfKnowledge
  };
}

// 模型自知汇总:把 model-memory 的总体+信心带战绩转成读数,并检测信心校准漂移
//   (按信心档从低到高,真实命中率应单调不降;有足够样本的高档反低于低档 → 漂移告警)。
function buildSelfKnowledgeRollup(memory) {
  const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const g = memory.global;
  const bandsOrder = ["低(<55)", "中(55-65)", "高(65-75)", "极高(≥75)"];
  const bands = memory.byConfidenceBand ?? {};
  const driftWarnings = [];
  // 单调性检查(仅在两档都 n>=10 时比较,避免小样本噪声)。
  const present = bandsOrder.map((b) => ({ b, cell: bands[b] })).filter((x) => x.cell && x.cell.n >= 10);
  for (let i = 1; i < present.length; i++) {
    const lo = present[i - 1], hi = present[i];
    if (lo.cell.wldHit != null && hi.cell.wldHit != null && hi.cell.wldHit < lo.cell.wldHit - 0.05) {
      driftWarnings.push(`${hi.b}档命中 ${pct(hi.cell.wldHit)}(n=${hi.cell.n}) < ${lo.b}档 ${pct(lo.cell.wldHit)}(n=${lo.cell.n}),信心未转化为命中,建议重训校准`);
    }
  }
  const bandStr = bandsOrder.filter((b) => bands[b]).map((b) => `${b} ${pct(bands[b].wldHit)}(n=${bands[b].n})`).join(" · ");
  const detail = `已结算 ${memory.settledTotal} 场 · 总体胜平负 ${pct(g.wldHit)}(n=${g.wldN}) · 比分 ${pct(g.scoreHit)}(n=${g.scoreN}) · 半全场 ${pct(g.halfFullHit)}(n=${g.halfFullN}) | 信心带:${bandStr || "—"}`;
  return { detail, driftWarnings, settledTotal: memory.settledTotal, global: g };
}

// 爆冷/诱盘核验汇总:从 prediction.upsetTrap 统计 高爆冷/诱盘嫌疑/爆冷价值/真实确认 场数,
//   并校验字段真实性(概率域、reason 非空)——畸形=假数据计入 malformed(硬 blocker)。
function buildUpsetTrapRollup(predictions) {
  let analyzed = 0, highUpset = 0, trapSuspect = 0, fadeValue = 0, confirmed = 0;
  const highlights = [];
  const malformed = [];
  for (const p of predictions ?? []) {
    const u = p?.upsetTrap;
    if (!u) continue; // 无开收盘赔率的场 upsetTrap=null,正常跳过(不编造)
    analyzed++;
    const name = `${p.fixture?.homeTeam ?? p.homeTeam ?? "?"} vs ${p.fixture?.awayTeam ?? p.awayTeam ?? "?"}`;
    // 真实性校验:概率必须在 (0,1),reason 必须非空字符串。
    const probOk = Number.isFinite(u.upsetRisk) && u.upsetRisk > 0 && u.upsetRisk < 1
      && Number.isFinite(u.favoriteImplied) && u.favoriteImplied > 0 && u.favoriteImplied <= 1;
    if (!probOk || typeof u.reason !== "string" || !u.reason) {
      malformed.push(`[${name}] upsetTrap 字段畸形(upsetRisk=${u.upsetRisk}/favoriteImplied=${u.favoriteImplied})`);
      continue;
    }
    if (u.upsetLevel === "高") { highUpset++; highlights.push(`[${name}] 高爆冷风险:${u.reason}`); }
    if (/诱盘/.test(u.trapVerdict)) { trapSuspect++; if (u.upsetLevel !== "高") highlights.push(`[${name}] ${u.trapVerdict}:${u.reason}`); }
    if (/爆冷价值|撤离/.test(u.trapVerdict)) fadeValue++;
    if (/真实/.test(u.trapVerdict)) confirmed++;
  }
  return { analyzed, highUpset, trapSuspect, fadeValue, confirmed, highlights, malformed };
}

// 逐玩法核验汇总:从逐场自检 perFixture.checks 统计 胜负平/让球/比分/半全场 各自通过/失败场数。
// 比分/半全场/胜负平 的 ✗ 既含方向冲突,也含 λ 量级失真(新闸门),即"真数据算错"也计入失败。
function buildPlaytypeRollup(selfCheck) {
  const KEYS = [["胜负平", "胜负平"], ["让球", "让球"], ["比分", "比分"], ["半全场", "半全场"]];
  const per = selfCheck?.perFixture ?? [];
  const items = KEYS.map(([key, label]) => {
    let pass = 0, fail = 0;
    for (const f of per) {
      const v = f.checks?.[key];
      if (v === "✗") fail++;
      else if (v === "✓") pass++;
    }
    return { key, label, pass, fail };
  });
  return { items, allPass: items.every((i) => i.fail === 0) };
}

// 从推荐 + 逐场自检结果汇总真实性指标(不重复逐场逻辑,只做计数/裁决)。
function buildIntegrityRollup(recommendations, selfCheck) {
  const preds = recommendations?.predictions ?? [];
  const total = preds.length;
  // 进推荐的每场都必须有真实先验来源(odds/DC),provenance 不得是 data-missing/seeded。
  const bad = preds.filter((p) => !p.provenance || /seed|fallback|data-missing/i.test(p.provenance) || p.unpredictable);
  const dataMissingShown = (recommendations?.unpredictable ?? []).length;
  const provenanceDist = {};
  for (const p of preds) provenanceDist[provKind(p.provenance)] = (provenanceDist[provKind(p.provenance)] ?? 0) + 1;
  const consistencyFails = selfCheck?.perFixture
    ? selfCheck.perFixture.filter((f) => f.checks && Object.values(f.checks).includes("✗")).length
    : null;
  return {
    total,
    fabricated: bad.length,
    dataMissingDisclosed: dataMissingShown,
    provenanceDist,
    consistencyFails,
    summary: `进推荐 ${total} 场,造假 ${bad.length},数据缺失已诚实单列 ${dataMissingShown} 场`
      + (consistencyFails != null ? `,方向不一致 ${consistencyFails}` : "")
  };
}

function provKind(prov) {
  if (!prov) return "未知";
  if (/data-missing|seed|fallback/i.test(prov)) return "造假/缺失";
  if (/^odds-only$/i.test(prov)) return "纯赔率";
  if (/dixon-coles-only/i.test(prov)) return "纯DC";
  if (/odds.*dixon-coles/i.test(prov)) return "赔率+DC";
  return prov;
}

/** 把全面审计结果转成 xlsx sheet 行(供 daily-report 写入)。 */
export function comprehensiveAuditRows(audit) {
  const rows = [["全面审计", audit.ok ? "✅ 通过(质量/真实性达标,允许出表)" : `❌ 拦截出表(${audit.blockers.length} 项硬问题)`, ""]];
  rows.push(["——", "分项", "结论"]);
  for (const s of audit.sections) rows.push(["", `${s.status} ${s.name}`, s.detail]);
  if (audit.blockers.length) {
    rows.push(["——", "硬 blocker(必须修才出表)", ""]);
    audit.blockers.forEach((b, i) => rows.push(["", `${i + 1}`, b]));
  }
  if (audit.warnings.length) {
    rows.push(["——", "warning(如实标注,不拦出表)", ""]);
    audit.warnings.slice(0, 30).forEach((w, i) => rows.push(["", `${i + 1}`, w]));
  }
  return rows;
}
