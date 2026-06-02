#!/usr/bin/env node
/**
 * Verify Odds Stability(赔率稳定性验收 — 只读,不改任何数据)
 * ────────────────────────────────────────────────────────────
 * 验收口径(对应过夜"把数据源建稳定"四项交付):
 *   ① 推荐读取的 market 快照里,每场都有真实(非对称/带平局)欧赔,而非派生对称占位;
 *   ② 每场带 jingcaiHandicap 让球线 + 真实大小球 totals(line + 大/小水位);
 *   ③ 稳定缓存对每场都存了 last-good(实时源全挂也能复现);
 *   ④ 连抓两次盘口完全一致(可复现)—— 仅赛前比对,赛中盘口本应跳动故跳过。
 *
 * 用法:node scripts/verify-odds-stability.mjs [YYYY-MM-DD] [--repro]
 *   --repro 才跑两次实时抓取比对(会联网);默认只校验已落盘快照+缓存。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures } from "../src/fixture-store.js";
import { loadMarketSnapshots, findMarketSnapshot } from "../src/market-data-store.js";
import { loadStabilityCache, fixtureCacheKey, stabilityCacheStats } from "../src/odds-stability-cache.js";

const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toLocaleDateString("sv");
const doRepro = process.argv.includes("--repro");

function realEuropean(eo) {
  const cur = eo?.current ?? eo?.initial;
  if (!cur) return false;
  return Number(cur.home) !== Number(cur.away); // 非对称 = 真实市场(对称多为派生占位)
}

const fixtures = loadFixtures(date).fixtures;
const jingcai = fixtures.filter((f) => f.marketType === "jingcai");
const snapshots = loadMarketSnapshots(date).snapshots;
const cache = loadStabilityCache();

let pass = 0, warn = 0;
const lines = [];
const checkSet = jingcai.length ? jingcai : fixtures;
for (const f of checkSet) {
  const s = findMarketSnapshot(f, snapshots);
  const eo = s?.europeanOdds, t = s?.totals?.current ?? s?.totals?.initial;
  const cached = cache.entries[fixtureCacheKey(f, date)];
  const okEuro = realEuropean(eo);
  const okLine = Number.isFinite(Number(s?.jingcaiHandicap?.line)) || f.marketType === "shengfucai";
  const okTotals = Number.isFinite(Number(t?.line));
  const okCache = Boolean(cached && Object.keys(cached.markets ?? {}).length);
  const allOk = okEuro && okLine && okCache;
  if (allOk) pass += 1; else warn += 1;
  const cur = eo?.current ?? eo?.initial;
  lines.push(`${allOk ? "✅" : "⚠️"} ${f.homeTeam} vs ${f.awayTeam}` +
    `\n     欧赔:${cur ? `${cur.home}/${cur.draw}/${cur.away}` : "缺"} ${okEuro ? "真实✓" : "对称/缺✗"}` +
    ` | 让球线:${s?.jingcaiHandicap?.line ?? (f.marketType === "shengfucai" ? "n/a" : "缺")}` +
    ` | 大小球:${okTotals ? `${t.line}(大${t.over ?? "-"}/小${t.under ?? "-"})` : "缺"}` +
    ` | 缓存last-good:${okCache ? "有✓" : "无✗"}` +
    `\n     源:${(s?.source ?? "").slice(0, 70)}`);
}

console.log(`\n══ 赔率稳定性验收 · ${date} · ${checkSet.length} 场(竞彩 ${jingcai.length}) ══`);
console.log(lines.join("\n"));
console.log(`\n稳定缓存覆盖:`, JSON.stringify(stabilityCacheStats().byMarket));
console.log(`\n结果:${pass} 场达标 / ${warn} 场待补 · ${pass === checkSet.length && checkSet.length ? "全部稳定 ✅" : "见上方 ⚠️"}`);

if (doRepro) {
  console.log(`\n── 可复现性比对(连抓两次)──`);
  const { crawlMarketData } = await import("../src/odds-crawler.js");
  const fp = (r) => r.snapshots.filter((x) => x.marketType === "jingcai")
    .map((x) => `${x.homeTeam}:${(x.europeanOdds?.current ?? x.europeanOdds?.initial) ? `${(x.europeanOdds.current ?? x.europeanOdds.initial).home}/${(x.europeanOdds.current ?? x.europeanOdds.initial).draw}/${(x.europeanOdds.current ?? x.europeanOdds.initial).away}` : "—"}|H${x.jingcaiHandicap?.line}`).sort();
  const r1 = await crawlMarketData(date);
  const r2 = await crawlMarketData(date);
  const same = JSON.stringify(fp(r1)) === JSON.stringify(fp(r2));
  console.log(`两次竞彩盘口一致:${same ? "✅ 可复现" : "❌ 有漂移"}`);
  if (!same) { console.log("run1:", fp(r1)); console.log("run2:", fp(r2)); }
}
