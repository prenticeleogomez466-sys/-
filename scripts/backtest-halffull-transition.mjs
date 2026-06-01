/**
 * 半全场 HT→FT 经验转移 producer(通宵 cycle6)——新板块候选。
 * 思路:模型给本场 HT 强弱分布(halfFullJoint 边际到 HT),× 联赛经验 P(FT-结果|HT-结果) 3×3 转移
 *   (捕捉领先保/落后追的真实动态)→ 9 类。与纯模型、纯联合经验都不同。
 * 测:它单路 vs 现行(notau)、以及 加入集成(notau+经验+转移)前向逐步 是否再降 LL。
 * leak-safe train60/val20/test20。用法:node scripts/backtest-halffull-transition.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullJoint } from "../src/halftime-fulltime-model.js";

const EPS = 1e-12;
const C = ["HH", "HD", "HA", "DH", "DD", "DA", "AH", "AD", "AA"];
const CN = { 主胜: "H", 平局: "D", 客胜: "A" };
const O = ["H", "D", "A"];
const sgn = (x, y) => (x > y ? "H" : x === y ? "D" : "A");
const toCode = (d) => { const o = {}; let s = 0; for (const [k, v] of Object.entries(d || {})) { const [ht, ft] = k.split("-"); const c = (CN[ht] || "") + (CN[ft] || ""); if (C.includes(c)) { o[c] = (o[c] || 0) + v; s += v; } } if (s <= 0) return null; for (const c of C) o[c] = (o[c] || 0) / s; return o; };
const ll = (rows, fn) => { let s = 0, n = 0; for (const r of rows) { const p = fn(r); if (!p) continue; s += -Math.log(Math.max(p[r.y], EPS)); n++; } return s / n; };
const hit = (rows, fn) => { let h = 0, n = 0; for (const r of rows) { const p = fn(r); if (!p) continue; const t = C.reduce((b, c) => p[c] > p[b] ? c : b, C[0]); if (t === r.y) h++; n++; } return h / n; };

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.halfHome != null && m.halfAway != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const c1 = Math.floor(all.length * 0.6), c2 = Math.floor(all.length * 0.8);
const train = all.slice(0, c1), val = all.slice(c1, c2), test = all.slice(c2);
const dc = fitFromMatches(train);
console.log(`带半场 ${all.length} | train ${train.length}/val ${val.length}/test ${test.length}`);

// 联赛 P(FT|HT) 转移(laplace)+ 全局
const trans = new Map(); const gT = {}; for (const ht of O) gT[ht] = { H: 1, D: 1, A: 1 };
for (const m of train) { const ht = sgn(m.halfHome, m.halfAway), ft = sgn(m.homeGoals, m.awayGoals); gT[ht][ft]++; const lg = m.league || "?"; let t = trans.get(lg); if (!t) { t = {}; for (const x of O) t[x] = { H: 1, D: 1, A: 1 }; trans.set(lg, t); } t[ht][ft]++; }
const normT = (t) => { const o = {}; for (const ht of O) { const s = t[ht].H + t[ht].D + t[ht].A; o[ht] = { H: t[ht].H / s, D: t[ht].D / s, A: t[ht].A / s }; } return o; };
const gTn = normT(gT); const transN = new Map(); for (const [lg, t] of trans) { const n = O.reduce((s, ht) => s + t[ht].H + t[ht].D + t[ht].A - 3, 0); if (n >= 300) transN.set(lg, normT(t)); }

// 模型 HT 边际(从 halfFullJoint joint 聚合)
function htMarginal(lh, la) { const j = toCode(halfFullJoint(lh, la)); if (!j) return null; const m = { H: 0, D: 0, A: 0 }; for (const c of C) m[c[0]] += j[c]; return m; }
// 转移 producer = P(HT)×P(FT|HT)
function transProducer(lh, la, lg) { const ht = htMarginal(lh, la); if (!ht) return null; const t = transN.get(lg) || gTn; const o = Object.fromEntries(C.map((c) => [c, 0])); for (const h of O) for (const f of O) o[h + f] = ht[h] * t[h][f]; return o; }

const prep = (rows) => rows.map((m) => { const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); const eg = p?.expectedGoals; const ok = eg && Number.isFinite(eg.home); return { y: sgn(m.halfHome, m.halfAway) + sgn(m.homeGoals, m.awayGoals), lh: ok ? eg.home : null, la: ok ? eg.away : null, lg: m.league || "?" }; }).filter((r) => r.lh != null);
const valR = prep(val), testR = prep(test);

// 经验联合(league HT-FT 频率,laplace)= 现行生产集成的第2路
const jLg = new Map(); const gJ = Object.fromEntries(C.map((c) => [c, 1]));
for (const m of train) { const c = sgn(m.halfHome, m.halfAway) + sgn(m.homeGoals, m.awayGoals); gJ[c]++; const lg = m.league || "?"; let e = jLg.get(lg); if (!e) { e = Object.fromEntries(C.map((x) => [x, 1])); jLg.set(lg, e); } e[c]++; }
const normJ = (e) => { const t = C.reduce((s, c) => s + e[c], 0); return Object.fromEntries(C.map((c) => [c, e[c] / t])); };
const gJn = normJ(gJ); const jN = new Map(); for (const [lg, e] of jLg) { const n = C.reduce((s, c) => s + e[c], 0) - 9; if (n >= 200) jN.set(lg, normJ(e)); }

const P = { notau: (r) => toCode(halfFullJoint(r.lh, r.la, { rho: 0 })), emp: (r) => jN.get(r.lg) || gJn, trans: (r) => transProducer(r.lh, r.la, r.lg) };
const KEYS = ["notau", "emp", "trans"];
const fuse = (r, w) => { const o = Object.fromEntries(C.map((c) => [c, 0])); let tw = 0; for (const k of KEYS) { const p = P[k](r), ww = w[k] || 0; if (!p || ww <= 0) continue; tw += ww; for (const c of C) o[c] += ww * p[c]; } if (tw <= 0) return null; for (const c of C) o[c] /= tw; return o; };
const llw = (rows, w) => ll(rows, (r) => fuse(r, w));

console.log(`\n单路 test LL: notau ${ll(testR, P.notau).toFixed(4)} | emp ${ll(testR, P.emp).toFixed(4)} | trans ${ll(testR, P.trans).toFixed(4)}`);
console.log(`现行生产(notau80%+emp20%) test LL ${llw(testR, { notau: 0.8, emp: 0.2 }).toFixed(4)}`);

// 三路前向逐步(val)
let w = {}; const b0 = KEYS.map((k) => [k, ll(valR, P[k])]).sort((a, b) => a[1] - b[1])[0][0]; w[b0] = 1; let cur = llw(valR, w); const trail = [`${b0}(基)`]; const AL = [0.05, 0.1, 0.15, 0.2, 0.3];
for (let it = 0; it < 8; it++) { let bg = 0, bk = null, ba = 0; for (const k of KEYS) for (const a of AL) { const ww = {}; for (const m of KEYS) ww[m] = (w[m] || 0) * (1 - a); ww[k] = (ww[k] || 0) + a; const l = llw(valR, ww); if (cur - l > bg + 1e-6) { bg = cur - l; bk = k; ba = a; } } if (!bk || bg < 0.0003) break; for (const m of KEYS) w[m] = (w[m] || 0) * (1 - ba); w[bk] = (w[bk] || 0) + ba; cur = llw(valR, w); trail.push(`+${bk}×${ba}`); }
let ws = 0; for (const k of KEYS) { if ((w[k] || 0) < 0.01) delete w[k]; else ws += w[k]; } for (const k of Object.keys(w)) w[k] = Math.round(w[k] / ws * 1000) / 1000;
const cur2 = llw(testR, { notau: 0.8, emp: 0.2 }), learned = llw(testR, w);
console.log(`\n三路前向逐步: ${trail.join(" → ")}`);
console.log(`权重: ${Object.entries(w).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" / ")}`);
console.log(`test LL 现行(notau+emp) ${cur2.toFixed(4)} → 三路学权 ${learned.toFixed(4)} | Δ${(cur2 - learned).toFixed(4)} 命中 ${(hit(testR, (r) => fuse(r, w)) * 100).toFixed(2)}%`);
console.log(cur2 - learned > 0.001 ? "→ 加转移路显著优于现行集成,值得升级生产" : "→ 转移与经验重叠,未超现行集成,诚实null");
