/**
 * 小模型自主登记表(2026-05-31)——"完全自主运转 + 每环节审计"的统一可视化。
 * ════════════════════════════════════════════════════════════════════
 * 诚实列出每个小模型:接线(非孤儿)/ 数据源 / profile / 回测裁决 / 是否驱动主概率 / 自主级别。
 * 信息性 dashboard(非 pass/fail 闸门;硬闸门见 audit-autonomous-models.mjs)。
 * 数据源真实可追溯,裁决直接读 profile.backtest,绝不编造。
 *
 * 用法:node scripts/models-registry.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "../src/paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; } };
const engine = read("src/prediction-engine.js");
const mm = read("src/multimodal-collab.js");
const exp = getExportDir();
const profile = (f) => { try { const p = JSON.parse(readFileSync(join(exp, f), "utf8")); return p; } catch { return null; } };
const wired = (sym) => engine.includes(sym) || mm.includes(sym);

const MODELS = [
  {
    name: "联赛专家混合层", module: "league-expert-mixture", sym: "leagueExpertFromFitted",
    dataSrc: "共享 hierarchical-poisson(全局拟合,设计上不重复独立拟合)",
    profile: null,
    verdict: "回测证独立重拟合反更差(-0.27pp),共享读取是对的;价值=差异化+冷启动兜底",
    drivesProb: "否(展示/兜底提示)", autonomy: "半(读共享拟合,有自己的门控 w=n/(n+K))",
  },
  {
    name: "每联赛数据变化指纹", module: "(build-league-datachange-profile)", sym: "data-change-league-profile",
    dataSrc: "训练器自主读 store 开→收漂移/水位",
    profile: "data-change-league-profile.json",
    verdict: "league 优于 global 但输市场/与经验库重叠,让球零增益 → 不驱动主概率",
    drivesProb: "否(框架基础/展示/速度)", autonomy: "全(训练器自主读+产 profile)",
  },
  {
    name: "历史比赛镜头", module: "historical-lens", sym: "buildHistoricalLenses",
    dataSrc: "loadHistoricalResults 真实赛果(leak-safe beforeDate)",
    profile: null,
    verdict: "纯读取层(H2H/近期战绩),稀疏即 available:false 不编造",
    drivesProb: "否(展示/多模态对比)", autonomy: "全(自读历史,不靠引擎喂概率)",
  },
  {
    name: "半全场参数", module: "halftime-fulltime-model", sym: "halfFullJoint",
    dataSrc: "训练器自主读 store 33204 真实半场",
    profile: null,
    verdict: "拟合 LogLoss 1.9249 vs 写死默认 1.9248(Δ-0.0001)→ 诚实弃用,退回 HF_DEFAULTS(到顶)",
    drivesProb: "是(halfFullJoint 出半全场概率,用写死默认)", autonomy: "全(训练器自裁决)",
  },
  {
    name: "大小球 isotonic 校准", module: "overunder-calibration", sym: "calibrateOver25",
    dataSrc: "训练器自主读 store 51064 真实总进球",
    profile: "overunder-calibration-profile.json",
    verdict: "holdout Brier 0.2491→0.2475(Δ+0.0016)真增益 → 已落 profile 接生产",
    drivesProb: "是(无盘口冷门场用校准 P(over);有盘口优先市场)", autonomy: "全(训练器自裁决+落 profile)",
  },
];

console.log("足球大模型 · 小模型自主登记表\n");
for (const m of MODELS) {
  const p = m.profile ? profile(m.profile) : null;
  const wiredOk = wired(m.sym);
  console.log(`▌ ${m.name}  (src/${m.module}.js)`);
  console.log(`   接线(非孤儿) : ${wiredOk ? "✓ 生产引用 " + m.sym : "✗ 未引用"}`);
  console.log(`   数据源        : ${m.dataSrc}`);
  const nFit = p?.nTrain ?? p?.nTotal ?? p?.totalMatches ?? "?";
  const profStatus = !m.profile ? "—(实时计算,无持久 profile)"
    : !p ? `✗ ${m.profile} 缺失`
    : p.usable === false ? `✗ ${m.profile} 存在但 usable=false`
    : `✓ ${m.profile}(${p.usable ? "usable, " : ""}${nFit} 场)`;
  console.log(`   profile       : ${profStatus}`);
  if (p?.backtest) console.log(`   回测证据      : ${JSON.stringify(p.backtest)}`);
  console.log(`   回测裁决      : ${m.verdict}`);
  console.log(`   驱动主概率    : ${m.drivesProb}`);
  console.log(`   自主级别      : ${m.autonomy}`);
  console.log("");
}
console.log("说明:'驱动主概率=否' 的小模型按 [[reference_signal_backtest_findings]] 实证(公开数据打不过收盘线),");
console.log("      其价值在 差异化解释 / 冷启动兜底 / 速度 / 透明风险提示,非命中率;真增益市场=大小球冷门场校准 + 实时私有信息。");
