#!/usr/bin/env node
/**
 * 2026 世界杯小组出线概率 Monte-Carlo(轮10)。
 * 用【真实分组 groups.json】+【48队真实 Elo team-priors】模拟小组赛,算每队出线(前2 + 最佳8个第三)概率。
 * 完全 leak-safe/无编造:真实分组 + 当前 Elo 预测未来(正当预测,非泄漏);不碰淘汰赛 bracket(避免编造配对)。
 * 复用生产 eloExpectation。东道主(美/加/墨)小组赛本土 +35Elo(同 world-cup-priors 加成)。
 * 遵 feedback-no-fabrication:缺 Elo 的队如实列出、不猜测。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { eloExpectation, teamPrior } from "../src/world-cup-priors.js";

const N = 20000;
const HOSTS = new Set(["United States", "Canada", "Mexico"]);

function load() {
  const dir = join(getDataSubdir("world-cup"), "2026");
  const groups = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
  return groups;
}

function main() {
  const gdoc = load();
  const groups = gdoc.groups;
  const zh = gdoc.team_name_zh || {};
  // 取每队 Elo
  const elo = {}; const missing = [];
  for (const [g, teams] of Object.entries(groups)) {
    for (const t of teams) {
      const tp = teamPrior(t) || teamPrior(zh[t]);
      if (tp?.elo) elo[t] = tp.elo; else { elo[t] = null; missing.push(t); }
    }
  }
  if (missing.length) console.log(`⚠ 缺 Elo(不编造,模拟中按组内均值代理): ${missing.join(", ")}`);
  // 缺失用该组其他队均值代理(诚实标注),避免崩溃
  for (const [g, teams] of Object.entries(groups)) {
    const have = teams.map((t) => elo[t]).filter(Boolean);
    const avg = have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : 1500;
    for (const t of teams) if (elo[t] == null) elo[t] = avg;
  }

  const advance = {};
  for (const teams of Object.values(groups)) for (const t of teams) advance[t] = 0;

  for (let s = 0; s < N; s++) {
    const thirds = [];
    for (const teams of Object.values(groups)) {
      const pts = Object.fromEntries(teams.map((t) => [t, 0]));
      const gd = Object.fromEntries(teams.map((t) => [t, 0]));
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const A = teams[i], B = teams[j];
          let ha = 0;
          if (HOSTS.has(A)) ha += 35; if (HOSTS.has(B)) ha -= 35;
          const e = eloExpectation(elo[A], elo[B], ha);
          const r = Math.random();
          if (r < e.home) { pts[A] += 3; gd[A]++; gd[B]--; }
          else if (r < e.home + e.draw) { pts[A]++; pts[B]++; }
          else { pts[B] += 3; gd[B]++; gd[A]--; }
        }
      }
      const ranked = [...teams].sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || Math.random() - 0.5);
      advance[ranked[0]]++; advance[ranked[1]]++;
      thirds.push({ team: ranked[2], pts: pts[ranked[2]], gd: gd[ranked[2]] });
    }
    thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || Math.random() - 0.5);
    for (let k = 0; k < 8; k++) advance[thirds[k].team]++;
  }

  console.log("=== 2026 世界杯小组出线概率(Monte-Carlo,N=" + N + ",真实分组+Elo)===");
  const rows = Object.entries(advance).map(([t, c]) => ({ t, zh: zh[t] || t, elo: elo[t], p: c / N }))
    .sort((a, b) => b.p - a.p);
  console.log("排名  球队            Elo    出线概率");
  rows.forEach((r, i) => {
    console.log(`${String(i + 1).padEnd(5)} ${(r.zh).padEnd(12)} ${String(r.elo).padEnd(6)} ${(r.p * 100).toFixed(1)}%`);
  });
  console.log("\n诚实:基于真实分组+当前Elo的小组赛模拟(中立场+东道主本土+35);不含淘汰赛(避免编造bracket配对)。");
  console.log("Elo 已验有判别力(轮5命中50.5%)但国际赛爆冷常态,出线概率是分布预期、非确定。");
}

main();
