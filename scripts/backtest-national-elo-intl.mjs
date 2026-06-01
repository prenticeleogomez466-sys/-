/**
 * 国家队 national-elo 国际赛 1X2 回测(2026-06-01夜 通宵学习 cycle1)。
 * 问题:DC 对国家队失真(挪威主69%/哥伦比亚主87% 假),引擎改用 odds+national-elo(0.22),
 *   但 national-elo 把挪威/加拿大错拉向主胜(逆市场)。客观测:national-elo 帮忙还是添乱?最优权重/参数?
 * ⚠️ 用当前 elo 近似历史(单快照,无 point-in-time)→ 对 elo 略利好的泄漏;若带泄漏仍输市场=更该降权。
 * 用法:node scripts/backtest-national-elo-intl.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { loadNationalElo, nationalEloFor, eloToLambdas } from "../src/national-elo-source.js";

const EPS = 1e-12;
const poi = (k, l) => { if (!(l > 0)) return k === 0 ? 1 : 0; let lf = 0; for (let i = 2; i <= k; i++) lf += Math.log(i); return Math.exp(k * Math.log(l) - l - lf); };
function lam1x2(lh, la) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = poi(i, lh) * poi(j, la); if (i > j) h += p; else if (i === j) d += p; else a += p; }
  const t = h + d + a; return { home: h / t, draw: d / t, away: a / t };
}
const rps = (p, y) => { const c1 = p.home - (y === "home" ? 1 : 0); const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0); return 0.5 * (c1 * c1 + c2 * c2); };
const top = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const blend = (m, e, w) => ({ home: (1 - w) * m.home + w * e.home, draw: (1 - w) * m.draw + w * e.draw, away: (1 - w) * m.away + w * e.away });

const elo = loadNationalElo();
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date && /国际赛|友谊|世界杯|欧国联|预选|资格|FIFA|国家/.test(m.league || ""));
let rows = [];
for (const m of all) {
  const eh = nationalEloFor(elo, m.home), ea = nationalEloFor(elo, m.away);
  const mkt = m.marketHistorical?.closeProbs ?? m.marketHistorical?.openProbs ?? null;
  if (!Number.isFinite(eh) || !Number.isFinite(ea) || !mkt) continue;
  rows.push({ eh, ea, mkt, y: m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away", ouL: 2.5 });
}
console.log(`国际赛 同时有 当前elo + 市场赔率 的场:${rows.length}(覆盖有限,elo 单快照)`);
if (rows.length < 50) { console.log("样本太少,national-elo 数据覆盖不足以评估 → 倾向降权/谨慎"); process.exit(0); }

const arms = {
  "市场收盘": (r) => r.mkt,
  "纯elo(homeAdv35)": (r) => { const l = eloToLambdas(r.eh, r.ea); return lam1x2(l.home, l.away); },
  "纯elo(homeAdv0中立)": (r) => { const l = eloToLambdas(r.eh, r.ea, { homeAdv: 0 }); return lam1x2(l.home, l.away); },
  "市场+elo 0.10": (r) => { const l = eloToLambdas(r.eh, r.ea); return blend(r.mkt, lam1x2(l.home, l.away), 0.10); },
  "市场+elo 0.22(现行)": (r) => { const l = eloToLambdas(r.eh, r.ea); return blend(r.mkt, lam1x2(l.home, l.away), 0.22); },
  "市场+elo 0.22中立": (r) => { const l = eloToLambdas(r.eh, r.ea, { homeAdv: 0 }); return blend(r.mkt, lam1x2(l.home, l.away), 0.22); },
};
console.log("\n臂                        命中%    RPS");
const res = {};
for (const [name, fn] of Object.entries(arms)) {
  let hit = 0, sr = 0, n = 0;
  for (const r of rows) { let p; try { p = fn(r); } catch { continue; } if (!p || !Number.isFinite(p.home)) continue; if (top(p) === r.y) hit++; sr += rps(p, r.y); n++; }
  res[name] = { hit: hit / n, rps: sr / n, n };
  console.log(name.padEnd(24), (res[name].hit * 100).toFixed(1).padStart(6) + "%", res[name].rps.toFixed(4).padStart(8));
}
const mkt = res["市场收盘"];
console.log("\n裁决(基准=市场收盘):");
for (const [k, v] of Object.entries(res)) { if (k === "市场收盘") continue; const dh = (v.hit - mkt.hit) * 100, dr = mkt.rps - v.rps; console.log(`  ${k}: 命中Δ${dh >= 0 ? "+" : ""}${dh.toFixed(1)}pp / RPSΔ${dr >= 0 ? "+" : ""}${dr.toFixed(4)} ${v.rps < mkt.rps - 0.001 ? "✓优于市场(罕见)" : v.rps > mkt.rps + 0.002 ? "✗明显劣于市场" : "≈持平"}`); }
