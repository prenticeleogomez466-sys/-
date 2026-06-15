#!/usr/bin/env node
/**
 * 健康监控(2026-06-15 新功能):数据新鲜度 + 校准 reliability 漂移。
 * 默认展示型(exit0,监控不拦);--strict 且当天 fixtures 缺失/陈旧 → exit1(拒出表)。
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { assessFreshness, bucketReliability } from "../src/health-metrics.js";

const DATA = process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data";
const now = Date.now();
const strict = process.argv.includes("--strict");

function latestIn(subdir) {
  const dir = join(DATA, subdir);
  if (!existsSync(dir)) return { source: subdir, latestFile: null, mtimeMs: null };
  let best = null;
  for (const f of readdirSync(dir)) {
    let st; try { st = statSync(join(dir, f)); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
  }
  return { source: subdir, latestFile: best?.file ?? null, mtimeMs: best?.mtimeMs ?? null };
}

const sources = ["fixtures", "market", "advanced", "crawler", "world-cup"].map(latestIn);
const fresh = assessFreshness(sources, now);
console.log("── 数据新鲜度 ──");
for (const f of fresh) {
  const age = f.missing ? "(目录缺/空)" : `${f.ageHours}h 前`;
  const flag = f.stale ? (f.missing ? "⚠️" : "⚠️") : "✅";
  console.log(`  ${flag} ${f.source.padEnd(10)} ${age.padEnd(14)} ${f.stale && !f.missing ? `(>${f.limitHours}h)` : ""} ${f.latestFile ? `[${f.latestFile}]` : ""}`);
}

const ledgerPath = join(getExportDir(), "recommendation-ledger.json");
const rows = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
const dedup = new Map();
for (const r of rows) {
  if (!r.actual || !Number.isFinite(r.probabilityHome)) continue;
  dedup.set(`${r.match}|${r.actualScore}`, r);
}
const pairs = [...dedup.values()].map((r) => ({
  predicted: Math.max(r.probabilityHome, r.probabilityDraw, r.probabilityAway),
  hit: r.hit ? 1 : 0
}));
const rel = bucketReliability(pairs);
console.log("\n── 校准 reliability(favorite 预测 vs 实际,去重已结算)──");
for (const b of rel) {
  const mark = b.flagged ? "🔴" : b.samples ? "  " : "⏭️";
  const body = b.predicted != null ? `预测${(b.predicted * 100).toFixed(1)}% 实际${(b.actual * 100).toFixed(1)}% gap${(b.gap * 100).toFixed(1)}pp` : "无样本";
  console.log(`  ${mark} ${b.bucket.padEnd(7)} n=${String(b.samples).padEnd(3)} ${body}${b.flagged ? " ←系统性失准(样本足够)" : ""}`);
}

const flaggedRel = rel.filter((b) => b.flagged);
const fixturesStale = fresh.find((f) => f.source === "fixtures")?.stale;
if (strict && fixturesStale) {
  console.error("\n🔴 --strict: fixtures 数据缺失/陈旧,拒绝出表");
  process.exit(1);
}
if (flaggedRel.length) console.log(`\n⚠️ ${flaggedRel.length} 桶系统性失准 → 建议校准复查(监控提示,不拦交付)`);
console.log("✅ 健康监控完成(展示型,--strict 仅当天数据缺失才拦)");
process.exit(0);
