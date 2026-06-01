#!/usr/bin/env node
/**
 * 世界杯 Elo 先验质量验证(轮6,无泄漏):48 队 Elo 排序 vs 市场夺冠赔率 vs FIFA 排名 的一致性。
 * 轮5 已 leak-safe 证实 Elo 在历史世界杯有预测力;本轮验证【当前 2026 team-priors 的 Elo 数值质量】——
 * 若 Elo 排序与市场夺冠赔率高度一致(Spearman ρ 高),说明 Elo 先验抓住了市场认可的实力排序。
 * 全部用已落盘的真实数据(eloratings/博彩赔率),纯排序对照,无预测、无泄漏、不编造。
 */
import { readFileSync } from "node:fs";
import { getDataSubdir } from "../src/paths.js";
import { join } from "node:path";

function spearman(rankA, rankB) {
  // rankA/rankB: Map name->rank(1=最强)。同集合。
  const names = [...rankA.keys()];
  const n = names.length;
  let d2 = 0;
  for (const nm of names) { const d = rankA.get(nm) - rankB.get(nm); d2 += d * d; }
  return 1 - (6 * d2) / (n * (n * n - 1));
}
function rankMap(arr, key, asc) {
  // asc=true: 值小=强(odds/fifa_rank);asc=false: 值大=强(elo)
  const sorted = [...arr].sort((x, y) => (asc ? x[key] - y[key] : y[key] - x[key]));
  const m = new Map();
  sorted.forEach((t, i) => m.set(t.name, i + 1));
  return m;
}

function main() {
  const p = join(join(getDataSubdir("world-cup"), "2026"), "team-priors.json");
  const j = JSON.parse(readFileSync(p, "utf8"));
  const teams = j.teams || j;
  const arr = Object.entries(teams).map(([k, v]) => ({ name: v.zh || k, en: v.en, elo: v.elo, odds: v.title_odds, rank: v.fifa_rank }))
    .filter((t) => t.elo && t.odds && t.rank);
  const n = arr.length;

  const rElo = rankMap(arr, "elo", false);
  const rOdds = rankMap(arr, "odds", true);
  const rFifa = rankMap(arr, "rank", true);

  console.log("=== 世界杯 Elo 先验质量验证(48 队,无泄漏排序对照)===");
  console.log(`样本 ${n} 队`);
  console.log("");
  console.log(`Spearman 排序相关 ρ:`);
  console.log(`  Elo  vs 市场夺冠赔率 : ${spearman(rElo, rOdds).toFixed(4)}`);
  console.log(`  Elo  vs FIFA 排名    : ${spearman(rElo, rFifa).toFixed(4)}`);
  console.log(`  市场 vs FIFA 排名    : ${spearman(rOdds, rFifa).toFixed(4)}`);
  console.log("");
  console.log("夺冠热门 Top10(模型 Elo 序)  vs  市场赔率序:");
  const byElo = [...arr].sort((a, b) => b.elo - a.elo).slice(0, 10);
  console.log("  Elo序  球队        Elo   市场赔率序  夺冠赔率");
  byElo.forEach((t, i) => {
    console.log(`  ${String(i + 1).padEnd(6)} ${t.name.padEnd(10)} ${String(t.elo).padEnd(5)} ${String(rOdds.get(t.name)).padEnd(10)} ${t.odds}`);
  });
  // 最大分歧队(Elo序与市场序差最大)
  console.log("\n模型 vs 市场最大分歧 Top5(|Elo序 − 市场序|):");
  const diff = arr.map((t) => ({ ...t, d: Math.abs(rElo.get(t.name) - rOdds.get(t.name)) })).sort((a, b) => b.d - a.d).slice(0, 5);
  diff.forEach((t) => console.log(`  ${t.name.padEnd(10)} Elo序${rElo.get(t.name)} / 市场序${rOdds.get(t.name)} (差${t.d}) — ${rElo.get(t.name) < rOdds.get(t.name) ? "模型更看好" : "市场更看好"}`));
  const rho = spearman(rElo, rOdds);
  console.log("");
  console.log(rho > 0.85 ? "→ Elo 先验与市场高度一致(ρ>0.85),先验数值质量良好,可放心作世界杯实力锚。"
    : rho > 0.7 ? "→ Elo 先验与市场较一致(ρ>0.7),主体可信;分歧队留意(可能市场含 Elo 未反映的伤停/状态)。"
      : "→ Elo 先验与市场分歧较大(ρ<0.7),需核查 Elo 数据源时效。");
}

main();
