#!/usr/bin/env node
/**
 * 世界杯 Elo 预测力 leak-safe 回测(轮5,转向后第一刀)。
 * 核心问题:模型把"球队 Elo 强度"当世界杯真 edge(轮2-4 证情境微调无用)。Elo 方法在世界杯历史上
 *   到底有没有预测力?这次能做真 leak-safe:从历史赛果【自训练】Elo(只用过去比赛更新),
 *   完全不碰 2026 team-priors 数值 → 无泄漏。复用生产 eloExpectation 公式,验证的就是生产逻辑本身。
 *
 * 方法:552 场历届世界杯按时间排序,所有队初始 Elo=1500,K=40,中立场(无主场优势)。
 *   walk-forward:每场先用【当前】Elo 经 eloExpectation 出 wld 预测,再用真实结果更新 Elo。
 *   前 BURNIN 场只更新不评估(Elo 未收敛)。对照基线=截止当前的历史边际频率(leak-safe)。
 * 遵 feedback-no-fabrication-live-only:只用真实赛果;没预测力就如实说。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { eloExpectation } from "../src/world-cup-priors.js";

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
  if (rows.length < 200) { console.log(`世界杯样本 ${rows.length} 场,不足`); return; }
  const K = 40, BURNIN = 128;
  const elo = {};
  const getElo = (t) => (elo[t] ?? 1500);
  const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");

  let n = 0, hitElo = 0, hitBase = 0, brierElo = 0, brierBase = 0, discrN = 0, discr = 0;
  const histCount = { home: 0, draw: 0, away: 0 };

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const exp = eloExpectation(eh, ea, 0); // 中立场
    const actual = oc(m.hg, m.ag);
    // 基线:截止当前的历史边际频率(leak-safe)
    const tot = histCount.home + histCount.draw + histCount.away || 1;
    const base = { home: histCount.home / tot, draw: histCount.draw / tot, away: histCount.away / tot };

    if (i >= BURNIN) {
      n++;
      const predElo = ["home", "draw", "away"].sort((a, b) => exp[b] - exp[a])[0];
      const predBase = ["home", "draw", "away"].sort((a, b) => base[b] - base[a])[0];
      if (predElo === actual) hitElo++;
      if (predBase === actual) hitBase++;
      for (const k of ["home", "draw", "away"]) {
        brierElo += (exp[k] - (actual === k ? 1 : 0)) ** 2;
        brierBase += (base[k] - (actual === k ? 1 : 0)) ** 2;
      }
      if (m.hg !== m.ag) { discrN++; if ((eh > ea) === (m.hg > m.ag)) discr++; }
    }
    // 更新 Elo(标准,中立)
    const scoreH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const we = exp.homeWinExpectancy;
    elo[m.home] = eh + K * (scoreH - we);
    elo[m.away] = ea + K * ((1 - scoreH) - (1 - we));
    histCount[actual]++;
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log("=== 世界杯 Elo 预测力 leak-safe 回测(自训练 Elo)===");
  console.log(`评估 ${n} 场(前 ${BURNIN} 场 burn-in)| 共 ${rows.length} 场`);
  console.log("");
  console.log(`               胜平负命中    三分类Brier(均场)`);
  console.log(`Elo 自训练     ${pct(hitElo / n).padEnd(12)} ${(brierElo / n).toFixed(4)}`);
  console.log(`边际频率基线   ${pct(hitBase / n).padEnd(12)} ${(brierBase / n).toFixed(4)}`);
  console.log("");
  console.log(`判别力(非平局场中 Elo 高者实际获胜): ${pct(discr / discrN)}(n=${discrN})`);
  const hitImp = (hitElo - hitBase) / n, brierImp = (brierBase - brierElo) / n;
  console.log("");
  console.log(`Elo vs 基线: 命中 ${hitImp >= 0 ? "+" : ""}${(hitImp * 100).toFixed(1)}pp | Brier ${brierImp >= 0 ? "✅ -" : "❌ +"}${Math.abs(brierImp).toFixed(4)}`);
  console.log(discr / discrN > 0.58
    ? "→ Elo 在世界杯有真实判别力,模型'真edge在球队Elo'的方向被 leak-safe 证实。"
    : "→ Elo 判别力有限,世界杯冷门多(单场样本小、爆冷常态),Elo 先验只能作温和参考、不可重仓。");
}

main();
