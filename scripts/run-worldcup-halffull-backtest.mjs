#!/usr/bin/env node
/**
 * 世界杯半全场 leak-safe 回测(轮4):验证轮3发现的 halfRatio≈0.425 是否真比 0.46 提升半全场预测。
 *
 * 方法:197 场有半场比分的世界杯按日期排序,walk-forward——对每场用【严格早于该场】的有 ht 历史
 *   估计全局总进球 λ_total 与数据 halfRatio(历史半场进球占比),中立场分摊 λH=λA=λ_total/2
 *   (无球队信息,但两个 halfRatio 用同一 λ → 公平对比 halfRatio 本身)。
 *   用生产函数 halfFullProbsFromLambdas 算九宫格,比 固定0.46 vs 数据值 对实际 HT/FT 的 LogLoss。
 *
 * 遵 feedback-no-fabrication-live-only / 轮2轮3教训:描述统计差异≠预测增益,以净 LogLoss 定夺是否接入。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";

const lbl = (h, a) => (h > a ? "主胜" : h === a ? "平局" : "客胜");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function collect() {
  const rows = [];
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result || f.result.halfHome == null) continue;
      const r = f.result;
      rows.push({ date: f.date, htH: r.halfHome, htA: r.halfAway, ftH: r.home, ftA: r.away, ftTot: r.home + r.away, htTot: r.halfHome + r.halfAway });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function main() {
  const rows = collect();
  if (rows.length < 60) { console.log(`半场样本仅 ${rows.length} 场,不足以回测`); return; }
  const MIN_HIST = 40;
  const ll = { fixed: [], data: [] };
  const hit = { fixed: 0, data: 0 };
  let n = 0, skipped = 0;
  const ratios = [];

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const hist = rows.filter((r) => r.date < cur.date);
    if (hist.length < MIN_HIST) { skipped++; continue; }
    const lamTot = mean(hist.map((r) => r.ftTot));
    const ratioData = hist.reduce((s, r) => s + r.htTot, 0) / hist.reduce((s, r) => s + r.ftTot, 0);
    ratios.push(ratioData);
    const lamH = lamTot / 2, lamA = lamTot / 2;
    const actual = `${lbl(cur.htH, cur.htA)}-${lbl(cur.ftH, cur.ftA)}`;
    n++;
    for (const [tag, ratio] of [["fixed", 0.46], ["data", ratioData]]) {
      const probs = halfFullProbsFromLambdas(lamH, lamA, ratio);
      const p = Math.max(probs[actual] ?? 0, 1e-9);
      ll[tag].push(-Math.log(p));
      const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
      if (best === actual) hit[tag]++;
    }
  }

  console.log("=== 世界杯半全场 leak-safe 回测(halfRatio 0.46 vs 数据值)===");
  console.log(`测试 ${n} 场 | 跳过(历史<${MIN_HIST})${skipped} | 用到的数据 halfRatio 均值 ${mean(ratios).toFixed(4)}`);
  console.log("");
  console.log(`               LogLoss     九宫格argmax命中`);
  console.log(`halfRatio=0.46  ${mean(ll.fixed).toFixed(4)}      ${(hit.fixed / n * 100).toFixed(1)}%`);
  console.log(`halfRatio=数据  ${mean(ll.data).toFixed(4)}      ${(hit.data / n * 100).toFixed(1)}%`);
  const imp = mean(ll.fixed) - mean(ll.data);
  console.log("");
  console.log(`净 LogLoss 改善(数据 vs 0.46): ${imp > 0 ? "✅ -" : imp < 0 ? "❌ +" : ""}${Math.abs(imp).toFixed(4)}`);
  console.log(imp > 0.002
    ? "→ 数据 halfRatio 有真净增益,值得给世界杯路径接专用 halfRatio。"
    : imp < -0.002
      ? "→ 数据 halfRatio 反而更差,保留 0.46 不改。"
      : "→ 改善在噪声内(<0.002),halfRatio 差异真实但对半全场预测无显著净增益,保留 0.46 不改(遵诚实=没增益不改)。");
}

main();
