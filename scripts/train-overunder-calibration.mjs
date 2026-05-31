/**
 * 自主大小球(over 2.5)校准训练器(2026-05-31)——低效市场实效验证。
 * ════════════════════════════════════════════════════════════════════
 * 大小球是记忆点名的"市场相对低效"玩法。fixture-store 富集后现有 33203 场
 * 真实总进球 + 收盘大小球隐含。本训练器自主验证:
 *   - 模型 P(over2.5)(DC λ 总量泊松)是否需要校准?
 *   - isotonic 校准能否降低模型 Brier/LogLoss?(同 1X2 isotonic 当年真出的效果)
 *   - 模型 vs 市场收盘线差距多大?融合有无增益?
 * leak-safe 70/30。isotonic 改善模型才落 overunder-calibration-profile.json(否则诚实弃用)。
 *
 * 用法:node scripts/train-overunder-calibration.mjs [--apply]
 */
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";
import { getExportDir } from "../src/paths.js";

const APPLY = process.argv.includes("--apply");
const EPS = 1e-12;
const clamp01 = (v) => Math.max(EPS, Math.min(1 - EPS, v));

// P(总进球 > 2.5):两独立泊松之和=Poisson(λT)。τ 对总量影响 <1e-3,忽略。
function pOver25(lh, la) {
  const lt = lh + la;
  if (!Number.isFinite(lt) || lt <= 0) return null;
  const p0 = Math.exp(-lt), p1 = p0 * lt, p2 = p1 * lt / 2;
  return clamp01(1 - p0 - p1 - p2);
}

