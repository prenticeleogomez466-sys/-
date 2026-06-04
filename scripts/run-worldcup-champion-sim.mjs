#!/usr/bin/env node
/**
 * 2026 世界杯夺冠概率(融合输入)。真实分组 + 48 队 Elo → 共享锦标赛引擎 tournament-simulator:
 *   小组真 FIFA tiebreaker → 32 强(前2+8最佳第三)→ FIFA 官方对阵表(R32真实位次+第三名495分配)
 *   → 90'→加时→点球50/50 → 夺冠。Rue-Salvesen γ 进球收缩在引擎内(49k 国际赛 leak-safe 验证)。
 *
 * 2026-06-03:从"随机配对近似"升级为官方对阵表共享引擎(与超算一致、可复现、无同组R32重赛)。
 *   产物 worldcup-champion-prob.json 供 run-worldcup-fusion.mjs 做多模型对数意见池融合。
 * 点球50/50有据(2510.17641);市场隐含用 Shin 去抽水;命中率上限不变。纯只读上游+写产物。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir, getExportDir } from "../src/paths.js";
import { teamPrior } from "../src/world-cup-priors.js";
import { shinFromInverse } from "../src/market-devig.js";
import { runMonteCarlo } from "../src/tournament-simulator.js";

const argNum = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = argNum("--n", 20000);
const SEED = argNum("--seed", 20260611);
const ALPHA = 0.65;
const HOSTS = new Set(["United States", "Canada", "Mexico"]);

const gdoc = JSON.parse(readFileSync(join(getDataSubdir("world-cup"), "2026", "groups.json"), "utf8"));
const groups = gdoc.groups; const zh = gdoc.team_name_zh || {};

// 官方对阵表:数据盘优先、回退仓库 data/。
let bracket = null;
for (const p of [join(getDataSubdir("world-cup"), "2026", "bracket.json"), join(process.cwd(), "data", "world-cup", "2026", "bracket.json")]) {
  try { bracket = JSON.parse(readFileSync(p, "utf8")); break; } catch { /* next */ }
}

const eloCache = {};
const eloOf = (t) => {
  if (eloCache[t] != null) return eloCache[t];
  const tp = teamPrior(t) || teamPrior(zh[t]);
  return (eloCache[t] = tp?.elo || 1500);
};

// 进球强度实证校准(见 run-worldcup-supercomputer.mjs / analyze-wc-stage-goals.mjs):base 2.54、淘汰赛 0.96。
const phaseIntensity = { r32: 0.96, r16: 0.96, qf: 0.96, sf: 0.96, final: 0.96 };
// 大融合(2026-06-04):比分分布与单场世界杯模型统一 —— nbSize=8 国际赛过离散(= prediction-engine NB_SIZE_SOFT)。
const res = runMonteCarlo({ groups, eloOf, hosts: HOSTS, lambdaTotal: 2.54, hostAdv: 35, penTilt: 0, phaseIntensity, bracket, nbSize: 8 }, N, SEED);

// 市场隐含夺冠率:48 队 Shin 去抽水(替比例法,校 favourite-longshot 偏差)。零赔率项保持 0。
const base = res.teams.map((r) => ({ team: zh[r.team] || r.team, en: r.team, elo: eloOf(r.team), p: r.champion, sf: r.sf, odds: (teamPrior(r.team) || teamPrior(zh[r.team]))?.title_odds }));
const invOdds = base.map((r) => (r.odds ? 1 / r.odds : 0));
const { probs: shinMkt, z: shinZ } = shinFromInverse(invOdds);
base.forEach((r, i) => { r.mkt = shinMkt[i]; r.blend = ALPHA * r.mkt + (1 - ALPHA) * r.p; });
base.sort((a, b) => b.blend - a.blend);

console.log(`=== 2026 世界杯夺冠概率(N=${N}, seed=${SEED}, ${bracket ? "FIFA官方对阵表" : "强度种子树回退"}, γ收缩+点球50/50)===`);
console.log("排名 球队        Elo  模型率  市场(Shin)  混合率(0.65市+0.35模)  进4强");
base.slice(0, 16).forEach((r, i) => console.log(`${String(i + 1).padEnd(4)} ${r.team.padEnd(10)} ${r.elo} ${(r.p * 100).toFixed(1)}%  ${(r.mkt * 100).toFixed(1)}%    ${(r.blend * 100).toFixed(1)}%        ${(r.sf * 100).toFixed(0)}%`));
console.log(`\n审计:夺冠和=${(res.audit.champSum * 100).toFixed(1)}%(应≈100) | 出线和=${res.audit.advSum.toFixed(1)}(应=32) | 单调=${res.audit.monotonic ? "✓" : "✗"} | Shin z=${shinZ.toFixed(3)} | 闸门=${res.audit.ok ? "✓" : "✗"}`);

if (process.argv.includes("--json") || true) {
  const path = join(getExportDir(), "worldcup-champion-prob.json");
  writeFileSync(path, JSON.stringify({ n: N, seed: SEED, alpha: ALPHA, bracket: bracket ? "fifa-official" : "seeded", audit: res.audit, rows: base.slice(0, 32).map((r) => ({ team: r.team, elo: r.elo, model: +(r.p * 100).toFixed(1), market: +(r.mkt * 100).toFixed(1), blend: +(r.blend * 100).toFixed(1), sf: +(r.sf * 100).toFixed(0) })) }, null, 1));
  console.log("已写 JSON:", path);
}
