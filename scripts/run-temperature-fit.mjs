#!/usr/bin/env node
// 温度校准:从 walk-forward 收集生产模型融合后概率,按时间 70/30 切分
// (前70%拟合 T、后30%验证,防泄漏),对比 T=1 vs 拟合 T 的 Brier/命中/强热门偏差。
// 诚实:温度缩放是单调变换,不改 argmax → 命中率几乎不变;它治的是过度自信(Brier/置信度)。
// 仅当 held-out Brier 真改善且命中不掉时,加 --apply 把 T 写进 profile。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectFusionSamples } from "../src/walkforward-backtest.js";
import { fitTemperature, applyTemperature } from "../src/temperature-calibration.js";
import { getExportDir } from "../src/paths.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };
const apply = args.includes("--apply");

const OUTCOMES = ["home", "draw", "away"];
const codeKey = { "3": "home", "1": "draw", "0": "away" };
function brier(p, actualCode) { return OUTCOMES.reduce((s, o) => s + (p[o] - (codeKey[actualCode] === o ? 1 : 0)) ** 2, 0); }
function isHit(p, actualCode) { const top = OUTCOMES.reduce((a, b) => (p[b] > p[a] ? b : a), "home"); return top === codeKey[actualCode]; }
function evalSet(samples, T) {
  let b = 0, hit = 0, favN = 0, favPredSum = 0, favHit = 0;
  for (const s of samples) {
    const p = T === 1 ? s.probabilities : applyTemperature(s.probabilities, T);
    b += brier(p, s.actual);
    const h = isHit(p, s.actual);
    if (h) hit++;
    const top = Math.max(p.home, p.draw, p.away);
    if (top >= 0.65) { favN++; favPredSum += top; if (h) favHit++; }
  }
  const n = samples.length || 1;
  return {
    n: samples.length, brier: +(b / n).toFixed(4), hit: +(hit / n).toFixed(4),
    favN, favPred: favN ? +(favPredSum / favN).toFixed(4) : null,
    favActual: favN ? +(favHit / favN).toFixed(4) : null,
    favBias: favN ? +((favHit / favN) - (favPredSum / favN)).toFixed(4) : null
  };
}

// 生产 profile(disabledSignals/signalWeights),让校准对齐真实生产模型
let fusionOpts = {};
const profPath = join(getExportDir(), "fusion-signal-weights.json");
if (existsSync(profPath)) {
  try { const pr = JSON.parse(readFileSync(profPath, "utf8")); if (pr?.usable) fusionOpts = { signalWeights: pr.signalWeights, disabledSignals: pr.disabledSignals }; } catch {}
}

console.log("收集融合后样本中(应用生产 profile)...");
const samples = collectFusionSamples({ testDates: getNum("--test-dates", 50), fusionOpts });
const cut = Math.floor(samples.length * 0.7);
const train = samples.slice(0, cut);
const test = samples.slice(cut);
console.log(`样本 ${samples.length}(按日期升序):拟合 ${train.length} / 验证 ${test.length}`);

const fit = fitTemperature(train, { minSamples: 30 });
console.log(`\n拟合(训练集):${JSON.stringify(fit)}`);
if (!fit.ok) { console.log("样本不足,放弃。"); process.exit(0); }

const T = fit.temperature;
const base = evalSet(test, 1);
const cal = evalSet(test, T);
console.log(`\n=== 验证集(held-out ${test.length} 场)T=1 vs T=${T} ===`);
console.log("指标            T=1        T=" + T);
console.log(`Brier          ${base.brier}     ${cal.brier}     (${(cal.brier - base.brier).toFixed(4)})`);
console.log(`命中率          ${(base.hit * 100).toFixed(1)}%      ${(cal.hit * 100).toFixed(1)}%      (${((cal.hit - base.hit) * 100).toFixed(2)}pp)`);
console.log(`65%+ 强热门     n=${base.favN} 预测${base.favPred} 实际${base.favActual} 偏差${base.favBias}`);
console.log(`  →温度后       n=${cal.favN} 预测${cal.favPred} 实际${cal.favActual} 偏差${cal.favBias}`);

const brierImproves = cal.brier < base.brier - 1e-9;
const hitNotWorse = cal.hit >= base.hit - 1e-9;
console.log(`\n裁决:Brier ${brierImproves ? "改善✅" : "未改善"} / 命中 ${hitNotWorse ? "未掉✅" : "下降⚠️"}`);

if (apply) {
  if (!(brierImproves && hitNotWorse)) { console.log("\n⚠️ 未同时满足(Brier改善且命中不掉),不写 T(保持现状)。"); process.exit(0); }
  let profile = {};
  if (existsSync(profPath)) { try { profile = JSON.parse(readFileSync(profPath, "utf8")); } catch {} }
  profile.temperature = T;
  profile.temperatureFit = { trainN: train.length, testN: test.length, brierBefore: base.brier, brierAfter: cal.brier, favBiasBefore: base.favBias, favBiasAfter: cal.favBias, diagnosis: fit.diagnosis };
  mkdirSync(getExportDir(), { recursive: true });
  writeFileSync(profPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  console.log(`\n✅ 已写 temperature=${T} → ${profPath}`);
} else {
  console.log("\n(只读;加 --apply 在 Brier 改善且命中不掉时写 T)");
}
