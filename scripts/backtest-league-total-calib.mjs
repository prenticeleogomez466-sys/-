/**
 * 联赛总进球校准(通宵 cycle5)——DC λ-总量按联赛可能系统偏差,缩放后看比分/大小球是否改善。
 * 每联赛 ratio=actualTotal/dcPredTotal(train),收缩 w=n/(n+K) 后缩放测试 λ(保持主客比例),
 * 比 比分 logloss + 大小球 Brier。leak-safe train60/test40。仅 no-market 路有意义(有盘口已 O/U 校准)。
 * 用法:node scripts/backtest-league-total-calib.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const G = 6, EPS = 1e-12, K = 400;
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const poi = (k, l) => (l > 0 ? Math.exp(k * Math.log(l) - l - lg(k)) : (k === 0 ? 1 : 0));
const tau = (h, a, l, m, rho) => h === 0 && a === 0 ? 1 - l * m * rho : h === 0 && a === 1 ? 1 + l * rho : h === 1 && a === 0 ? 1 + m * rho : h === 1 && a === 1 ? 1 - rho : 1;
function mat(lh, la, rho = -0.08) { const m = []; let t = 0; for (let h = 0; h <= G; h++) { m[h] = []; for (let a = 0; a <= G; a++) { const p = Math.max(poi(h, lh) * poi(a, la) * tau(h, a, lh, la, rho), 0); m[h][a] = p; t += p; } } for (let h = 0; h <= G; h++)for (let a = 0; a <= G; a++)m[h][a] /= t; return m; }
const pOver = (lh, la) => { const lt = lh + la, p0 = Math.exp(-lt); return 1 - p0 - p0 * lt - p0 * lt * lt / 2; };

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6); const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);

// 每联赛 train: 累计 actualTotal 与 dcPredTotal
const byLg = new Map(); let gActual = 0, gPred = 0, gn = 0;
for (const m of train) { const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.expectedGoals) continue; const pred = p.expectedGoals.home + p.expectedGoals.away, act = m.homeGoals + m.awayGoals; const lg2 = m.league ?? "?"; const e = byLg.get(lg2) ?? { act: 0, pred: 0, n: 0 }; e.act += act; e.pred += pred; e.n++; byLg.set(lg2, e); gActual += act; gPred += pred; gn++; }
const gRatio = gActual / Math.max(gPred, 1);
const ratioOf = (lg2) => { const e = byLg.get(lg2); if (!e || e.pred <= 0) return gRatio; const w = e.n / (e.n + K); const raw = e.act / e.pred; return w * raw + (1 - w) * gRatio; };
console.log(`全局 ratio ${gRatio.toFixed(3)} | 联赛数 ${byLg.size}`);
const ratios = [...byLg.entries()].filter(([, e]) => e.n >= 300).map(([k]) => [k, ratioOf(k)]).sort((a, b) => b[1] - a[1]);
console.log("联赛λ缩放(前5高/后5低):", ratios.slice(0, 5).map(([k, r]) => `${k}${r.toFixed(2)}`).join(" "), "...", ratios.slice(-5).map(([k, r]) => `${k}${r.toFixed(2)}`).join(" "));

let llRaw = 0, llCal = 0, brRaw = 0, brCal = 0, n = 0;
for (const m of test) {
  const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.expectedGoals) continue;
  const lh = p.expectedGoals.home, la = p.expectedGoals.away, r = ratioOf(m.league ?? "?");
  const h = Math.min(m.homeGoals, G), a = Math.min(m.awayGoals, G);
  const mR = mat(lh, la), mC = mat(lh * r, la * r);
  llRaw += -Math.log(Math.max(mR[h][a], EPS)); llCal += -Math.log(Math.max(mC[h][a], EPS));
  const yO = (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0;
  brRaw += (pOver(lh, la) - yO) ** 2; brCal += (pOver(lh * r, la * r) - yO) ** 2;
  n++;
}
console.log(`\n比分 logloss:原始 ${(llRaw / n).toFixed(4)} → 联赛校准 ${(llCal / n).toFixed(4)} | Δ${((llRaw - llCal) / n).toFixed(4)}`);
console.log(`大小球 Brier:原始 ${(brRaw / n).toFixed(4)} → 联赛校准 ${(brCal / n).toFixed(4)} | Δ${((brRaw - brCal) / n).toFixed(4)}`);
const dLL = (llRaw - llCal) / n, dBr = (brRaw - brCal) / n;
console.log(dLL > 0.001 || dBr > 0.0005 ? "→ 联赛总进球校准显著改善,值得接 no-market 比分/大小球路" : "→ 无显著增益,DC λ-总量按联赛已基本无偏(诚实null)");