const all = collectHistoricalMatches(4000)
  .filter((m) => m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const withMkt = all.filter((m) => m.marketHistorical && (m.marketHistorical.overProbClose != null || m.marketHistorical.overProb != null));
console.log(`fixture-store 带赛果 ${all.length} 场,其中带大小球隐含 ${withMkt.length} 场`);

const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
const fitted = fitFromMatches(train);
console.log(`train ${train.length} / test ${test.length} | DC usable=${fitted.usable} teams=${Object.keys(fitted.teams || {}).length}`);

// ── 训练集上收集 (模型P(over), 实际over) 拟合 isotonic ──
const trainObs = [];
for (const m of train) {
  const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
  const p = pOver25(pred?.expectedGoals?.home, pred?.expectedGoals?.away);
  if (p == null) continue;
  trainObs.push({ predicted: p, actual: (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0 });
}
const isoMap = buildIsotonicMap(trainObs);
console.log(`isotonic 训练样本 ${trainObs.length},knots ${isoMap?.knots?.length ?? 0}`);

// ── holdout 多臂 ──
const arms = {
  "模型原始 P(over)": (p, mk) => p,
  "模型+isotonic校准": (p, mk) => applyIsotonicMap(isoMap, p) ?? p,
  "市场收盘线": (p, mk) => mk,
  "融合 0.5模型校准+0.5市场": (p, mk) => mk == null ? (applyIsotonicMap(isoMap, p) ?? p) : 0.5 * (applyIsotonicMap(isoMap, p) ?? p) + 0.5 * mk,
};
const stat = Object.fromEntries(Object.keys(arms).map((k) => [k, { brier: 0, ll: 0, hit: 0, n: 0 }]));
let n = 0, nMkt = 0, overActual = 0;
// 校准桶(模型校准臂)
const buckets = Array.from({ length: 10 }, () => ({ pred: 0, act: 0, n: 0 }));

for (const m of test) {
  const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
  const praw = pOver25(pred?.expectedGoals?.home, pred?.expectedGoals?.away);
  if (praw == null) continue;
  const y = (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0;
  const mk = m.marketHistorical ? clamp01(m.marketHistorical.overProbClose ?? m.marketHistorical.overProb) : null;
  if (mk != null) nMkt++;
  overActual += y; n++;
  for (const [name, fn] of Object.entries(arms)) {
    const p = fn(praw, mk);
    if (p == null) continue; // 市场臂无盘口则跳过该场
    const pc = clamp01(p);
    stat[name].brier += (pc - y) ** 2;
    stat[name].ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
    if ((pc >= 0.5 ? 1 : 0) === y) stat[name].hit++;
    stat[name].n++;
  }
  const pcal = applyIsotonicMap(isoMap, praw) ?? praw;
  const bi = Math.min(9, Math.floor(pcal * 10));
  buckets[bi].pred += pcal; buckets[bi].act += y; buckets[bi].n++;
}

console.log(`\n有效测试 ${n} 场(实际 over2.5 率 ${(overActual / n * 100).toFixed(1)}%,带市场盘口 ${nMkt} 场)\n`);
console.log("臂                          样本   Brier    LogLoss  方向命中");
const rows = {};
for (const [name, s] of Object.entries(stat)) {
  if (!s.n) continue;
  rows[name] = { brier: s.brier / s.n, ll: s.ll / s.n, hit: s.hit / s.n, n: s.n };
  console.log(name.padEnd(24), String(s.n).padStart(5), rows[name].brier.toFixed(4).padStart(8),
    rows[name].ll.toFixed(4).padStart(8), (rows[name].hit * 100).toFixed(1).padStart(7) + "%");
}
console.log("\n模型+校准 校准桶(预测 vs 实际):");
buckets.forEach((b, i) => { if (b.n > 30) console.log(`  [${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}] 预测${(b.pred / b.n * 100).toFixed(1)}% 实际${(b.act / b.n * 100).toFixed(1)}% (n=${b.n})`); });

// ── 裁决 ──
const raw = rows["模型原始 P(over)"], cal = rows["模型+isotonic校准"], mkt = rows["市场收盘线"];
const dBrier = raw.brier - cal.brier; // >0 = 校准更好
console.log(`\n校准增益:Brier ${raw.brier.toFixed(4)}→${cal.brier.toFixed(4)} (Δ${dBrier >= 0 ? "+" : ""}${dBrier.toFixed(4)}) | LogLoss ${raw.ll.toFixed(4)}→${cal.ll.toFixed(4)}`);
if (mkt) console.log(`模型校准 vs 市场收盘:Brier ${cal.brier.toFixed(4)} vs ${mkt.brier.toFixed(4)}(市场${cal.brier <= mkt.brier ? "未" : ""}更优,差${(cal.brier - mkt.brier).toFixed(4)})`);

if (dBrier <= 0.0002) {
  console.log("→ isotonic 校准未显著改善模型(Δ≤0.0002),遵 no-fabrication 不落 profile。");
  process.exit(0);
}
console.log(`→ 校准显著改善模型 P(over)(Brier Δ${dBrier.toFixed(4)}),${APPLY ? "全量重拟合落 profile" : "(加 --apply 才写盘)"}`);
if (!APPLY) process.exit(0);

// 全量重拟合 isotonic 供生产
const fullFit = fitFromMatches(all);
const fullObs = [];
for (const m of all) {
  const pred = predictFromFitted(fullFit, { homeTeam: m.home, awayTeam: m.away });
  const p = pOver25(pred?.expectedGoals?.home, pred?.expectedGoals?.away);
  if (p != null) fullObs.push({ predicted: p, actual: (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0 });
}
const fullMap = buildIsotonicMap(fullObs);
const profile = {
  source: "fixture-store-overunder-isotonic",
  generatedAt: new Date().toISOString(),
  usable: true,
  market: "over2.5",
  nTrain: fullObs.length,
  isotonicMap: fullMap,
  backtest: {
    nTest: n,
    rawBrier: Math.round(raw.brier * 1e4) / 1e4,
    calBrier: Math.round(cal.brier * 1e4) / 1e4,
    deltaBrier: Math.round(dBrier * 1e4) / 1e4,
    marketBrier: mkt ? Math.round(mkt.brier * 1e4) / 1e4 : null,
  },
};
const out = join(getExportDir(), "overunder-calibration-profile.json");
if (existsSync(out)) copyFileSync(out, out + ".bak");
writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", "utf8");
console.log(`已写 ${out}(${fullObs.length} 场全量拟合,${fullMap.knots.length} knots)`);
