#!/usr/bin/env node
// 全自动自调优闭环(命中率优化闭环⑤的编排)。
// 顺序:①基线回测 → ②逐信号消融诊断 → ③权重搜索(--apply,仅变好才写)
//      → ④温度校准(--apply,仅 Brier 改善且命中不掉才写)→ ⑤复测确认。
// 每个 --apply 子步都自带「只在变好时才写 profile」护栏,故整条 loop 安全幂等:
// 不会因为某轮数据噪声把模型改差。建议每周由 auto:weekly 调用一次。
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
results.push(step("④ 温度校准(Brier改善且命中不掉则写 T)", "run-temperature-fit.mjs", ["--apply"]));
results.push(step("⑤ 复测确认(应用新 profile 后)", "run-walkforward-backtest.mjs"));

console.log(`\n${"=".repeat(60)}\n自调优闭环完成。步骤结果:`);
for (const r of results) console.log(`  ${r.ok ? "✅" : "⚠️"} ${r.title}${r.ok ? "" : " — " + r.error}`);
const failed = results.filter((r) => !r.ok);
process.exit(failed.length && failed.every((r) => r.title.startsWith("③") || r.title.startsWith("④")) ? 0 : failed.length ? 1 : 0);
