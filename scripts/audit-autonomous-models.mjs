/**
 * 自主小模型 三连审计(2026-05-31)——用户硬要求:每个环节都查 孤儿 / 真实分析 / 真实数据。
 * ════════════════════════════════════════════════════════════════════
 * 对每个"自主小模型"环节验证三件事,任一不达标 → 非 0 退出(可挂 CI / 出表闸门):
 *   ① 孤儿:生产符号被 prediction-engine 真实 import(静态可达,不是建了没接)。
 *   ② 真实分析:生产参数来自数据拟合(profile.source=fixture-store-* 且带 backtest 增益证据),
 *      或诚实弃用(无 profile + 退回写死默认,且训练器记录过 holdout 裁决)——绝不是凭空硬编码冒充"已优化"。
 *   ③ 真实数据:profile 可追溯(nTrain 大 / generatedAt / backtest delta),且引擎输出带 provenance 字段。
 *
 * 用法:node scripts/audit-autonomous-models.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "../src/paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engineSrc = readFileSync(join(root, "src/prediction-engine.js"), "utf8");
const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; } };
const exp = getExportDir();

// 注册表:每个自主小模型环节的审计契约
const MODELS = [
  {
    name: "大小球 isotonic 校准 (overunder-calibration)",
    module: "src/overunder-calibration.js",
    prodSymbol: "calibrateOver25",          // 生产入口符号
    profile: "overunder-calibration-profile.json",
    profileRequired: true,                  // 回测已证增益 → 必须有 usable profile
    engineProvenance: "overunder-isotonic", // 引擎输出须带的 provenance 标记
    minKnots: 5, minTrain: 5000,
  },
  {
    name: "半全场参数拟合 (halftime-fulltime)",
    module: "src/halftime-fulltime-model.js",
    prodSymbol: "halfFullJoint",
    trainer: "scripts/train-halffull-params.mjs",
    profileRequired: false,                 // holdout 证拟合未优于默认 → 诚实弃用,退回 HF_DEFAULTS
    engineProvenance: null,
  },
];

let failures = 0;
const line = (s) => console.log(s);
const check = (ok, msg) => { line(`   ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failures++; return ok; };

line("自主小模型 三连审计(孤儿 / 真实分析 / 真实数据)\n");
for (const m of MODELS) {
  line(`▌ ${m.name}`);
  const mod = read(m.module);

  // ① 孤儿:模块存在 + 生产符号被引擎 import
  check(mod.length > 0, `模块存在 ${m.module}`);
  check(mod.includes(`export function ${m.prodSymbol}`) || mod.includes(`export {`) && mod.includes(m.prodSymbol),
    `导出生产符号 ${m.prodSymbol}`);
  check(engineSrc.includes(m.prodSymbol), `prediction-engine 真实引用 ${m.prodSymbol}(非孤儿)`);

  // ② + ③ 真实分析 + 真实数据
  if (m.profileRequired) {
    const pPath = join(exp, m.profile);
    if (!check(existsSync(pPath), `profile 已落盘 ${m.profile}`)) { line(""); continue; }
    let prof; try { prof = JSON.parse(readFileSync(pPath, "utf8")); } catch { prof = null; }
    check(prof?.usable === true, "profile.usable=true");
    check(/fixture-store/.test(prof?.source || ""), `数据来源=fixture-store(真实数据),实际:${prof?.source}`);
    check((prof?.isotonicMap?.knots?.length ?? 0) >= m.minKnots, `isotonic knots≥${m.minKnots}(真实拟合非硬编码),实际 ${prof?.isotonicMap?.knots?.length ?? 0}`);
    check((prof?.nTrain ?? 0) >= m.minTrain, `训练样本≥${m.minTrain},实际 ${prof?.nTrain ?? 0}`);
    check((prof?.backtest?.deltaBrier ?? 0) > 0, `holdout 回测证增益 deltaBrier>0,实际 +${prof?.backtest?.deltaBrier}`);
    check(Boolean(prof?.generatedAt), "带 generatedAt(可追溯生成时点)");
    if (m.engineProvenance) check(engineSrc.includes(m.engineProvenance), `引擎输出带 provenance 标记 "${m.engineProvenance}"`);
  } else {
    // 诚实弃用路径:训练器存在且会做 holdout 裁决,生产退回写死默认(非假冒已优化)
    const tr = read(m.trainer);
    check(tr.length > 0, `训练器存在 ${m.trainer}(可重验:数据变了会自动采纳)`);
    check(/no-fabrication|不.*(写|落).*profile|未优于/.test(tr), "训练器含 holdout 裁决逻辑(打不过默认则诚实弃用)");
    check(!existsSync(join(exp, "halffull-params-profile.json")), "无 profile = 诚实退回 HF_DEFAULTS(未假冒数据拟合)");
  }
  line("");
}

line(failures === 0 ? "✅ 全部自主小模型通过三连审计(无孤儿 / 真实分析 / 真实数据)"
  : `❌ ${failures} 项审计未通过`);
process.exit(failures === 0 ? 0 : 1);
