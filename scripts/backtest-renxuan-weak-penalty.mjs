// R15 量化:任选9 选场对弱联赛【降权】是否提升 top9 选场质量?
// 诊断已证:高档(≥0.6)弱联赛市场热门兑现率比强联赛低 11~22pp。本回测量化"把它们换出 top9"的净效果。
// leak-safe:按天独立,用赛前盘 openProbs 算 marketFavProb 排序选 top9,看赛后市场 argmax 兑现(选场质量代理)。
// 降权 = 弱联赛 effProb = favProb × penalty(只影响排序选择,不改真实兑现判定)。扫描 penalty。
import fs from "fs";
import { isWeakLeague } from "../src/league-reliability.js";

const FIX_DIR = "D:/football-model-data/fixtures";
function loadArr(p) { try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(j) ? j : (j.fixtures || Object.values(j).find((v) => Array.isArray(v)) || []); } catch { return []; } }

// 收集按天的可选场(有 openProbs + result)
const days = [];
for (const f of fs.readdirSync(FIX_DIR).filter((x) => /^2026-\d\d-\d\d\.json$/.test(x)).sort()) {
  const pool = [];
  for (const fx of loadArr(`${FIX_DIR}/${f}`)) {
    if (!fx || !fx.result || !Number.isFinite(fx.result.home) || !Number.isFinite(fx.result.away)) continue;
    const p = fx.marketHistorical?.openProbs;
    if (!p || !Number.isFinite(p.home)) continue;
    const entries = [["home", p.home], ["draw", p.draw], ["away", p.away]];
    const fav = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const actual = fx.result.home > fx.result.away ? "home" : fx.result.home < fx.result.away ? "away" : "draw";
    pool.push({ league: fx.competition, weak: isWeakLeague(fx.competition), favProb: fav[1], favDir: fav[0], hit: fav[0] === actual });
  }
  if (pool.length >= 9) days.push({ date: f.replace(".json", ""), pool });
}

function evalPenalty(penalty) {
  let legHit = 0, legN = 0, weakInTop = 0, fullHitDays = 0, daysN = 0;
  for (const d of days) {
    const ranked = [...d.pool].sort((a, b) =>
      ((b.weak ? b.favProb * penalty : b.favProb)) - ((a.weak ? a.favProb * penalty : a.favProb)));
    const top9 = ranked.slice(0, 9);
    daysN++;
    let dayHit = 0;
    for (const s of top9) { legN++; if (s.hit) { legHit++; dayHit++; } if (s.weak) weakInTop++; }
    if (dayHit === 9) fullHitDays++;
  }
  return { penalty, legHitRate: legHit / legN, legHit, legN, weakInTop, fullHitDays, daysN };
}

console.log(`可用天数(可选场≥9): ${days.length} | 总入选腿基数: ${days.length * 9}`);
console.log(`\npenalty  top9单腿兑现率   命中腿/总     弱联赛入选数   9场全中天数`);
const base = evalPenalty(1.0);
for (const pen of [1.0, 0.95, 0.90, 0.85, 0.80, 0.70]) {
  const r = evalPenalty(pen);
  const delta = ((r.legHitRate - base.legHitRate) * 100);
  const tag = pen === 1.0 ? "(基线)" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`;
  console.log(`  ${pen.toFixed(2)}   ${(r.legHitRate * 100).toFixed(2)}%`.padEnd(22) + `${r.legHit}/${r.legN}`.padEnd(14) + `${r.weakInTop}`.padEnd(15) + `${r.fullHitDays}/${r.daysN}   ${tag}`);
}
console.log(`\n判读: 降权使"top9 单腿兑现率"显著提升(+>1pp)且弱联赛入选数下降、9场全中天数不降 → R15 成立,挑最优 penalty 改 buildRenxuan9;`);
console.log(`      若提升≈0 或全中天数反降 → 降权无益,守铁律不动。样本天数少时方向比绝对值重要。`);
