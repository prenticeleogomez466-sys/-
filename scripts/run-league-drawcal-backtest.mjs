/**
 * 联赛平局校准回测(2026-05-31)—— 验证"按联赛历史平局率把模型平局向真实值校准"是否提命中/RPS。
 * leak-safe walk-forward:每个测试日,用**严格更早**的同联赛赛果算该联赛历史平局率;
 *   把市场隐含平局向该值有界移动(±0.10),home/away 等比缩放;比 baseline 的 RPS/命中/平局召回。
 * 分联赛看(日职/韩职/澳超/美职 等小球联赛预期受益最大)。market.odds 已是去vig隐含概率。
 * 用法:node scripts/run-league-drawcal-backtest.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { loadEspnResults, ESPN_LEAGUES } from "../src/espn-results-source.js";

const actual = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const MOVE = 0.6, CAP = 0.10, MIN_LG = 120;
function rps(p, o) { const ord = ["home", "draw", "away"]; const y = ord.map((x) => x === o ? 1 : 0); const pv = ord.map((x) => p[x]); let cp = 0, cy = 0, s = 0; for (let i = 0; i < 2; i++) { cp += pv[i]; cy += y[i]; s += (cp - cy) ** 2; } return s; }
const fav = (p) => ["home", "draw", "away"].reduce((b, o) => p[o] > p[b] ? o : b, "home");

// 数据:football-data(有 odds)做主回测集(ESPN 无 odds,只能用其历史算联赛平局率,不进 RPS 评估)
const fd = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const all = fd.matches.filter((m) => m.homeGoals != null && m.odds && m.date)
  .map((m) => ({ ...m, label: LEAGUE_LABELS[m.league] ?? m.league, ts: Date.parse(m.date) }))
  .sort((a, b) => a.ts - b.ts);
console.log(`${all.length} 场(football-data,有赔率)\n`);

const cut = Math.floor(all.length * 0.5);
const test = all.slice(cut);

const arms = { base: {}, drawcal: {} };
for (const k of Object.keys(arms)) arms[k] = { rps: 0, n: 0, drawHit: 0, drawTot: 0, byLg: {} };
const add = (arm, lg, o, p) => {
  arm.rps += rps(p, o); arm.n++;
  if (o === "draw") arm.drawTot++;
  if (fav(p) === o && o === "draw") arm.drawHit++;
  const b = (arm.byLg[lg] ??= { rps: 0, n: 0, hit: 0 });
  b.rps += rps(p, o); b.n++; if (fav(p) === o) b.hit++;
};

for (const m of test) {
  const o = actual(m.homeGoals, m.awayGoals);
  const base = { ...m.odds };
  // 联赛历史平局率(严格更早,leak-safe)
  const prior = all.filter((x) => x.ts < m.ts && x.label === m.label);
  let cal = base;
  if (prior.length >= MIN_LG) {
    const lgDraw = prior.filter((x) => x.homeGoals === x.awayGoals).length / prior.length;
    const d0 = base.draw;
    let d1 = d0 + (lgDraw - d0) * MOVE;
    d1 = Math.max(d0 - CAP, Math.min(d0 + CAP, d1));
    const scale = (1 - d1) / Math.max(1e-9, 1 - d0);
    cal = { home: base.home * scale, draw: d1, away: base.away * scale };
    const s = cal.home + cal.draw + cal.away; cal = { home: cal.home / s, draw: cal.draw / s, away: cal.away / s };
  }
  add(arms.base, m.label, o, base);
  add(arms.drawcal, m.label, o, cal);
}

const pr = (a) => `RPS ${(a.rps / a.n).toFixed(4)} 命中?  平局召回 ${(a.drawHit / Math.max(1, a.drawTot) * 100).toFixed(1)}%`;
console.log("臂        RPS       平局召回(实际平局里推中平的比例)");
console.log("base    ", (arms.base.rps / arms.base.n).toFixed(4), (arms.base.drawHit / Math.max(1, arms.base.drawTot) * 100).toFixed(1) + "%");
console.log("drawcal ", (arms.drawcal.rps / arms.drawcal.n).toFixed(4), (arms.drawcal.drawHit / Math.max(1, arms.drawcal.drawTot) * 100).toFixed(1) + "%");
const dr = arms.base.rps / arms.base.n - arms.drawcal.rps / arms.drawcal.n;
console.log(`\nRPS 改善(正=变好):${dr.toFixed(5)}  | 平局召回 ${(arms.base.drawHit / arms.base.drawTot * 100).toFixed(1)}%→${(arms.drawcal.drawHit / arms.drawcal.drawTot * 100).toFixed(1)}%`);

console.log("\n分联赛 RPS(base→drawcal,负=校准变好;样本≥100):");
for (const lg of Object.keys(arms.base.byLg).sort()) {
  const b = arms.base.byLg[lg], c = arms.drawcal.byLg[lg];
  if (b.n < 100) continue;
  const d = c.rps / c.n - b.rps / b.n;
  console.log(`  ${lg.padEnd(8)} n${String(b.n).padStart(5)}  ${(b.rps / b.n).toFixed(4)}→${(c.rps / c.n).toFixed(4)} ${d < -0.0002 ? "✅" : d > 0.0002 ? "❌" : "="}`);
}
console.log("\n注:market.odds 已含市场对平局的定价,若 drawcal 不改善→市场已price平局,该玩法对有赔率俱乐部联赛无益(同②);真正受益的是赔率薄/无的小球联赛。");
