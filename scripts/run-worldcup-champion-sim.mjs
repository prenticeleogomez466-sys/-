#!/usr/bin/env node
/**
 * 2026 世界杯夺冠概率 Monte-Carlo(48h闭关·轮57)。真实分组+48队Elo→泊松小组赛→32强(前2+8最佳第三)
 * →单淘汰(泊松比分,90分钟平局走点球=50/50抛硬币,遵学界点球结论)→夺冠。
 * ⚠️诚实:淘汰赛配对用【随机近似】(无公开结构化 2026 bracket,绝不编造具体配对)→夺冠概率为粗略分布预期,
 *   非精确(真实固定bracket会让强队相遇时点不同)。点球50/50有据(2510.17641)。命中率上限不变。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { eloExpectation, teamPrior } from "../src/world-cup-priors.js";
import { shinFromInverse } from "../src/market-devig.js";

const N = 10000, LAMTOT = 2.6;
const HOSTS = new Set(["United States", "Canada", "Mexico"]);
const pois = (lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; };
// Rue-Salvesen γ=0.15 进球收缩(49k 国际赛 leak-safe 验证):压缩 we 线性拆分的过度领先 λ。
const RUE = 0.15;
function splitLam(we) {
  let la = LAMTOT * we, lb = LAMTOT * (1 - we);
  if (la > 0 && lb > 0) { const d = (Math.log(la) - Math.log(lb)) / 2; la = Math.exp(Math.log(la) - RUE * d); lb = Math.exp(Math.log(lb) + RUE * d); }
  return [la, lb];
}

const gdoc = JSON.parse(readFileSync(join(getDataSubdir("world-cup"), "2026", "groups.json"), "utf8"));
const groups = gdoc.groups; const zh = gdoc.team_name_zh || {};
const elo = {};
for (const [g, ts] of Object.entries(groups)) for (const t of ts) { const tp = teamPrior(t) || teamPrior(zh[t]); elo[t] = tp?.elo || 1500; }

function ko(A, B) { // knockout match → winner
  let ha = 0; if (HOSTS.has(A)) ha += 35; if (HOSTS.has(B)) ha -= 35;
  const we = eloExpectation(elo[A], elo[B], ha).homeWinExpectancy;
  const [la, lb] = splitLam(we); const ga = pois(la), gb = pois(lb);
  if (ga > gb) return A; if (gb > ga) return B;
  return Math.random() < 0.5 ? A : B; // 点球≈抛硬币(学界)
}

const champ = {}, final4 = {};
for (const ts of Object.values(groups)) for (const t of ts) { champ[t] = 0; final4[t] = 0; }

for (let s = 0; s < N; s++) {
  const adv = [], thirds = [];
  for (const ts of Object.values(groups)) {
    const pts = {}, gd = {}, gf = {}; ts.forEach((t) => { pts[t] = 0; gd[t] = 0; gf[t] = 0; });
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const A = ts[i], B = ts[j]; let ha = 0; if (HOSTS.has(A)) ha += 35; if (HOSTS.has(B)) ha -= 35;
      const we = eloExpectation(elo[A], elo[B], ha).homeWinExpectancy;
      const [la, lb] = splitLam(we); const ga = pois(la), gb = pois(lb);
      if (ga > gb) pts[A] += 3; else if (ga === gb) { pts[A]++; pts[B]++; } else pts[B] += 3;
      gd[A] += ga - gb; gd[B] += gb - ga; gf[A] += ga; gf[B] += gb;
    }
    const rk = [...ts].sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || Math.random() - 0.5);
    adv.push(rk[0], rk[1]); thirds.push({ t: rk[2], pts: pts[rk[2]], gd: gd[rk[2]] });
  }
  thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || Math.random() - 0.5);
  let alive = [...adv, ...thirds.slice(0, 8).map((x) => x.t)]; // 32
  while (alive.length > 1) {
    for (let i = alive.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [alive[i], alive[j]] = [alive[j], alive[i]]; } // 随机配对(近似)
    if (alive.length === 4) alive.forEach((t) => final4[t]++);
    const next = []; for (let i = 0; i < alive.length; i += 2) next.push(ko(alive[i], alive[i + 1]));
    alive = next;
  }
  champ[alive[0]]++;
}

const rows = Object.entries(champ).map(([t, c]) => ({ zh: zh[t] || t, elo: elo[t], p: c / N, sf: final4[t] / N, odds: (teamPrior(t) || teamPrior(zh[t]))?.title_odds }));
// 市场隐含夺冠率:48队 Shin 去抽水(2026-06-03 接入,替比例法)。
// 冠军盘抽水巨大(1/赔率和≈1.3-1.5),比例法系统性高估热门;Shin 假设内幕比例 z 校正
// favourite-longshot 偏差(回测:热门项|偏差| 1.19pp→0.70pp)。零赔率项保持 0。
const ALPHA = 0.65;
const invOdds = rows.map((r) => (r.odds ? 1 / r.odds : 0));
const { probs: shinMkt, z: shinZ } = shinFromInverse(invOdds);
rows.forEach((r, i) => { r.mkt = shinMkt[i]; r.blend = ALPHA * r.mkt + (1 - ALPHA) * r.p; });
rows.sort((a, b) => b.blend - a.blend);
console.log("=== 2026 世界杯夺冠概率 Monte-Carlo(N=" + N + ",真实分组+Elo,泊松+点球50/50)===");
console.log("⚠️ 淘汰赛配对=随机近似(无公开 bracket,不编造);夺冠率=粗略分布预期、非精确");
console.log("排名 球队        Elo  模型率  市场隐含  混合率(0.65市+0.35模)  进4强");
rows.slice(0, 16).forEach((r, i) => console.log(`${String(i + 1).padEnd(4)} ${r.zh.padEnd(10)} ${r.elo} ${(r.p * 100).toFixed(1)}%  ${(r.mkt * 100).toFixed(1)}%    ${(r.blend * 100).toFixed(1)}%        ${(r.sf * 100).toFixed(0)}%`));
// 审计:夺冠概率应与市场赔率正相关(Elo质量已验ρ0.88)
const top5 = rows.slice(0, 5).map((r) => r.zh).join("/");
console.log(`\n审计:夺冠前5=${top5};总概率和=${(rows.reduce((s, r) => s + r.p, 0) * 100).toFixed(0)}%(应≈100)`);
if (process.argv.includes("--json")) {
  const path = "D:/football-model-exports/worldcup-champion-prob.json";
  writeFileSync(path, JSON.stringify({ n: N, alpha: ALPHA, rows: rows.slice(0, 32).map((r) => ({ team: r.zh, elo: r.elo, model: +(r.p * 100).toFixed(1), market: +(r.mkt * 100).toFixed(1), blend: +(r.blend * 100).toFixed(1), sf: +(r.sf * 100).toFixed(0) })) }, null, 1));
  console.log("已写 JSON:", path);
}
