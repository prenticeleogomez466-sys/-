/**
 * 大小球(over2.5)信心分层(通宵 cycle14)——补全"选择性"主题:高信心 O/U 命中是否更高。
 * 模型 P(over2.5) 离 0.5 越远=信心越高,分档看命中率。leak-safe train60/test40。
 * 用法:node scripts/backtest-ou-tiers.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
const pOver = (lh, la) => { const lt = lh + la, p0 = Math.exp(-lt); return 1 - p0 - p0 * lt - p0 * lt * lt / 2; };
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6); const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
// 信心=|P(over)-0.5|;分档
const tiers = [[0.20, []], [0.12, []], [0.06, []], [0, []]];
const put = (conf, win) => { for (const t of tiers) if (conf >= t[0]) { t[1].push(win); break; } };
let n = 0;
for (const m of test) {
  const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.expectedGoals) continue;
  const po = pOver(p.expectedGoals.home, p.expectedGoals.away);
  const pick = po >= 0.5 ? "over" : "under";
  const actual = (m.homeGoals + m.awayGoals) > 2.5 ? "over" : "under";
  put(Math.abs(po - 0.5), pick === actual ? 1 : 0); n++;
}
console.log(`大小球 ${n} 测试场\n信心档(|P(over)-0.5|)   场数    命中%`);
const labels = ["≥0.20(强)", "0.12-0.20", "0.06-0.12", "<0.06(均势)"];
tiers.forEach((t, i) => { if (!t[1].length) return; const h = t[1].reduce((s, v) => s + v, 0) / t[1].length; console.log(labels[i].padEnd(20), String(t[1].length).padStart(6), (h * 100).toFixed(1).padStart(6) + "%"); });
const strong = tiers[0][1], flip = tiers[3][1];
const sh = strong.reduce((s, v) => s + v, 0) / strong.length, fh = flip.reduce((s, v) => s + v, 0) / flip.length;
console.log(`\n强信心档 ${(sh * 100).toFixed(1)}% vs 均势档 ${(fh * 100).toFixed(1)}% | 差 ${((sh - fh) * 100).toFixed(1)}pp ` + ((sh - fh) > 0.04 ? "✓ 大小球选择性有效(只出强信心档提命中)" : "≈ 分层弱"));
