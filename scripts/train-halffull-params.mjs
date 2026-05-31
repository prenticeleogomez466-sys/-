/**
 * 自主半全场参数训练器(2026-05-31)——小模型自主化样板。
 * ════════════════════════════════════════════════════════════════════
 * 痛点:halftime-fulltime-model.fitHalfFullParams 早就能从真实半场拟合,
 *       但生产引擎一直用写死的 HF_DEFAULTS(0.45/0.45/-0.08/0.18),fit 能力从不接进生产。
 *       且此前 fixture-store 带半场仅 1 场 —— 现已富集到 33204 场(见 enrich-fixtures-half-odds)。
 *
 * 本训练器:
 *   1. 自主从 fixture-store 读全部带真实半场的历史场(collectHistoricalMatches,非引擎喂)。
 *   2. leak-safe 70/30 时间切分,DC 拟合 λ,对比"写死默认 vs 数据拟合(全局/分联赛收缩)+chase 网格"。
 *   3. 只有数据拟合在 holdout 上 LogLoss 不劣于默认才采信(诚实:打不过不硬塞)。
 *   4. 采信则用全量数据重拟合,落 halffull-params-profile.json(带 provenance,供引擎加载)。
 *
 * 用法:node scripts/train-halffull-params.mjs [--apply]
 *   不带 --apply 只回测打印;带 --apply 且拟合占优才写 profile。
 */
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";
import { halfFullJoint, HF_DEFAULTS } from "../src/halftime-fulltime-model.js";
import { getExportDir } from "../src/paths.js";

const APPLY = process.argv.includes("--apply");
const EPS = 1e-12;
const SHRINK_K = 300; // 分联赛向全局收缩门控:w=n/(n+K)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sg = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
const norm = (label) => label.replaceAll("主胜", "主").replaceAll("平局", "平").replaceAll("客胜", "客");
const CLASSES = ["主-主", "主-平", "主-客", "平-主", "平-平", "平-客", "客-主", "客-平", "客-客"];

// ── 1. 自主读 store(真实半场)─────────────────────────────────────
const all = collectHistoricalMatches(4000)
  .filter((m) => m.halfHome != null && m.halfAway != null && m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
console.log(`fixture-store 带真实半场 ${all.length} 场(${all[0]?.date}~${all.at(-1)?.date})`);
if (all.length < 500) { console.error("样本不足,放弃"); process.exit(1); }

const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`train ${train.length} / test ${test.length}`);

// ── 2. 拟合半场比例:全局 + 分联赛收缩 ────────────────────────────
function fitRatios(matches) {
  const G = { h1: 0, a1: 0, hf: 0, af: 0, n: 0 };
  const byLeague = new Map();
  for (const m of matches) {
    G.h1 += m.halfHome; G.a1 += m.halfAway; G.hf += m.homeGoals; G.af += m.awayGoals; G.n++;
    const L = byLeague.get(m.league) ?? { h1: 0, a1: 0, hf: 0, af: 0, n: 0 };
    L.h1 += m.halfHome; L.a1 += m.halfAway; L.hf += m.homeGoals; L.af += m.awayGoals; L.n++;
    byLeague.set(m.league, L);
  }
  const gHome = clamp(G.h1 / Math.max(G.hf, 1), 0.3, 0.6);
  const gAway = clamp(G.a1 / Math.max(G.af, 1), 0.3, 0.6);
  const perLeague = {};
  for (const [lg, L] of byLeague) {
    const w = L.n / (L.n + SHRINK_K);
    const rawHome = L.hf > 0 ? L.h1 / L.hf : gHome;
    const rawAway = L.af > 0 ? L.a1 / L.af : gAway;
    perLeague[lg] = {
      firstHalfRatioHome: clamp(w * rawHome + (1 - w) * gHome, 0.3, 0.6),
      firstHalfRatioAway: clamp(w * rawAway + (1 - w) * gAway, 0.3, 0.6),
      n: L.n, weight: Math.round(w * 1000) / 1000,
    };
  }
  return { global: { firstHalfRatioHome: gHome, firstHalfRatioAway: gAway }, perLeague };
}
const ratios = fitRatios(train);
console.log(`全局半场比例 主${ratios.global.firstHalfRatioHome.toFixed(3)}/客${ratios.global.firstHalfRatioAway.toFixed(3)} | 分联赛 ${Object.keys(ratios.perLeague).length} 个`);

function leagueRatio(rats, league) {
  return rats.perLeague[league] ?? rats.global;
}

// ── 3. DC 拟合 λ + holdout 多臂对比 ───────────────────────────────
const fitted = fitFromMatches(train);
console.log(`DC usable=${fitted.usable} teams=${Object.keys(fitted.teams || {}).length}`);

function toClassProbs(dict) {
  const out = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  let s = 0;
  for (const [k, v] of Object.entries(dict || {})) { const nk = norm(k); if (nk in out) { out[nk] += v; s += v; } }
  if (s > 0) for (const c of CLASSES) out[c] /= s;
  return out;
}

