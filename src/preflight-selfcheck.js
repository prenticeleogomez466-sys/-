/**
 * 启动自检(2026-06-11 用户裁决:所有生成入口启动时都加一遍自检,红=拒跑拒交付)。
 * ════════════════════════════════════════════════════════════════════════════
 * 定位:秒级前置闸(每次生成必跑),与分钟级深闸 `npm run audit:suite`(16探针)互补——
 *   启动自检管"现在跑会不会用陈旧/缺失数据出错表",audit:suite 管"全链路逐环节取证"。
 * 检查面(全部只读、零网络、零兜底):
 *   ① 数据源新鲜度:48强Elo≤4天 / 逐场盘口≤36h / 天气≤48h(世界杯窗口内才查,窗口外自动休眠)
 *   ② 当日输入存在:fixtures 当日文件非空(供竞彩/14场生成)
 *   ③ 引擎活体冒烟:合成世界杯场必须路由 worldcup-match-model(0611铁律活性自证)
 *   ④ 复盘冻结基线存在且可解析(防偷看基线被误删)
 *   ⑤ 生产 profile 在位(fusion-signal-weights/league-reliability,缺=降级警告不拦)
 * 用法:模块 runPreflight({date}) → {ok, checks:[{id,level,ok,msg}]};CLI `npm run preflight`。
 * 入口接线均支持 --skip-preflight 逃生口(诊断用,日常严禁)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir, getExportDir, getProfilesDir } from "./paths.js";

const WC_START = "2026-06-11";
const WC_END = "2026-07-19";
const DAY_MS = 24 * 3600 * 1000;

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function inWorldCupWindow(dateStr) {
  const d = String(dateStr).slice(0, 10);
  return d >= WC_START && d <= WC_END;
}

/** 主入口。date 默认今天(本地)。返回 {ok, checks};level: red=拦截 / warn=放行但必须如实显示。 */
export async function runPreflight(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const date = opts.date ?? new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const checks = [];
  const add = (id, level, ok, msg) => checks.push({ id, level, ok, msg });
  const wcDir = join(getDataSubdir("world-cup"), "2026");
  const wcActive = inWorldCupWindow(date);

  // ① 世界杯数据源新鲜度(窗口内才查;窗口外休眠=不查不拦)
  if (wcActive) {
    const tp = readJson(join(wcDir, "team-priors.json"));
    const eloDate = tp?.elo_date ?? tp?.eloDate ?? null;
    const eloAgeDays = eloDate ? (now - new Date(eloDate + "T00:00:00Z")) / DAY_MS : Infinity;
    add("elo-fresh", "red", eloAgeDays <= 4.5, `48强Elo日期=${eloDate ?? "缺"}(${Number.isFinite(eloAgeDays) ? eloAgeDays.toFixed(1) + "天前" : "无法判定"});>4天陈化先跑 npm run sync:wc-elo`);

    const odds = readJson(join(wcDir, "match-odds.json"));
    let newestOdds = null;
    for (const f of odds?.fixtures ?? []) {
      const t = f.collectedAt ? new Date(f.collectedAt).getTime() : 0;
      if (t && (!newestOdds || t > newestOdds)) newestOdds = t;
    }
    const oddsAgeH = newestOdds ? (now - newestOdds) / 3600000 : Infinity;
    add("odds-fresh", "red", oddsAgeH <= 36, `逐场盘口最新=${newestOdds ? new Date(newestOdds).toISOString().slice(0, 16) : "缺"}(${Number.isFinite(oddsAgeH) ? oddsAgeH.toFixed(1) + "h前" : "无"});>36h 先跑 npm run wc:odds-capture`);

    const w = readJson(join(wcDir, "worldcup-weather.json"));
    const wAt = w?.updatedAt ?? w?.fetchedAt ?? null;
    const wAgeH = wAt ? (now - new Date(wAt)) / 3600000 : Infinity;
    add("weather-fresh", "red", wAgeH <= 48, `天气预报=${wAt ? wAt.slice(0, 16) : "缺"}(${Number.isFinite(wAgeH) ? wAgeH.toFixed(1) + "h前" : "无"});>48h 先跑 npm run sync:wc-weather`);

    // ④ 复盘冻结基线(防偷看)在位
    const frozen = readJson(join(getExportDir(), "worldcup-recap-baseline-frozen.json"));
    add("recap-baseline", "red", Boolean(frozen), "复盘冻结基线 worldcup-recap-baseline-frozen.json 在位且可解析(缺/坏=复盘口径会偷看,拦)");

    // 近5/H2H 缓存(观察项,缺只警告——wc-match-model 对缺标⚠️不兜底)
    const form = readJson(join(wcDir, "wc-national-results.json"));
    add("form-cache", "warn", Boolean(form), "国家队近5/H2H缓存(wc-national-results.json);缺=表中近5/H2H列标⚠️(跑 npm run wc:sync-form)");
  } else {
    add("wc-window", "warn", true, `非世界杯窗口(${date}),世界杯域检查休眠`);
  }

  // ② 当日 fixtures 输入(交给调用方决定是否必需:竞彩生成必需,逐场表可用赛程档)
  if (opts.requireFixtures !== false) {
    const fixturesPath = join(getDataSubdir("fixtures"), `${date}.json`);
    let n = 0;
    const fx = readJson(fixturesPath);
    n = Array.isArray(fx?.fixtures) ? fx.fixtures.length : Array.isArray(fx) ? fx.length : 0;
    add("fixtures-today", "red", n > 0, `当日 fixtures(${date}.json)=${n}场;0场=先跑抓取(npm run jingcai:daily 或 fixtures:sync:soft)`);
  }

  // ③ 引擎活体冒烟:世界杯窗口内,合成正赛场必须走 worldcup-match-model(铁律活性自证)
  if (wcActive) {
    try {
      const { predictFixture } = await import("./prediction-engine.js");
      const p = predictFixture({
        id: "preflight-smoke", homeTeam: "墨西哥", awayTeam: "南非",
        competition: "世界杯", kickoff: `${date} 12:00`, date, marketType: "jingcai"
      }, [], 0, {});
      add("engine-wc-route", "red", p?.provenance === "worldcup-match-model",
        `引擎世界杯路由活体=${p?.provenance ?? "无输出"}(必须=worldcup-match-model,否则0611铁律失效拒跑)`);
    } catch (e) {
      add("engine-wc-route", "red", false, `引擎冒烟抛错:${String(e.message).slice(0, 120)}`);
    }
  }

  // ⑤ 生产 profile 在位(缺=引擎自带降级标注,这里只警告促修)。与生产装载器同口径:profiles 持久目录优先、exports 根只读兼容。
  const profileAt = (name) => existsSync(join(getProfilesDir(), name)) || existsSync(join(getExportDir(), name));
  add("profile-fusion", "warn", profileAt("fusion-signal-weights.json"), "fusion-signal-weights.json 在位(缺=4害信号硬禁兜底运行,产物已带降级标注)");
  add("profile-league", "warn", profileAt("league-reliability.json"), "league-reliability.json 在位(缺=弱联赛不当胆护栏失效)");

  const ok = checks.every((c) => c.level !== "red" || c.ok);
  return { ok, date, checks };
}

