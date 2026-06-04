#!/usr/bin/env node
/**
 * 世界杯大Elo差「过度自信」收缩 — leak-safe 时间切分净增益回测。
 *
 * 动机(run-worldcup-elo-calibration.mjs 实测):favorite 在大 Elo 差时跑不出 Elo 期望
 *   150-250 差:实际 71.7% vs 期望 76.0%(-4.3pp);250+ 差:76.6% vs 84.9%(-8.3pp)。
 *   = logistic 在尾部太陡(过度自信)。单一 scale 修不了(会伤小差桶),故试桶级尾部收缩。
 *
 * 防过拟合(32 个 250+ 样本极易过拟):严格时间切分。
 *   - Elo 本身 walk-forward(只用过去),leak-safe。
 *   - 收缩系数 k 仅在【前 60% 时间样本】上按桶最小化 Brier 推导(DERIVE 段)。
 *   - 在【后 40% 时间样本】上严格 out-of-sample 评估 baseline vs 收缩(EVAL 段)。
 *   - 若 OOS Brier 不降 / wld 命中不升 → 诚实 SKIP(遵 feedback-hitrate-closed-loop)。
 *
 * We' = 0.5 + (We-0.5)*k_bucket。只动 |d|>=150 的桶,小差桶 k=1(不碰已校准段)。
 * wld:用 We + 经验平局率(与 world-cup-priors 同族)拆 P(强胜)/P(平)/P(弱胜)做 3-类 Brier。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

function collect() {
  const rows = [];
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result) continue;
      rows.push({ date: f.date, home: f.homeTeam, away: f.awayTeam, hg: f.result.home, ag: f.result.away });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// 经验平局率(按 |Elo差| 收缩,均势≈0.30、悬殊≈0.10) — 与 world-cup-priors 同族近似
function drawRate(diff) {
  const t = Math.min(diff, 600) / 600; // 0..1
  return 0.30 - 0.20 * t; // 0.30 → 0.10
}

// We(强队期望分) + 平局率 → (pStrongWin, pDraw, pWeakWin)
function wld(we, diff) {
  const pd = drawRate(diff);
  // we = pWin + 0.5*pDraw  →  pWin = we - 0.5*pd ; pLoss = 1 - pWin - pd
  let pWin = we - 0.5 * pd;
  let pLoss = 1 - pWin - pd;
  // 数值兜底
  pWin = Math.max(1e-4, pWin); pLoss = Math.max(1e-4, pLoss);
  const s = pWin + pd + pLoss;
  return [pWin / s, pd / s, pLoss / s];
}

function brier3(p, outcome) { // outcome: 0=strongWin,1=draw,2=weakWin
  const y = [0, 0, 0]; y[outcome] = 1;
  return (p[0] - y[0]) ** 2 + (p[1] - y[1]) ** 2 + (p[2] - y[2]) ** 2;
}

function main() {
  const rows = collect();
  const K = 40, BURNIN = 128;
  const elo = {}; const getElo = (t) => (elo[t] ?? 1500);
  const samples = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const we = 1 / (Math.pow(10, -(eh - ea) / 400) + 1);
    if (i >= BURNIN) {
      const diff = Math.abs(eh - ea);
      const homeStrong = eh >= ea;
      const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      const strongScore = homeStrong ? sH : 1 - sH;
      // 3-类结果(强/平/弱)
      const outcome = sH === 0.5 ? 1 : (homeStrong ? (sH === 1 ? 0 : 2) : (sH === 1 ? 2 : 0));
      const weStrong = homeStrong ? we : 1 - we;
      samples.push({ date: m.date, diff, strongScore, outcome, weStrong });
    }
    const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    elo[m.home] = eh + K * (sH - we);
    elo[m.away] = ea + K * ((1 - sH) - (1 - we));
  }

  const n = samples.length;
  const cut = Math.floor(n * 0.6);
  const train = samples.slice(0, cut), test = samples.slice(cut);
  console.log(`=== 大Elo差尾部收缩 — leak-safe 时间切分回测 ===`);
  console.log(`样本 n=${n}(burn-in ${BURNIN});DERIVE 前60%=${train.length} 场 | EVAL 后40%=${test.length} 场\n`);

  // DERIVE:在 train 上,对 |d|>=150 的两桶各扫 k∈[0.5,1.0] 最小化桶内 Brier
  const tailBuckets = [[150, 250], [250, 9999]];
  const kBest = {};
  for (const [lo, hi] of tailBuckets) {
    const b = train.filter((s) => s.diff >= lo && s.diff < hi);
    let best = { k: 1, br: Infinity };
    if (b.length) {
      for (let k = 0.50; k <= 1.001; k += 0.05) {
        let br = 0;
        for (const s of b) {
          const weS = 0.5 + (s.weStrong - 0.5) * k;
          br += brier3(wld(weS, s.diff), s.outcome);
        }
        br /= b.length;
        if (br < best.br) best = { k: +k.toFixed(2), br };
      }
    }
    kBest[lo] = best.k;
    console.log(`DERIVE 桶 ${lo}-${hi === 9999 ? "∞" : hi}(train n=${b.length}):最优收缩 k=${best.k}  (k=1=不收缩)`);
  }
  const kOf = (d) => (d >= 250 ? kBest[250] : d >= 150 ? kBest[150] : 1);

  // EVAL:test 上 baseline(k=1) vs 收缩,3-类 Brier + wld 命中(argmax)
  let brBase = 0, brShr = 0, hitBase = 0, hitShr = 0;
  for (const s of test) {
    const pBase = wld(s.weStrong, s.diff);
    const weS = 0.5 + (s.weStrong - 0.5) * kOf(s.diff);
    const pShr = wld(weS, s.diff);
    brBase += brier3(pBase, s.outcome); brShr += brier3(pShr, s.outcome);
    const am = (p) => p.indexOf(Math.max(...p));
    if (am(pBase) === s.outcome) hitBase++;
    if (am(pShr) === s.outcome) hitShr++;
  }
  const nt = test.length;
  // 仅尾部样本的子集对比(收缩只动尾部,整体会被小差桶稀释)
  const tail = test.filter((s) => s.diff >= 150);
  let brBaseT = 0, brShrT = 0, hitBaseT = 0, hitShrT = 0;
  for (const s of tail) {
    const pBase = wld(s.weStrong, s.diff);
    const pShr = wld(0.5 + (s.weStrong - 0.5) * kOf(s.diff), s.diff);
    brBaseT += brier3(pBase, s.outcome); brShrT += brier3(pShr, s.outcome);
    const am = (p) => p.indexOf(Math.max(...p));
    if (am(pBase) === s.outcome) hitBaseT++;
    if (am(pShr) === s.outcome) hitShrT++;
  }

  console.log(`\n--- EVAL(后40% out-of-sample)---`);
  console.log(`全体 ${nt} 场:`);
  console.log(`  Brier  baseline ${(brBase / nt).toFixed(4)} → 收缩 ${(brShr / nt).toFixed(4)}  (Δ ${((brShr - brBase) / nt >= 0 ? "+" : "")}${((brShr - brBase) / nt).toFixed(4)},负=改善)`);
  console.log(`  wld命中 baseline ${(100 * hitBase / nt).toFixed(1)}% → 收缩 ${(100 * hitShr / nt).toFixed(1)}%  (Δ ${((100 * (hitShr - hitBase) / nt) >= 0 ? "+" : "")}${(100 * (hitShr - hitBase) / nt).toFixed(1)}pp)`);
  if (tail.length) {
    console.log(`尾部子集(|d|>=150,${tail.length} 场,收缩实际作用域):`);
    console.log(`  Brier  baseline ${(brBaseT / tail.length).toFixed(4)} → 收缩 ${(brShrT / tail.length).toFixed(4)}  (Δ ${((brShrT - brBaseT) / tail.length >= 0 ? "+" : "")}${((brShrT - brBaseT) / tail.length).toFixed(4)})`);
    console.log(`  wld命中 baseline ${(100 * hitBaseT / tail.length).toFixed(1)}% → 收缩 ${(100 * hitShrT / tail.length).toFixed(1)}%  (Δ ${((100 * (hitShrT - hitBaseT) / tail.length) >= 0 ? "+" : "")}${(100 * (hitShrT - hitBaseT) / tail.length).toFixed(1)}pp)`);
  }

  const tailGain = tail.length ? (brShrT - brBaseT) / tail.length : 0;
  console.log(`\n裁决:` + (tailGain < -0.002
    ? `尾部 OOS Brier 改善 ${Math.abs(tailGain).toFixed(4)} > 噪声阈 0.002 → 值得接入桶级尾部收缩。`
    : `尾部 OOS Brier 改善 ${(-tailGain).toFixed(4)} ≤ 噪声阈 0.002(32 样本桶,train 拟合不外推)→ 诚实 SKIP,保留纯 Elo。`));
}

main();