const arms = {
  "A 旧(0.46裸Poisson)": (lh, la) => toClassProbs(halfFullProbsFromLambdas(lh, la, 0.46)),
  "D 写死HF_DEFAULTS": (lh, la) => toClassProbs(halfFullJoint(lh, la)),
  "F 拟合全局 chase=0.18": (lh, la, lg) => toClassProbs(halfFullJoint(lh, la, { ...ratios.global, chase: 0.18 })),
  "F 拟合分联赛 chase=0": (lh, la, lg) => toClassProbs(halfFullJoint(lh, la, { ...leagueRatio(ratios, lg), chase: 0 })),
  "F 拟合分联赛 chase=0.18": (lh, la, lg) => toClassProbs(halfFullJoint(lh, la, { ...leagueRatio(ratios, lg), chase: 0.18 })),
  "F 拟合分联赛 chase=0.30": (lh, la, lg) => toClassProbs(halfFullJoint(lh, la, { ...leagueRatio(ratios, lg), chase: 0.30 })),
};

const stat = Object.fromEntries(Object.keys(arms).map((k) => [k, { ll: 0, brier: 0, hit: 0, htDrawPred: 0 }]));
let n = 0, htDrawActual = 0;
for (const m of test) {
  const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
  const lh = pred?.expectedGoals?.home, la = pred?.expectedGoals?.away;
  if (!Number.isFinite(lh) || !Number.isFinite(la)) continue;
  const actual = `${sg(m.halfHome, m.halfAway)}-${sg(m.homeGoals, m.awayGoals)}`;
  if (m.halfHome === m.halfAway) htDrawActual++;
  n++;
  for (const [name, fn] of Object.entries(arms)) {
    const p = fn(lh, la, m.league);
    stat[name].ll += -Math.log(Math.max(p[actual] ?? 0, EPS));
    for (const c of CLASSES) { const y = c === actual ? 1 : 0; stat[name].brier += (p[c] - y) ** 2; }
    const top = CLASSES.reduce((b, c) => (p[c] > p[b] ? c : b), CLASSES[0]);
    if (top === actual) stat[name].hit++;
    stat[name].htDrawPred += p["平-主"] + p["平-平"] + p["平-客"];
  }
}

console.log(`\n有效测试 ${n} 场(实际半时平局率 ${(htDrawActual / n * 100).toFixed(1)}%)\n`);
console.log("臂                        LogLoss   Brier    命中率   半时平局预测");
const rows = {};
for (const [name, s] of Object.entries(stat)) {
  rows[name] = { ll: s.ll / n, brier: s.brier / n, hit: s.hit / n, htDrawPred: s.htDrawPred / n };
  console.log(name.padEnd(22), rows[name].ll.toFixed(4).padStart(8), rows[name].brier.toFixed(4).padStart(8),
    (rows[name].hit * 100).toFixed(1).padStart(6) + "%", (rows[name].htDrawPred * 100).toFixed(1).padStart(8) + "%");
}

// ── 4. 裁决 + 落 profile ───────────────────────────────────────────
const baseLL = rows["D 写死HF_DEFAULTS"].ll;
const candidates = ["F 拟合全局 chase=0.18", "F 拟合分联赛 chase=0", "F 拟合分联赛 chase=0.18", "F 拟合分联赛 chase=0.30"];
let best = null;
for (const c of candidates) if (!best || rows[c].ll < rows[best].ll) best = c;
const delta = baseLL - rows[best].ll; // >0 = 拟合更好
const chaseOf = best.includes("chase=0.30") ? 0.30 : best.includes("chase=0") && !best.includes("0.18") ? 0 : 0.18;
const perLeagueMode = best.includes("分联赛");
console.log(`\n最优拟合臂=${best} | LogLoss ${rows[best].ll.toFixed(4)} vs 写死默认 ${baseLL.toFixed(4)} | Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`);

if (delta <= 0) {
  console.log("→ 数据拟合未优于写死默认,遵 no-fabrication 不写 profile(保留 HF_DEFAULTS)。");
  process.exit(0);
}
console.log(`→ 数据拟合占优(Δ${delta.toFixed(4)}),${APPLY ? "用全量数据重拟合并落 profile" : "(加 --apply 才写盘)"}`);
if (!APPLY) process.exit(0);

const full = fitRatios(all); // 全量重拟合供生产
const profile = {
  source: "fixture-store-halffull-walkforward",
  generatedAt: new Date().toISOString(),
  usable: true,
  nTotal: all.length,
  shrinkK: SHRINK_K,
  chase: chaseOf,
  rho: HF_DEFAULTS.rho,
  perLeagueMode,
  global: full.global,
  perLeague: full.perLeague,
  backtest: {
    nTest: n,
    defaultLL: Math.round(baseLL * 1e4) / 1e4,
    fittedLL: Math.round(rows[best].ll * 1e4) / 1e4,
    deltaLL: Math.round(delta * 1e4) / 1e4,
    bestArm: best,
    oldLL: Math.round(rows["A 旧(0.46裸Poisson)"].ll * 1e4) / 1e4,
  },
};
const out = join(getExportDir(), "halffull-params-profile.json");
if (existsSync(out)) copyFileSync(out, out + ".bak");
writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", "utf8");
console.log(`已写 ${out}(usable=true,${all.length} 场全量拟合,${Object.keys(full.perLeague).length} 联赛)`);