/** 入口接线助手:跑自检并打印;红=直接退出拒交付(--skip-preflight 逃生口)。 */
export async function preflightOrDie(label, opts = {}) {
  if (process.argv.includes("--skip-preflight")) {
    console.log(`⚠️ [${label}] --skip-preflight:启动自检被显式跳过(诊断模式,产物勿直接交付)`);
    return { skipped: true };
  }
  const r = await runPreflight(opts);
  const icon = (c) => (c.ok ? "✅" : c.level === "red" ? "⛔" : "⚠️");
  console.log(`── 启动自检 [${label}] ${r.date} ──`);
  for (const c of r.checks) console.log(`${icon(c)} [${c.id}] ${c.msg}`);
  if (!r.ok) {
    console.error(`⛔ [${label}] 启动自检未过(红项见上)——按铁律拒跑拒交付。修复后重跑,或 --skip-preflight 仅作诊断。`);
    process.exit(1);
  }
  console.log(`── 自检通过,开始生成 ──\n`);
  return r;
}

// CLI: node src/preflight-selfcheck.js [--date=YYYY-MM-DD]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const dateArg = process.argv.find((a) => a.startsWith("--date="))?.slice(7);
  const r = await runPreflight({ date: dateArg });
  const icon = (c) => (c.ok ? "✅" : c.level === "red" ? "⛔" : "⚠️");
  console.log(`── 启动自检(独立CLI)${r.date} ──`);
  for (const c of r.checks) console.log(`${icon(c)} [${c.id}] ${c.msg}`);
  console.log(r.ok ? "✅ 自检通过" : "⛔ 自检未过(红项拦截)");
  process.exit(r.ok ? 0 : 1);
}
