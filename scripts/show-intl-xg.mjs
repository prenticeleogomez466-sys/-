#!/usr/bin/env node
/**
 * 国家队事件级 xG 画像 × Elo 交叉核 — 把 StatsBomb xG 强度与本模型 Elo 排名对照,
 * 标出【事件级表现与 Elo/市场分歧】的队(潜在被高估/低估)。纯分析/交叉验证,非下注信号。
 *
 * 用法: node scripts/show-intl-xg.mjs
 */
import { loadIntlXg, teamXgProfile, hasIntlXg } from "../src/statsbomb-xg-source.js";
import { teamPrior } from "../src/world-cup-priors.js";

function main() {
  if (!hasIntlXg()) {
    console.log("无 xG 数据:先跑 python scripts/sb_fetch_intl_xg.py 生成 intl-team-xg-summary.json");
    return;
  }
  const { teams, source, asOf } = loadIntlXg();
  const names = Object.keys(teams);
  console.log(`══════ 国家队事件级 xG 画像(${source}, asOf ${asOf}, ${names.length} 队)══════\n`);

  // 按净 xG/场排名(事件级强度)
  const ranked = names.map((t) => ({ t, ...teams[t] })).sort((a, b) => b.xgDiffPerGame - a.xgDiffPerGame);
  console.log("净xG/场 强度榜(前16):");
  console.log("排名 队            净xG   攻xG  防xG  临门  场次");
  ranked.slice(0, 16).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}  ${r.t.padEnd(14)} ${r.xgDiffPerGame >= 0 ? "+" : ""}${r.xgDiffPerGame.toFixed(2)}  ${r.xgForPerGame.toFixed(2)}  ${r.xgAgainstPerGame.toFixed(2)}  ${r.finishingPerGame >= 0 ? "+" : ""}${r.finishingPerGame.toFixed(2)}  ${r.matches}`);
  });

  // 临门质量极端:过度依赖运气/把握差(finishing 偏离 0)
  const byFin = [...ranked].filter((r) => r.matches >= 4).sort((a, b) => b.finishingPerGame - a.finishingPerGame);
  console.log("\n临门质量(实际进球−期望进球/场,≥4场):");
  console.log("  最克制高效(把握/运气好):", byFin.slice(0, 3).map((r) => `${r.t} ${r.finishingPerGame >= 0 ? "+" : ""}${r.finishingPerGame.toFixed(2)}`).join("  "));
  console.log("  最浪费机会(把握差/背运):", byFin.slice(-3).reverse().map((r) => `${r.t} ${r.finishingPerGame.toFixed(2)}`).join("  "));

  // 与 Elo 交叉核:xG 强度排名 vs Elo 排名,标分歧
  const withElo = ranked.map((r) => {
    const p = teamPrior(r.t) || teamPrior(zhOf(r.t));
    return { ...r, elo: p?.elo ?? null };
  }).filter((r) => r.elo);
  if (withElo.length >= 6) {
    const xgRank = new Map(withElo.slice().sort((a, b) => b.xgDiffPerGame - a.xgDiffPerGame).map((r, i) => [r.t, i + 1]));
    const eloRank = new Map(withElo.slice().sort((a, b) => b.elo - a.elo).map((r, i) => [r.t, i + 1]));
    const div = withElo.map((r) => ({ t: r.t, elo: r.elo, dx: eloRank.get(r.t) - xgRank.get(r.t) }))
      .sort((a, b) => b.dx - a.dx);
    console.log("\nxG 强度 vs Elo 分歧(Δ=Elo排名−xG排名;正=xG比Elo更看好,潜在被低估):");
    div.slice(0, 3).forEach((r) => console.log(`  事件级更看好: ${r.t}(Elo ${r.elo}, 排名差 +${r.dx})`));
    div.slice(-3).reverse().forEach((r) => console.log(`  事件级更看衰: ${r.t}(Elo ${r.elo}, 排名差 ${r.dx})`));
  }
  console.log("\n诚实:每队仅 3-7 场/届=小样本,事件级 xG 是独立于赔率的真实信号但不单独保证命中率;");
  console.log("  定位=补国家队 xG 事件级缺口作分析/先验交叉核,与 Elo 分歧大处=值得人工复核,非自动下注。");
}

// 极简英文→中文(供 teamPrior 查 elo;teamPrior 同时接受中英,多数直接命中)
function zhOf(en) {
  const M = { Spain: "西班牙", France: "法国", Argentina: "阿根廷", England: "英格兰", Brazil: "巴西", Portugal: "葡萄牙", Germany: "德国", Netherlands: "荷兰", Belgium: "比利时", Croatia: "克罗地亚", Morocco: "摩洛哥", Japan: "日本", Mexico: "墨西哥", Switzerland: "瑞士", Senegal: "塞内加尔", "South Korea": "韩国", "United States": "美国", Uruguay: "乌拉圭", Australia: "澳大利亚", Canada: "加拿大", Ecuador: "厄瓜多尔" };
  return M[en] || en;
}
main();
