#!/usr/bin/env node
/**
 * 世界杯专项 walk-forward 回测(金字塔验证环·轮2)。
 *
 * 诚实约束(为什么只测阶段情境,不测球队 Elo):
 *  - team-priors.json 是 2026-04 的 FIFA/Elo 快照,拿它预测 2018/2022 世界杯 = 数据泄漏,不做。
 *  - 世界杯样本跨届稀疏(4 年/届,DC 180 天衰减跨届权重≈0),球队 attack/defense 在世界杯上学不稳。
 *  → 真正 leak-safe 且数据可行的验证 = 阶段情境效应(淘汰赛低进球/高平局,不依赖球队身份)。
 *    验证 world-cup-priors 阶段乘子的核心假设:分阶段建模能否比全局单一建模更准地预测
 *    大小球(over2.5)/ 90分钟平局 / 总进球分布。
 *
 * 方法:按日期排序历届世界杯赛果,对每场用【严格早于该场日期】的历史算两套基准:
 *   global  = 全部历史的平均总进球 λ_total、平均平局率
 *   stage   = 该场所属阶段(group/knockout)历史的 λ_total、平局率
 * 用泊松(λ_total)预测 over2.5,用历史频率预测平局,Brier 对比。
 * 遵 feedback-no-fabrication-live-only:只用真实回填赛果,样本不足的场跳过(不凑数)。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

const KNOCKOUT = new Set(["r16", "qf", "sf", "third", "final", "knockout"]);
const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const poissonP = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / fact(k);
const pOver = (lam, line) => { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += poissonP(k, lam); return 1 - c; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function collect() {
  const rows = [];
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result) continue;
      const tot = f.result.home + f.result.away;
      rows.push({
        date: f.date,
        cat: KNOCKOUT.has(f.round) ? "knockout" : "group",
        tot,
        over25: tot > 2.5 ? 1 : 0,
        draw90: f.result.home === f.result.away ? 1 : 0,
      });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function main() {
  const rows = collect();
  if (rows.length < 80) { console.log("世界杯样本不足,先跑 backfill-worldcup-history.mjs"); return; }

  const MIN_HIST = 64, MIN_STAGE = 16; // 至少 1 届全量 / 阶段够样本才预测,否则跳过(不凑数)
  const acc = {
    n: 0, skipped: 0,
    overG: [], overS: [],     // over2.5 Brier 累加
    drawG: [], drawS: [],     // 平局 Brier
    totMaeG: [], totMaeS: [], // 总进球 |λ-实际|
  };

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const hist = rows.filter((r) => r.date < cur.date);
    const hStage = hist.filter((r) => r.cat === cur.cat);
    if (hist.length < MIN_HIST || hStage.length < MIN_STAGE) { acc.skipped++; continue; }

    const lamG = mean(hist.map((r) => r.tot));
    const drawRG = mean(hist.map((r) => r.draw90));
    const lamS = mean(hStage.map((r) => r.tot));
    const drawRS = mean(hStage.map((r) => r.draw90));

    acc.n++;
    acc.overG.push((pOver(lamG, 2.5) - cur.over25) ** 2);
    acc.overS.push((pOver(lamS, 2.5) - cur.over25) ** 2);
    acc.drawG.push((drawRG - cur.draw90) ** 2);
    acc.drawS.push((drawRS - cur.draw90) ** 2);
    acc.totMaeG.push(Math.abs(lamG - cur.tot));
    acc.totMaeS.push(Math.abs(lamS - cur.tot));
  }

  const r = (x) => (x == null ? "—" : x.toFixed(4));
  console.log("=== 世界杯专项 walk-forward 回测(阶段情境,leak-safe)===");
  console.log(`测试场次 ${acc.n} | 跳过(历史不足)${acc.skipped} | 共 ${rows.length} 场`);
  console.log("");
  console.log("指标(越低越好)      全局单一    分阶段     改善");
  const line = (label, g, s) => {
    const mg = mean(g), ms = mean(s);
    const imp = mg != null && ms != null ? (mg - ms) : null;
    const sign = imp != null ? (imp > 0 ? "✅ -" : imp < 0 ? "❌ +" : "  ") : "";
    console.log(`${label.padEnd(20)} ${r(mg).padEnd(11)} ${r(ms).padEnd(10)} ${sign}${imp != null ? Math.abs(imp).toFixed(4) : "—"}`);
  };
  line("over2.5 Brier", acc.overG, acc.overS);
  line("平局 Brier", acc.drawG, acc.drawS);
  line("总进球 MAE", acc.totMaeG, acc.totMaeS);
  console.log("\n诚实裁决:分阶段(stage-aware)Brier/MAE 低于全局单一 = 阶段乘子方向被 leak-safe 回测证实有净增益;");
  console.log("若改善在噪声内(<~0.002),说明阶段信号真实但量级小(符合'情境效应小、球队强度才是大头'的预期)。");
}

main();
