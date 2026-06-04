#!/usr/bin/env node
/**
 * 2026 世界杯小组出线概率 Monte-Carlo。
 * 用【真实分组 groups.json】+【48队真实 Elo team-priors】模拟小组赛,算每队出线(前2 + 最佳8个第三)概率。
 * leak-safe/无编造:真实分组 + 当前 Elo 预测未来(正当预测,非泄漏);不碰淘汰赛 bracket(避免编造配对)。
 *
 * 2026-06-04 强化:从"自带 Math.random() 泊松+随机 tiebreaker 的重复实现"改为**复用共享引擎**
 *   tournament-simulator.simulateGroupStage —— seeded(mulberry32 可复现)、真 FIFA tiebreaker(积分→净胜球→
 *   进球→相互战绩→Elo 兜底,非随机),且自动带上大融合参数(NB(8) 过离散 + venue 逐场场地乘子),
 *   与超算/champion-sim 同分布,不再"各算各的"。东道主本土 +35Elo(hosts 集合)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { teamPrior, groupVenueMults } from "../src/world-cup-priors.js";
import { simulateGroupStage, mulberry32 } from "../src/tournament-simulator.js";

const argNum = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = argNum("--n", 20000);
const SEED = argNum("--seed", 20260611);
const HOSTS = new Set(["United States", "Canada", "Mexico"]);

const dir = join(getDataSubdir("world-cup"), "2026");
const gdoc = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
const groups = gdoc.groups;
const zh = gdoc.team_name_zh || {};

// 取每队 Elo;缺失(如个别小国免费源无值)用该组其他队均值代理(诚实标注、不编造具体数值)。
const elo = {}; const missing = [];
for (const teams of Object.values(groups)) {
  for (const t of teams) {
    const tp = teamPrior(t) || teamPrior(zh[t]);
    if (tp?.elo) elo[t] = tp.elo; else { elo[t] = null; missing.push(t); }
  }
}
if (missing.length) console.log(`⚠ 缺 Elo(不编造,按组内均值代理): ${missing.join(", ")}`);
for (const teams of Object.values(groups)) {
  const have = teams.map((t) => elo[t]).filter(Boolean);
  const avg = have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : 1500;
  for (const t of teams) if (elo[t] == null) elo[t] = avg;
}
const eloOf = (t) => elo[t] ?? 1500;

// 大融合一致参数:与超算同分布(实证 base 2.54、NB(8) 过离散、venue 逐场场地乘子)。
const opts = { lambdaTotal: 2.54, hosts: HOSTS, hostAdv: 35, nbSize: 8, groupVenueMults: groupVenueMults() };

const rng = mulberry32(SEED);
const advance = {};
for (const teams of Object.values(groups)) for (const t of teams) advance[t] = 0;
for (let s = 0; s < N; s++) {
  const gs = simulateGroupStage(groups, eloOf, rng, opts);
  for (const a of gs.advancers) advance[a.team]++;
}

console.log(`=== 2026 世界杯小组出线概率(Monte-Carlo,N=${N},seed=${SEED},真实分组+Elo,共享引擎+NB(8)+venue)===`);
const rows = Object.entries(advance).map(([t, c]) => ({ t, zh: zh[t] || t, elo: elo[t], p: c / N })).sort((a, b) => b.p - a.p);
console.log("排名  球队            Elo    出线概率");
rows.forEach((r, i) => {
  console.log(`${String(i + 1).padEnd(5)} ${(r.zh).padEnd(12)} ${String(r.elo).padEnd(6)} ${(r.p * 100).toFixed(1)}%`);
});
// 审计:出线名额恒为 32(12组×2 + 8 最佳第三)
const expSum = rows.reduce((s, r) => s + r.p, 0);
console.log(`\n审计:出线期望和 = ${expSum.toFixed(2)}(应=32)  ${Math.abs(expSum - 32) < 0.01 ? "✓" : "✗"}`);
if (process.argv.includes("--json")) {
  const path = "D:/football-model-exports/worldcup-group-advance.json";
  writeFileSync(path, JSON.stringify({ n: N, seed: SEED, generatedFrom: "real-groups+elo+shared-engine(NB8+venue)", rows: rows.map((r) => ({ team: r.zh, elo: r.elo, advanceProb: Math.round(r.p * 1000) / 10 })) }, null, 1));
  console.log("已写 JSON:", path);
}
console.log("诚实:真实分组+当前Elo小组赛模拟(中立场+东道主本土+35);不含淘汰赛(避免编造bracket配对)。Elo 有判别力但国际赛爆冷常态,出线概率是分布预期非确定。");
