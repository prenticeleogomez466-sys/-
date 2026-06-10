#!/usr/bin/env node
// 全自动自调优闭环(命中率优化闭环⑤的编排)。
// 顺序:①基线回测 → ②逐信号消融诊断 → ③权重搜索(--apply,仅变好才写)→ ⑤复测确认。
// 每个 --apply 子步都自带「只在变好时才写 profile」护栏,故整条 loop 安全幂等:
// 不会因为某轮数据噪声把模型改差。建议每周由 auto:weekly 调用一次。
//
// ⚠️ 原 step④ 温度校准已删(缺陷#19,2026-06-10):温度软化层 2026-05-31 按删兜底铁律
//   从 prediction-engine 有意删除(见 prediction-engine.js 内说明注释),生产无任何消费点。
//   此前每周仍拟合并写 profile.temperature + 日志打"✅已写",制造温度层在线的假象。
//   铁律:绝不把 temperature 接回消费点,也绝不把本步加回来。
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const passthru = process.argv.slice(2); // 透传 --test-dates 等

function step(title, script, extra = []) {
  console.log(`\n${"=".repeat(60)}\n▶ ${title}\n${"=".repeat(60)}`);
  try {
    const out = execFileSync(node, [join(here, script), ...passthru, ...extra], { encoding: "utf8", stdio: "pipe" });
    process.stdout.write(out);
    return { title, ok: true };
  } catch (err) {
    process.stdout.write(err.stdout ?? "");
    process.stderr.write(err.stderr ?? "");
    console.log(`⚠️ ${title} 失败(继续后续步骤): ${err.message}`);
    return { title, ok: false, error: err.message };
  }
}

console.log("足球大模型自调优闭环启动(optimize:loop)——数据驱动,只在回测变好时才改。");
const results = [];
results.push(step("① 基线 walk-forward 回测", "run-walkforward-backtest.mjs"));
results.push(step("② 逐信号消融诊断", "run-signal-ablation.mjs"));
results.push(step("③ 权重搜索(变好则写 profile)", "run-weight-search.mjs", ["--apply"]));
results.push(step("⑤ 复测确认(应用新 profile 后)", "run-walkforward-backtest.mjs"));
results.push(step("⑥ 刷新联赛可信度 profile", "build-league-reliability.mjs"));

console.log(`\n${"=".repeat(60)}\n自调优闭环完成。步骤结果:`);
for (const r of results) console.log(`  ${r.ok ? "✅" : "⚠️"} ${r.title}${r.ok ? "" : " — " + r.error}`);
const failed = results.filter((r) => !r.ok);
process.exit(failed.length && failed.every((r) => r.title.startsWith("③")) ? 0 : failed.length ? 1 : 0);
