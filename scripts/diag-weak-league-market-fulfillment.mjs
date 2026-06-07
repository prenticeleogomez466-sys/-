// R15 判据:任选9 已用 marketFavProb(市场隐含热门概率)选场。弱联赛已"不当胆"。
// 问题:任选9 选场再对弱联赛【降权】是否有增益? 核心 = 弱联赛里"市场大热门"的实际兑现率
//   是否显著低于强联赛同档? 低→降权有理;≈→marketFavProb已充分、降权无益;弱联赛样本不足→守铁律不动。
// leak-safe:用赛前盘(openProbs,=生产推荐场景)分组,看赛后兑现。closeProbs(收盘,更sharp)作对照上限。
import fs from "fs";
import { isWeakLeague } from "../src/league-reliability.js";

const FIX_DIR = "D:/football-model-data/fixtures";
function loadArr(p) { try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(j) ? j : (j.fixtures || Object.values(j).find((v) => Array.isArray(v)) || []); } catch { return []; } }

const rows = [];
for (const f of fs.readdirSync(FIX_DIR).filter((x) => /^2026-\d\d-\d\d\.json$/.test(x))) {
  for (const fx of loadArr(`${FIX_DIR}/${f}`)) {
    if (!fx || !fx.result || !Number.isFinite(fx.result.home) || !Number.isFinite(fx.result.away)) continue;
    const mh = fx.marketHistorical;
    if (!mh) continue;
    const actual = fx.result.home > fx.result.away ? "home" : fx.result.home < fx.result.away ? "away" : "draw";
    const weak = isWeakLeague(fx.competition);
    rows.push({ league: fx.competition, weak, actual, open: mh.openProbs, close: mh.closeProbs });
  }
}

function analyze(probKey, label) {
  // 档:marketFavProb ≥ 阈值。统计每组(弱/强)市场热门(argmax)实际兑现率。
  const thresholds = [0.40, 0.50, 0.60, 0.65, 0.70];
  console.log(`\n========== 用 ${label} 分组(market argmax 兑现率) ==========`);
  console.log(`档(favProb≥)   强联赛: 命中/场 (率)        弱联赛: 命中/场 (率)        差(弱-强)`);
  for (const th of thresholds) {
    const g = { strong: { hit: 0, n: 0 }, weak: { hit: 0, n: 0 } };
    for (const r of rows) {
      const p = r[probKey]; if (!p || !Number.isFinite(p.home)) continue;
      const entries = [["home", p.home], ["draw", p.draw], ["away", p.away]];
      const fav = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
      if (fav[1] < th) continue;
      const grp = r.weak ? g.weak : g.strong;
      grp.n++; if (fav[0] === r.actual) grp.hit++;
    }
    const rate = (x) => x.n ? (x.hit / x.n) : null;
    const fmt = (x) => x.n ? `${x.hit}/${x.n} (${(rate(x) * 100).toFixed(1)}%)` : "—";
    const diff = (rate(g.weak) != null && rate(g.strong) != null) ? `${((rate(g.weak) - rate(g.strong)) * 100).toFixed(1)}pp` : "—";
    console.log(`  ≥${(th * 100).toFixed(0)}%`.padEnd(14) + fmt(g.strong).padEnd(28) + fmt(g.weak).padEnd(28) + diff);
  }
}

console.log(`总样本: ${rows.length} 场有 result+marketHistorical`);
console.log(`其中弱联赛(阿甲/奥地利/土超/中超 canonical): ${rows.filter((r) => r.weak).length} 场`);
console.log(`有 openProbs: ${rows.filter((r) => r.open?.home != null).length} | 有 closeProbs: ${rows.filter((r) => r.close?.home != null).length}`);
analyze("open", "openProbs(赛前盘=生产场景)");
analyze("close", "closeProbs(收盘=更sharp上限)");
console.log(`\n判读: 弱联赛"差(弱-强)"在高档(≥0.6/0.65)若显著为负(如<-8pp)且弱联赛场次足(每档≥40)→ 降权有理;`);
console.log(`      若差≈0 或弱联赛场次太少 → marketFavProb 已充分/样本不足,R15 降权无益或不可验证,守铁律不动。`);
