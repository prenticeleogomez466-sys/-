/**
 * 1X2 置信分层回测(通宵 cycle2)——客观给出"只打哪类场命中率更高"的可执行选择性投注规则。
 * 命中率天花板≈市场,但**选择性投注**能在你下注的子集上拉高实际命中率(少打、打准)。
 * 分层维度:① 市场热门强度(收盘 fav 概率桶)② 模型(DC)是否与市场同向 ③ 开→收盘漂移是否确认。
 * leak-safe:DC 训练 60% / 测试 40%;市场=收盘(赛前已知,无泄漏)。
 * 用法:node scripts/backtest-confidence-tiers.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const argmax = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const all = collectHistoricalMatches(4000)
  .filter((m) => m.homeGoals != null && m.date && m.marketHistorical?.closeProbs)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6);
const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
console.log(`带收盘赔率 ${all.length} | train ${train.length} / test ${test.length} | DC teams ${Object.keys(dc.teams || {}).length}`);

// 全局:打市场热门的命中率 by fav 概率桶
const buckets = { "0.40-0.50": [], "0.50-0.55": [], "0.55-0.60": [], "0.60-0.65": [], "0.65-0.70": [], "0.70-0.80": [], "0.80+": [] };
const bk = (f) => f >= 0.8 ? "0.80+" : f >= 0.7 ? "0.70-0.80" : f >= 0.65 ? "0.65-0.70" : f >= 0.6 ? "0.60-0.65" : f >= 0.55 ? "0.55-0.60" : f >= 0.5 ? "0.50-0.55" : "0.40-0.50";
let agree = { hit: 0, n: 0 }, disagree = { hit: 0, n: 0 };
const tierRows = [];

for (const m of test) {
  const mkt = m.marketHistorical.closeProbs;
  const fav = argmax(mkt), favP = Math.max(mkt.home, mkt.draw, mkt.away);
  const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";
  const winFav = fav === y ? 1 : 0;
  if (buckets[bk(favP)]) buckets[bk(favP)].push(winFav);
  // 模型同向
  const pred = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away });
  if (pred?.probabilities) {
    const dcTop = argmax(pred.probabilities);
    if (dcTop === fav) { agree.hit += winFav; agree.n++; } else { disagree.hit += winFav; disagree.n++; }
  }
  tierRows.push({ favP, winFav, dcAgree: pred?.probabilities ? argmax(pred.probabilities) === fav : null });
}

console.log("\n① 打市场热门 · 按热门强度分桶:");
console.log("桶            场数    命中%");
for (const [k, arr] of Object.entries(buckets)) { if (!arr.length) continue; const h = arr.reduce((s, v) => s + v, 0) / arr.length; console.log(k.padEnd(13), String(arr.length).padStart(6), (h * 100).toFixed(1).padStart(6) + "%"); }

console.log("\n② 模型(DC)是否与市场同向:");
console.log(`  同向: 命中 ${(agree.hit / agree.n * 100).toFixed(1)}% (${agree.n}场)`);
console.log(`  逆向: 命中 ${(disagree.hit / disagree.n * 100).toFixed(1)}% (${disagree.n}场) ← 逆市场命中骤降,印证 CLV`);

console.log("\n③ 选择性投注 · 累计阈值(只打 fav≥阈值 的市场热门):");
console.log("阈值      覆盖%     命中%    (+模型同向过滤)命中% / 覆盖%");
for (const th of [0.5, 0.55, 0.6, 0.65, 0.7]) {
  const sel = tierRows.filter((r) => r.favP >= th);
  const hit = sel.reduce((s, r) => s + r.winFav, 0) / sel.length;
  const selA = sel.filter((r) => r.dcAgree === true);
  const hitA = selA.length ? selA.reduce((s, r) => s + r.winFav, 0) / selA.length : 0;
  console.log(
    `≥${th.toFixed(2)}`.padEnd(8),
    (sel.length / tierRows.length * 100).toFixed(0).padStart(5) + "%",
    (hit * 100).toFixed(1).padStart(7) + "%",
    "      " + (hitA * 100).toFixed(1).padStart(5) + "% / " + (selA.length / tierRows.length * 100).toFixed(0) + "%");
}
console.log("\n判读:阈值越高/加模型同向过滤 → 命中率越高但覆盖越少(少打打准)。这是可落地的'增命中率'规则:");
console.log("      低信心(均势/逆市场)场 弃打或双选,高信心(强热门+模型同向)场 单关。");
