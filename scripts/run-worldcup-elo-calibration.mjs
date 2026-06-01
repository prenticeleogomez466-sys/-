#!/usr/bin/env node
/**
 * Elo→胜率映射校准曲线(轮18,leak-safe)。验证 eloExpectation 的标准 scale=400 在国际赛是否最优:
 *   按 Elo 差分桶,比每桶【实际积分率(强队胜+0.5平)/n】vs【Elo 期望 1/(1+10^(-d/400))】。
 *   并扫 scale∈{300,400,500} 看哪个总校准误差最小。有显著更优 scale 才考虑(否则保留 400)。
 * 自训练 Elo(K=40 中立)leak-safe;遵 feedback-hitrate-closed-loop:有数据支撑才动,无则保留。
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

function main() {
  const rows = collect();
  const K = 40, BURNIN = 128;
  const elo = {}; const getElo = (t) => (elo[t] ?? 1500);
  // 收集 (diff=强队-弱队 Elo, score=强队积分 1/0.5/0)
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
      samples.push({ diff, strongScore });
    }
    const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    elo[m.home] = eh + K * (sH - we);
    elo[m.away] = ea + K * ((1 - sH) - (1 - we));
  }

  console.log("=== Elo→胜率校准曲线(世界杯,leak-safe,n=" + samples.length + ")===");
  const buckets = [[0, 50], [50, 100], [100, 150], [150, 250], [250, 9999]];
  console.log("Elo差桶      n    实际积分率  Elo期望(400)  差");
  for (const [lo, hi] of buckets) {
    const b = samples.filter((s) => s.diff >= lo && s.diff < hi);
    if (!b.length) continue;
    const act = b.reduce((a, x) => a + x.strongScore, 0) / b.length;
    const mid = (lo + Math.min(hi, lo + 100)) / 2;
    const pred = 1 / (Math.pow(10, -mid / 400) + 1);
    console.log(`${(lo + "-" + (hi === 9999 ? "∞" : hi)).padEnd(11)} ${String(b.length).padEnd(4)} ${(act * 100).toFixed(1).padEnd(10)}% ${(pred * 100).toFixed(1)}%        ${((act - pred) * 100 >= 0 ? "+" : "")}${((act - pred) * 100).toFixed(1)}pp`);
  }
  // 扫 scale:总校准误差(实际积分率 vs 各 scale 期望,按样本 diff 逐场)
  console.log("\nscale 扫描(逐场 |实际−期望| 平均,越低越校准):");
  for (const scale of [300, 350, 400, 450, 500]) {
    let err = 0;
    for (const s of samples) { const p = 1 / (Math.pow(10, -s.diff / scale) + 1); err += Math.abs(s.strongScore - p); }
    console.log(`  scale=${scale}: MAE ${(err / samples.length).toFixed(4)}`);
  }
  console.log("\n诚实:MAE 含单场 0/0.5/1 离散噪声(不可能为0);看哪个 scale 最低 + 与 400 差多少决定是否调。");
}

main();
