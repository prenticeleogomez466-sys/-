/**
 * 平局校准分析(通宵 cycle4)——泊松经典弱点低估平局,测模型平局概率 vs 实际,看有无可利用偏差。
 * 平局是 1X2 最难类;若 DC 系统性偏差,平局 isotonic 校准可提 no-market 路 RPS。
 * leak-safe train60/test40。对比 市场close平局 / DC纯平局 的校准 + 平局isotonic 后 RPS。
 * 用法:node scripts/backtest-draw-calibration.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";

const EPS = 1e-12;
const rps = (p, y) => { const c1 = p.home - (y === "home" ? 1 : 0); const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0); return 0.5 * (c1 * c1 + c2 * c2); };
const norm = (p) => { const t = p.home + p.draw + p.away; return { home: p.home / t, draw: p.draw / t, away: p.away / t }; };

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6);
const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
console.log(`store ${all.length} | train ${train.length}/test ${test.length}`);

// 训练集:DC平局概率→实际平局,拟合 isotonic
const trainObs = [];
for (const m of train) { const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (p?.probabilities) trainObs.push({ predicted: p.probabilities.draw, actual: m.homeGoals === m.awayGoals ? 1 : 0 }); }
const drawIso = buildIsotonicMap(trainObs);

// 测试:DC平局校准桶 + 1X2 RPS(原始 vs 平局校准后重归一)
const buckets = {}; const bk = (p) => Math.min(9, Math.floor(p * 20)); // 0.05宽
let rpsRaw = 0, rpsCal = 0, n = 0, drawActual = 0, drawPredRaw = 0, drawPredCal = 0;
for (const m of test) {
  const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.probabilities) continue;
  const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";
  const raw = p.probabilities;
  // 平局校准:替换 draw 为 isotonic 值,home/away 按比例缩放余量
  const dCal = applyIsotonicMap(drawIso, raw.draw) ?? raw.draw;
  const rem = 1 - dCal, rawHA = raw.home + raw.away;
  const cal = norm({ home: rawHA > 0 ? raw.home / rawHA * rem : rem / 2, draw: dCal, away: rawHA > 0 ? raw.away / rawHA * rem : rem / 2 });
  rpsRaw += rps(raw, y); rpsCal += rps(cal, y); n++;
  if (y === "draw") drawActual++;
  drawPredRaw += raw.draw; drawPredCal += cal.draw;
  const b = bk(raw.draw); buckets[b] = buckets[b] || { pred: 0, act: 0, n: 0 }; buckets[b].pred += raw.draw; buckets[b].act += (y === "draw" ? 1 : 0); buckets[b].n++;
}
console.log(`\n实际平局率 ${(drawActual / n * 100).toFixed(1)}% | DC原始预测均值 ${(drawPredRaw / n * 100).toFixed(1)}% | 校准后 ${(drawPredCal / n * 100).toFixed(1)}%`);
console.log("\nDC平局校准桶(预测 vs 实际):");
for (const b of Object.keys(buckets).sort((x, y) => x - y)) { const o = buckets[b]; if (o.n > 50) console.log(`  [${(b * 0.05).toFixed(2)}-${((+b + 1) * 0.05).toFixed(2)}] 预测${(o.pred / o.n * 100).toFixed(1)}% 实际${(o.act / o.n * 100).toFixed(1)}% (n=${o.n})`); }
console.log(`\n1X2 RPS:DC原始 ${(rpsRaw / n).toFixed(4)} → 平局校准后 ${(rpsCal / n).toFixed(4)} | Δ${((rpsRaw - rpsCal) / 1).toFixed(4)}`);
console.log((rpsRaw - rpsCal) > 0.0005 ? "→ 平局校准显著改善 no-market 1X2,值得接(DC平局确有偏差)" : "→ 平局校准无显著增益(DC的τ已基本校准平局),诚实null");
