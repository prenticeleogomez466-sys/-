#!/usr/bin/env node
/**
 * Source Stability Monitor(数据源稳定性监控 — 把"忽好忽坏"量化出来)
 * ──────────────────────────────────────────────────────────────────
 * 每跑一次:① 实跑当天赔率抓取,记录每个赔率源 ok/抓到几条/错误;
 *           ② 实测免授权数据源在线探测;
 *           ③ 追加进滚动账本,重算每源 **成功率/连续失败/最近错误**。
 * 反复运行(过夜每 10 分钟一次)即可看出哪些源稳、哪些源该修/该弃。
 *
 * 账本:D:/football-model-exports/source-stability-ledger.json
 * 用法:node scripts/source-stability-monitor.mjs [YYYY-MM-DD]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crawlMarketData } from "../src/odds-crawler.js";
import { probeFreeSources } from "../src/free-source-probe.js";
import { stabilityCacheStats } from "../src/odds-stability-cache.js";
import { getExportDir } from "../src/paths.js";

const LEDGER = join(getExportDir(), "source-stability-ledger.json");
const MAX_RUNS = Number(process.env.SOURCE_MONITOR_MAX_RUNS ?? 400);

function loadLedger() {
  if (!existsSync(LEDGER)) return { runs: [], rollup: {} };
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return { runs: [], rollup: {} }; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 把抓取源的结果分三态:ok / fail / na(本就不适用,不计入成功率)。
//   na = 付费源故意没配 key、或今日没有该市场类型(如无 14 场时的胜负彩源)。
function classifyOdds(name, ok, fetched, error, hasShengfucai, hasJingcai) {
  if (ok) return "ok";
  const e = String(error ?? "");
  if (/缺少.*KEY|缺少 ODDS|未配置|ODDS_API_KEY/.test(e)) return "na";          // 付费源故意关
  if (/无需回填/.test(e)) return "ok";                                          // 缓存健康
  if (!hasShengfucai && /期号|14\s*场|euro-asian|澳盘|欧洲四大|matching rows|sfc/i.test(e)) return "na";
  if (!hasShengfucai && !hasJingcai) return "na";                              // 今日无可抓市场
  if (/缺亚盘 fixture 未获补救/.test(e) && !hasJingcai) return "na";
  return "fail";
}

function recordRollup(rollup, name, state, detail, at) {
  if (state === "na") {
    const r = rollup[name] ?? { runs: 0, oks: 0, successRate: 0, streakFail: 0, lastOk: null, lastError: null, na: 0 };
    r.na = (r.na ?? 0) + 1; r.lastNa = at;
    rollup[name] = r;
    return;
  }
  const ok = state === "ok";
  const r = rollup[name] ?? { runs: 0, oks: 0, successRate: 0, streakFail: 0, lastOk: null, lastError: null, na: 0 };
  r.runs += 1;
  if (ok) { r.oks += 1; r.streakFail = 0; r.lastOk = at; }
  else { r.streakFail += 1; r.lastError = detail || "fail"; }
  r.successRate = r.runs ? Math.round((r.oks / r.runs) * 1000) / 1000 : 0;
  rollup[name] = r;
}

async function main() {
  const date = process.argv[2] || today();
  const at = new Date().toISOString();
  const ledger = loadLedger();

  const run = { at, date, odds: {}, free: {}, cache: null };

  // ① 赔率抓取(实跑)
  let oddsResult = null;
  try {
    oddsResult = await crawlMarketData(date);
    const snaps = oddsResult.snapshots ?? [];
    const hasShengfucai = snaps.some((s) => s.marketType === "shengfucai");
    const hasJingcai = snaps.some((s) => s.marketType === "jingcai");
    for (const s of oddsResult.sources ?? []) {
      const state = classifyOdds(s.name, Boolean(s.ok), s.fetched ?? 0, s.error, hasShengfucai, hasJingcai);
      run.odds[s.name] = { state, fetched: s.fetched ?? 0, error: s.error ?? null };
      recordRollup(ledger.rollup, `[赔率] ${s.name}`, state, s.error, at);
    }
    // 合成主源信号:本批 jingcai 场次有多少拿到了"真实"竞彩盘口(让球线 + 非对称欧赔,
    // 且不是纯缓存/派生)—— 这是模型实际依赖的 500.com 实时盘口健康度。
    const jc = snaps.filter((s) => s.marketType === "jingcai");
    if (jc.length) {
      const usableJc = jc.filter((s) => {
        const cur = s.europeanOdds?.current ?? s.europeanOdds?.initial;
        return Number.isFinite(Number(s.jingcaiHandicap?.line)) && cur;
      }).length;
      const ok = usableJc === jc.length;
      run.odds["竞彩盘口覆盖(让球线+欧赔)"] = { state: ok ? "ok" : "fail", fetched: usableJc, error: ok ? null : `仅 ${usableJc}/${jc.length} 场有可用盘口` };
      recordRollup(ledger.rollup, "[赔率] 竞彩盘口覆盖(让球线+欧赔)", ok ? "ok" : "fail", `${usableJc}/${jc.length}`, at);
    }
    run.matched = oddsResult.matched;
    run.stabilityBackfilled = oddsResult.stabilityBackfilled ?? 0;
  } catch (e) {
    run.odds.__crawlError = e.message;
  }

  // ② 免授权源探测(实测)
  try {
    const probe = await probeFreeSources();
    for (const r of probe.results) {
      run.free[r.name] = { status: r.status, detail: r.detail, signal: r.signal };
      // usable=ok;empty=休赛期无数据(n/a,不算挂);blocked/error=真失败。
      const state = r.status === "usable" ? "ok" : r.status === "empty" ? "na" : "fail";
      recordRollup(ledger.rollup, `[免源] ${r.name}`, state, `${r.status}:${r.detail}`, at);
    }
  } catch (e) {
    run.free.__probeError = e.message;
  }

  // ③ 稳定缓存覆盖
  try { run.cache = stabilityCacheStats(); } catch { run.cache = null; }

  ledger.runs.push(run);
  if (ledger.runs.length > MAX_RUNS) ledger.runs = ledger.runs.slice(-MAX_RUNS);
  ledger.updatedAt = at;
  mkdirSync(getExportDir(), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  // ── 打印:本轮 + 滚动成功率(最差排前,便于盯修)──────────────────────
  console.log(`\n══ 数据源稳定性监控 · ${at} · 第 ${ledger.runs.length} 轮 ══`);
  if (oddsResult) console.log(`赔率: matched=${oddsResult.matched}/${oddsResult.fixtures}  稳定缓存回填=${run.stabilityBackfilled}`);
  if (run.cache) console.log(`稳定缓存: ${run.cache.fixtures} 场已存 last-good`, JSON.stringify(run.cache.byMarket));

  const all = Object.entries(ledger.rollup).map(([name, r]) => ({ name, ...r }));
  const active = all.filter((r) => (r.runs ?? 0) > 0).sort((a, b) => a.successRate - b.successRate || b.streakFail - a.streakFail);
  const naOnly = all.filter((r) => (r.runs ?? 0) === 0);
  console.log(`\n实测源(${active.length}) 成功率  连失  最近错误`);
  for (const r of active) {
    const bar = r.successRate >= 0.8 ? "🟢" : r.successRate >= 0.4 ? "🟡" : "🔴";
    console.log(`${bar} ${r.name.padEnd(42)} ${String(Math.round(r.successRate * 100)).padStart(3)}%  ${String(r.streakFail).padStart(3)}  ${(r.lastError || "").toString().slice(0, 50)}`);
  }
  if (naOnly.length) console.log(`\n未适用(今日无该市场/付费源未配): ${naOnly.map((r) => r.name.replace(/^\[赔率\] /, "")).join("、")}`);
  const stable = active.filter((r) => r.successRate >= 0.8).length;
  console.log(`\n稳定源(成功率≥80%): ${stable}/${active.length}  ·  账本: ${LEDGER}`);
}

main().catch((e) => { console.error("monitor error:", e); process.exit(1); });
