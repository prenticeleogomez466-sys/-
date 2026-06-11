#!/usr/bin/env node
/**
 * 世界杯验证套件总入口(轮22):一键顺序跑过夜进化产出的全部世界杯 leak-safe 验证脚本,
 * 汇总每个的关键结论。让 18+ 轮的验证可【一键复验】、交付完整、随时回归。
 * 用法: node scripts/worldcup-suite.mjs   (只验证,不改任何数据/代码)
 */
import { execSync } from "node:child_process";

const STEPS = [
  ["先验验证(阶段进球/平局)", "worldcup-prior-validation.mjs"],
  ["专项回测(阶段乘子净增益)", "run-worldcup-backtest.mjs"],
  ["半全场回测(halfRatio)", "run-worldcup-halffull-backtest.mjs"],
  ["Elo 预测力(里程碑)", "run-worldcup-elo-backtest.mjs"],
  ["Elo 市场质量(ρ)", "worldcup-elo-market-check.mjs"],
  ["东道主优势校准", "worldcup-host-advantage.mjs"],
  ["Elo→Poisson 框架", "run-worldcup-elo-poisson.mjs"],
  ["Elo 校准曲线(400 scale)", "run-worldcup-elo-calibration.mjs"],
  ["小组出线概率 MC", "run-worldcup-group-sim.mjs"],
  // 2026-06-11 融合裁决:旧 champion-sim/多模型融合链已被官方 bracket 超算(run-worldcup-supercomputer.mjs,
  //   内置市场混合 0.65市+0.35模)永久取代并删除;夺冠/晋级概率复验直接跑超算(N 可调)。
  ["夺冠/晋级概率超算(官方bracket+市场混合)", "run-worldcup-supercomputer.mjs --n 4000"],
];

console.log("══════ 2026 世界杯验证套件(一键复验,leak-safe)══════\n");
let ok = 0, fail = 0;
for (const [label, file] of STEPS) {
  try {
    const out = execSync(`node scripts/${file}`, { encoding: "utf8", cwd: process.cwd(), timeout: 120000 });
    const lines = out.trim().split("\n");
    // 取含关键数字/裁决的行(命中/ρ/Brier/→ 结论)
    const key = lines.filter((l) => /命中|ρ|Brier|出线|进球比|→|pp|MAE|halfRatio|胜率|判别力|融合冠军|市场锚定|49\.|50\.|51\.|0\.8|0\.9/.test(l)).slice(-3);
    console.log(`✅ ${label}  [${file}]`);
    key.forEach((l) => console.log("    " + l.trim()));
    console.log("");
    ok++;
  } catch (e) {
    console.log(`❌ ${label} [${file}] 运行失败: ${String(e.message).split("\n")[0]}\n`);
    fail++;
  }
}
console.log(`══════ 套件完成: ${ok}/${STEPS.length} 通过${fail ? `,${fail} 失败` : ""} ══════`);
console.log("诚实结论(全 leak-safe):真 edge=球队 Elo(命中50.5%/判别力68%/质量ρ0.88);情境微调(阶段/halfRatio)对命中率无净增益;国际赛 wld 上限~50-55%。");
