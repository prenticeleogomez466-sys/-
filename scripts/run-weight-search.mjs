#!/usr/bin/env node
// 融合信号权重搜索:从消融裁决出发,枚举候选权重组合,单遍回测评估,
// 选「命中率最高(平手比 Brier 低)」的写成 production profile。
// 目标:在不恶化 Brier 的前提下提升命中率。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runWeightSearch } from "../src/walkforward-backtest.js";
import { getExportDir } from "../src/paths.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };
const apply = args.includes("--apply"); // 写 profile 才生效;不带只看结果

// 消融裁决(R3):害校准 = home-away-split / time-decay-form / clean-sheet-streak
const HURTS = ["home-away-split", "time-decay-form", "clean-sheet-streak"];
const w = (obj) => obj; // 便捷

const candidates = [
  { name: "baseline(全1)", signalWeights: null },
  { name: "弃3害(disable)", disabledSignals: HURTS },
  { name: "降3害@0.5", signalWeights: w({ "home-away-split": 0.5, "time-decay-form": 0.5, "clean-sheet-streak": 0.5 }) },
  { name: "降3害@0.3", signalWeights: w({ "home-away-split": 0.3, "time-decay-form": 0.3, "clean-sheet-streak": 0.3 }) },
  { name: "仅弃time-decay", disabledSignals: ["time-decay-form"] },
  { name: "弃tdf+csstreak留split", disabledSignals: ["time-decay-form", "clean-sheet-streak"] },
  { name: "留split@0.5,弃另2", signalWeights: w({ "home-away-split": 0.5, "time-decay-form": 0, "clean-sheet-streak": 0 }) },
  { name: "仅helpers(fatigue+h2h)", disabledSignals: ["home-away-split", "time-decay-form", "clean-sheet-streak", "season-phase", "streak", "competition-type"] }
];

console.log("权重搜索回测中(单遍评估所有候选)...");
const res = runWeightSearch(candidates, {
  testDates: getNum("--test-dates", 50),
  minTrainMatches: getNum("--min-train", 200),
  maxDates: getNum("--max-dates", 240)
});

console.log(`\n=== 融合信号权重搜索(测试日 ${res.testDatesUsed} | 场次 ${res.tested})===`);
console.log(`纯 DC 基线:命中 ${(res.dc.accuracy * 100).toFixed(1)}%  Brier ${res.dc.brier}  LogLoss ${res.dc.logLoss}\n`);
console.log("候选                        命中率   Brier    LogLoss   vsDC命中  vsDC-Brier");
const rows = res.candidates.map((c) => ({
  ...c,
  dHit: c.accuracy - res.dc.accuracy,
  dBrier: c.brier - res.dc.brier
}));
for (const c of rows) {
  const f = (v, s = 8) => (v >= 0 ? "+" : "") + String(v).padEnd(s);
  console.log(`${c.name.padEnd(28)}${(c.accuracy * 100).toFixed(1)}%`.padEnd(38) + `${c.brier}`.padEnd(9) + `${c.logLoss}`.padEnd(10) + f((c.dHit * 100).toFixed(2) + "pp") + f(c.dBrier.toFixed(4)));
}

// 选择:命中率最高;平手(±0.000) 比 Brier 低。同时标注是否 Brier ≤ DC。
const best = [...rows].sort((a, b) => (b.accuracy - a.accuracy) || (a.brier - b.brier))[0];
const baseline = rows.find((c) => c.name.startsWith("baseline"));
console.log(`\n最佳候选:${best.name} — 命中 ${(best.accuracy * 100).toFixed(1)}%(vs baseline ${(baseline.accuracy * 100).toFixed(1)}%,vsDC ${(best.dHit * 100).toFixed(2)}pp),Brier ${best.brier}(vsDC ${best.dBrier >= 0 ? "+" : ""}${best.dBrier.toFixed(4)})`);

const beatsBaselineHit = best.accuracy > baseline.accuracy + 1e-9;
const notWorseBrierThanBaseline = best.brier <= baseline.brier + 1e-9;
const verdict = beatsBaselineHit || (Math.abs(best.accuracy - baseline.accuracy) < 1e-9 && best.brier < baseline.brier - 1e-9);

if (apply) {
  if (!verdict) {
    console.log("\n⚠️ 最佳候选未超过 baseline(命中未升且 Brier 未降),不写 profile(保持现状)。");
    process.exit(0);
  }
  const profile = {
    usable: true,
    source: "walk-forward weight search",
    generatedFor: "fusion-layer signals",
    testDatesUsed: res.testDatesUsed,
    tested: res.tested,
    chosen: best.name,
    signalWeights: best.signalWeights ?? {},
    disabledSignals: candidates.find((c) => c.name === best.name)?.disabledSignals ?? [],
    metrics: { accuracy: best.accuracy, brier: best.brier, logLoss: best.logLoss, vsDcHit: best.dHit, vsDcBrier: best.dBrier },
    dcBaseline: { accuracy: res.dc.accuracy, brier: res.dc.brier },
    fusionBaseline: { accuracy: baseline.accuracy, brier: baseline.brier }
  };
  const dir = getExportDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "fusion-signal-weights.json");
  writeFileSync(p, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  console.log(`\n✅ 已写 profile → ${p}`);
} else {
  console.log("\n(只读模式;加 --apply 在确实超过 baseline 时写 production profile)");
}
