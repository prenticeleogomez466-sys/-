#!/usr/bin/env node
// audit-wc-pipeline —— 世界杯模型全链路零token硬闸(2026-06-11 体系化)
// 五层: S1数据源完整 → S2吸收闭合 → S3分析不变量 → S4输出三处一致 → S5复盘闭环
// 用法: node scripts/audit-wc-pipeline.mjs [--date=YYYY-MM-DD] [--wc-dir=DIR] [--data=DIR]
//        [--deliver=DIR] [--web=DIR] [--only=s1,s3] [--no-task-check] [--now=ISO]
// 退出码: 0=全绿可交付; 1=有红,拒绝交付。
// 原则: 检查目标缺失=显式SKIP并打印原因,绝不静默跳过(feedback_no_fallback_absolute);
//        工具链断裂(python/openpyxl不可用)=FAIL 而非 SKIP——零token闸必须真的在闸。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normTeam } from "../src/world-cup-priors.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const DATA = arg("data", process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data");
const WC = arg("wc-dir", path.join(DATA, "world-cup", "2026"));
const NOW = arg("now") ? Date.parse(arg("now")) : Date.now();
const DATE = arg("date", new Date(NOW + 8 * 3600e3).toISOString().slice(0, 10));
const DELIVER = arg("deliver", `C:\\Users\\Administrator\\Desktop\\足球推荐\\${DATE}`);
const WEB = arg("web", "D:\\Temp\\webshare_lingdao");
const ONLY = arg("only", "s1,s2,s3,s4,s5").split(",").map((s) => s.trim().toLowerCase());
const NO_TASK = process.argv.includes("--no-task-check");

const results = [];
function rec(id, status, detail) {
  results.push({ id, status, detail });
  const mark = status === "PASS" ? "✅" : status === "SKIP" ? "⏭️" : "❌";
  console.log(`${mark} [${id}] ${status} ${detail}`);
}
function loadJson(p, id) {
  if (!existsSync(p)) { rec(id, "FAIL", `${p} 不存在`); return null; }
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { rec(id, "FAIL", `${p} 解析失败: ${e.message}`); return null; }
}
const hours = (ms) => Math.round(ms / 3600e3);

// ── 公共底料(静默加载;各层对自己需要的输入显式报缺,避免--only定向跑时误伤) ──
function quietLoad(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
const fmt = quietLoad(path.join(WC, "format.json"));
const groups = quietLoad(path.join(WC, "groups.json"));
const priors = quietLoad(path.join(WC, "team-priors.json"));
const matchDates = quietLoad(path.join(WC, "match-dates.json"));
const venues = quietLoad(path.join(WC, "venues.json"));
const matchVenues = quietLoad(path.join(WC, "match-venues.json"));
if (ONLY.includes("s1")) {
  for (const [name, v] of [["format", fmt], ["groups", groups], ["team-priors", priors], ["match-dates", matchDates], ["venues", venues], ["match-venues", matchVenues]]) {
    if (!v) rec(`s1-${name}-load`, "FAIL", `${path.join(WC, name + ".json")} 缺失或解析失败`);
  }
}

// 赛会窗口: 由 match-dates 数据驱动,不硬编码
let inWindow = false, windowStr = "";
if (matchDates?.matchDate) {
  const dates = Object.values(matchDates.matchDate).map((m) => m.localDate).filter(Boolean).sort();
  const first = Date.parse(dates[0] + "T00:00:00Z") - 24 * 3600e3;
  const last = Date.parse(dates[dates.length - 1] + "T23:59:59Z") + 24 * 3600e3;
  inWindow = NOW >= first && NOW <= last;
  windowStr = `${dates[0]}..${dates[dates.length - 1]}`;
}

// 中英名双向映射 + 城市别名
const zhOf = groups?.team_name_zh || {};
const enOf = Object.fromEntries(Object.entries(zhOf).map(([en, zh]) => [zh, en]));
const cityAlias = matchVenues?.cityAliases || {};
const canonCity = (c) => cityAlias[c] || c;
const venueCities = new Set(Object.values(venues?.venues || {}).map((v) => v.city));

// ════ S1 数据源完整性 ════
if (ONLY.includes("s1")) {
  if (fmt) {
    const ok = fmt.teams === 48 && fmt.groups_count === 12 && fmt.group_size === 4 && fmt.total_matches === 104 && fmt.group_matches === 72;
    rec("s1-format", ok ? "PASS" : "FAIL", ok ? "48队/12组/4人组/104场/72小组赛" : `format异常: ${JSON.stringify({ t: fmt.teams, g: fmt.groups_count, s: fmt.group_size, m: fmt.total_matches })}`);
  }
  if (groups) {
    const gs = groups.groups || {};
    const teams = Object.values(gs).flat();
    const dup = teams.length !== new Set(teams).size;
    const ok = Object.keys(gs).length === 12 && teams.length === 48 && !dup && Object.values(gs).every((g) => g.length === 4);
    rec("s1-groups", ok ? "PASS" : "FAIL", ok ? "12组×4队=48无重复" : `分组异常: 组数${Object.keys(gs).length} 总队${teams.length} 重复=${dup}`);
    const missZh = teams.filter((t) => !zhOf[t]);
    rec("s1-zh-map", missZh.length ? "FAIL" : "PASS", missZh.length ? `中文名缺: ${missZh.join(",")}` : "48队中文名映射全覆盖");
  }
  if (priors && groups) {
    const ts = priors.teams || {};
    const names = Object.values(ts).map((t) => t.en);
    const all48 = Object.values(groups.groups || {}).flat();
    const missing = all48.filter((t) => !names.includes(t));
    const badElo = Object.entries(ts).filter(([, t]) => typeof t.elo !== "number" || t.elo < 1200 || t.elo > 2400);
    const age = (NOW - Date.parse(priors.elo_date + "T00:00:00Z")) / 86400e3;
    if (missing.length) rec("s1-priors-cover", "FAIL", `Elo先验缺队: ${missing.join(",")}`);
    else rec("s1-priors-cover", "PASS", `48/48队Elo先验齐(${Object.keys(ts).length}条)`);
    rec("s1-priors-elo-sane", badElo.length ? "FAIL" : "PASS", badElo.length ? `Elo越界: ${badElo.map(([k, t]) => `${k}=${t.elo}`).join(",")}` : "Elo全部在[1200,2400]");
    if (inWindow) rec("s1-elo-fresh", age <= 4 ? "PASS" : "FAIL", `elo_date=${priors.elo_date}(${age.toFixed(1)}天前)${age > 4 ? " 超4天陈化,跑 npm run sync:wc-elo" : ""}`);
    else rec("s1-elo-fresh", "SKIP", `非赛会窗口(${windowStr}),不查Elo时效`);
  }
  const bracket = loadJson(path.join(WC, "bracket.json"), "s1-bracket-load");
  if (bracket) {
    const ok = bracket.r32?.length === 16 && bracket.r16?.length === 8 && bracket.qf?.length === 4 && bracket.sf?.length === 2 && bracket.final && Object.keys(bracket.thirdPlaceTable || {}).length === 495;
    rec("s1-bracket", ok ? "PASS" : "FAIL", ok ? "FIFA官方对阵表完整(R32×16/R16×8/QF×4/SF×2/决赛+第三名495组合)" : "bracket结构缺损");
  }
  if (matchDates) {
    const md = matchDates.matchDate || {};
    const rows = Object.values(md);
    const bad = rows.filter((m) => !m.dateUtc || Number.isNaN(Date.parse(m.dateUtc)) || !m.homeTeam || !m.awayTeam || !m.venueCity);
    const groupRows = rows.filter((m) => m.group && [1, 2, 3].includes(m.round));
    const badCity = rows.filter((m) => !venueCities.has(canonCity(m.venueCity)));
    if (rows.length !== 104 || bad.length) rec("s1-matchdates", "FAIL", `104场不齐(${rows.length})或字段缺${bad.length}场`);
    else rec("s1-matchdates", "PASS", `104场全带dateUtc/对阵/城市,小组赛${groupRows.length}场`);
    rec("s1-matchdates-city", badCity.length ? "FAIL" : "PASS", badCity.length ? `城市无法落到16场馆: ${[...new Set(badCity.map((m) => m.venueCity))].join(",")}` : "104场城市全部落在16场馆(含别名)");
  }
  if (venues) {
    const vs = Object.values(venues.venues || {});
    const bad = vs.filter((v) => typeof v.altitude_m !== "number" || typeof v.june_july_avg_temp_c !== "number" || !v.city_zh);
    rec("s1-venues", vs.length === 16 && !bad.length ? "PASS" : "FAIL", `16场馆海拔/均温/中文名${bad.length ? `缺${bad.length}个` : "齐"}`);
  }
  if (matchVenues) rec("s1-matchvenues", Object.keys(matchVenues.matchCity || {}).length === 104 ? "PASS" : "FAIL", `matchCity映射${Object.keys(matchVenues.matchCity || {}).length}/104`);
  const weather = loadJson(path.join(WC, "worldcup-weather.json"), "s1-weather-load");
  if (weather && matchDates) {
    const ageH = hours(NOW - Date.parse(weather.updatedAt));
    const cities = Object.keys(weather.byCity || {});
    if (inWindow) rec("s1-weather-fresh", ageH <= 48 ? "PASS" : "FAIL", `天气预报${ageH}h前更新(${cities.length}城)${ageH > 48 ? " 超48h,跑 npm run sync:wc-weather" : ""}`);
    else rec("s1-weather-fresh", "SKIP", "非赛会窗口");
    const upcoming = Object.values(matchDates.matchDate).filter((m) => { const t = Date.parse(m.dateUtc); return t > NOW && t < NOW + 5 * 86400e3; });
    const missW = upcoming.filter((m) => !weather.byCity?.[canonCity(m.venueCity)]?.[m.localDate]);
    rec("s1-weather-cover", missW.length ? "FAIL" : upcoming.length ? "PASS" : "SKIP", missW.length ? `未来5天${missW.length}场缺该城该日预报: ${missW.slice(0, 3).map((m) => `${m.venueCity}@${m.localDate}`).join(";")}…` : upcoming.length ? `未来5天${upcoming.length}场天气全覆盖(真预报非静态均温)` : "未来5天无场次");
  }
  const odds = loadJson(path.join(WC, "match-odds.json"), "s1-odds-load");
  if (odds && matchDates) {
    const fx = odds.fixtures || [];
    const badOdds = fx.filter((f) => !(f.odds?.home > 1.01 && f.odds?.draw > 1.01 && f.odds?.away > 1.01));
    const badOver = fx.filter((f) => { const s = 1 / f.odds.home + 1 / f.odds.draw + 1 / f.odds.away; return !(s >= 0.98 && s <= 1.35); });
    rec("s1-odds-sane", badOdds.length || badOver.length ? "FAIL" : "PASS", badOdds.length || badOver.length ? `坏赔率${badOdds.length}场/overround越界${badOver.length}场` : `${fx.length}场赔率合法(overround∈[0.98,1.35])`);
    const newest = Math.max(...fx.map((f) => Date.parse(f.collectedAt || 0)), 0);
    const next36 = Object.values(matchDates.matchDate).filter((m) => { const t = Date.parse(m.dateUtc); return t > NOW && t < NOW + 36 * 3600e3; });
    // 2026-06-12 修误报:match-dates 队名(USA)与 ESPN 赔率队名(United States)是同队不同写法,
    //   字面键匹配把已捕获赔率误报成缺——复用生产同一套 normTeam 归一(别名表单一权威,不另造表)。
    const key = (h, a) => `${normTeam(h)}|${normTeam(a)}`;
    const have = new Set(fx.map((f) => key(f.home, f.away)));
    const missing = next36.filter((m) => !have.has(key(m.homeTeam, m.awayTeam)) && !have.has(key(m.awayTeam, m.homeTeam)));
    if (inWindow && next36.length) {
      rec("s1-odds-fresh", hours(NOW - newest) <= 36 ? "PASS" : "FAIL", `最新赔率${hours(NOW - newest)}h前(${odds._provenance?.note || "ESPN core"})${hours(NOW - newest) > 36 ? " 续鲜断了,跑 npm run refresh:wc-odds-espn" : ""}`);
      rec("s1-odds-cover", missing.length ? "FAIL" : "PASS", missing.length ? `未来36h ${missing.length}场无赔率: ${missing.slice(0, 4).map((m) => `${m.homeTeam}-${m.awayTeam}`).join(";")}` : `未来36h ${next36.length}场赔率全覆盖`);
    } else { rec("s1-odds-fresh", "SKIP", inWindow ? "未来36h无场次" : "非赛会窗口"); rec("s1-odds-cover", "SKIP", "同上"); }
  }
  // 大小球totals(可选锐盘源:Pinnacle主线+devig)。未采用=SKIP;一旦落档,在窗内就必须保鲜(陈数据比没数据更毒)
  const totals = quietLoad(path.join(WC, "match-totals.json"));
  if (!totals) rec("s1-totals", "SKIP", "match-totals.json 未落档(可选源,跑 node scripts/sync-wc-totals.mjs 接入)");
  else {
    const ageH = hours(NOW - Date.parse(totals.updatedAt));
    const bad = (totals.fixtures || []).filter((f) => !(f.over > 1.01 && f.under > 1.01 && f.pOver > 0 && f.pOver < 1));
    if (bad.length) rec("s1-totals", "FAIL", `${bad.length}场totals坏赔率/坏概率`);
    else if (inWindow && ageH > 48) rec("s1-totals", "FAIL", `totals已${ageH}h未刷新(采用即保鲜,跑 node scripts/sync-wc-totals.mjs)`);
    else rec("s1-totals", "PASS", `${totals.count}场大小球真实盘(${ageH}h前,源=${(totals.fixtures?.[0]?.book) || "?"})`);
  }
}

// ════ S2 吸收闭合(每日竞彩store行 → 引擎真实链路 worldCupLambdaContext/teamPrior 无断点) ════
// 不重造解析:直接调用生产代码,抓的是"venue恒null/先验null静默失效"这类真雷(2026-06-07 体检同类)。
if (ONLY.includes("s2")) {
  const fxPath = path.join(DATA, "fixtures", `${DATE}.json`);
  if (!existsSync(fxPath)) rec("s2-store", "SKIP", `${fxPath} 不存在(当日无store,出表前会生成)`);
  else {
    let list = [];
    try { const fx = JSON.parse(readFileSync(fxPath, "utf8")); list = Array.isArray(fx) ? fx : fx.fixtures || []; }
    catch (e) { rec("s2-store", "FAIL", `store解析失败: ${e.message}`); list = null; }
    if (list) {
      const wcRows = list.filter((m) => /世界杯/.test(m.competition || m.league || "") && m.marketType !== "shengfucai");
      if (!wcRows.length) rec("s2-store", "SKIP", "当日store无世界杯竞彩行");
      else {
        try {
          const { pathToFileURL } = await import("node:url");
          const wp = await import(pathToFileURL(path.join(ROOT, "src", "world-cup-priors.js")).href);
          const notWC = [], noVenue = [], noPrior = [];
          for (const m of wcRows) {
            const ctx = wp.worldCupLambdaContext(m, m.kickoff || m.matchDate || m.date);
            if (!ctx.isWC) { notWC.push(`${m.homeTeam}-${m.awayTeam}`); continue; }
            if (!ctx.venue) noVenue.push(`${m.homeTeam}-${m.awayTeam}`);
            if (!wp.teamPrior(m.homeTeam) || !wp.teamPrior(m.awayTeam)) noPrior.push(`${m.homeTeam}-${m.awayTeam}`);
          }
          rec("s2-iswc-closure", notWC.length ? "FAIL" : "PASS", notWC.length ? `${notWC.length}场isWC误判false(海拔/天气先验整批漏): ${notWC.slice(0, 4).join(";")}` : `${wcRows.length}场世界杯行isWC识别全通`);
          rec("s2-venue-closure", noVenue.length ? "FAIL" : "PASS", noVenue.length ? `${noVenue.length}场引擎解析venue=null(海拔/天气λ静默失效): ${noVenue.slice(0, 4).join(";")}` : "场馆→海拔/天气λ链路全闭合(引擎实测)");
          rec("s2-prior-closure", noPrior.length ? "FAIL" : "PASS", noPrior.length ? `${noPrior.length}场Elo先验解析null(别名表洞): ${noPrior.slice(0, 4).join(";")}` : "中文队名→Elo先验全闭合(引擎实测)");
        } catch (e) { rec("s2-engine", "FAIL", `引擎链路调用失败: ${String(e.message).slice(0, 150)}`); }
      }
    }
  }
}

// ════ S3 分析不变量(超算概率+冻结基线) ════
if (ONLY.includes("s3")) {
  const sc = loadJson(path.join(WC, "worldcup-supercomputer.json"), "s3-sc-load");
  if (sc) {
    const rows = sc.rows || [];
    const errs = [];
    if (rows.length !== 48) errs.push(`rows=${rows.length}≠48`);
    const champSum = rows.reduce((s, r) => s + (r.champion || 0), 0);
    const advSum = rows.reduce((s, r) => s + (r.advance || 0), 0);
    if (Math.abs(champSum - 1) > 1e-6) errs.push(`夺冠和=${champSum.toFixed(6)}≠1`);
    if (Math.abs(advSum - 32) > 1e-6) errs.push(`出线和=${advSum.toFixed(4)}≠32`);
    for (const r of rows) {
      const chain = [r.advance, r.r16, r.qf, r.sf, r.final, r.champion];
      if (chain.some((x) => typeof x !== "number" || x < 0 || x > 1)) { errs.push(`${r.team}概率越界`); break; }
      for (let i = 1; i < chain.length; i++) if (chain[i] > chain[i - 1] + 1e-9) { errs.push(`${r.team}单调性破: ${chain.map((x) => x.toFixed(3)).join("≥")}`); break; }
    }
    const a = sc.alpha;
    if (typeof a === "number") {
      const badBlend = rows.filter((r) => typeof r.market === "number" && typeof r.blend === "number" && Math.abs(r.blend - (a * r.market + (1 - a) * r.champion)) > 1e-6);
      if (badBlend.length) errs.push(`${badBlend.length}队blend≠α·市场+(1-α)·模型`);
    }
    rec("s3-sc-invariants", errs.length ? "FAIL" : "PASS", errs.length ? errs.join("; ") : `48队 夺冠和=1 出线和=32 单调链✓ blend公式✓ (n=${sc.n},seed=${sc.seed})`);
    const ageH = hours(NOW - Date.parse(sc.generatedAt));
    if (inWindow) rec("s3-sc-fresh", ageH <= 72 ? "PASS" : "FAIL", `超算${ageH}h前生成${ageH > 72 ? "(超72h,赛果已变,重跑 run-worldcup-supercomputer.mjs)" : ""}`);
    else rec("s3-sc-fresh", "SKIP", "非赛会窗口");
    if (priors) {
      const prEn = new Set(Object.values(priors.teams || {}).map((t) => t.en));
      const missing = rows.filter((r) => !prEn.has(r.en));
      rec("s3-sc-teams", missing.length ? "FAIL" : "PASS", missing.length ? `超算队伍不在先验表: ${missing.map((r) => r.en).join(",")}` : "超算48队与Elo先验表一致");
    }
  }
  // 冻结基线防重写(赛前基线绝不可重冻)
  const freezePath = path.join(ROOT, "scripts", "wc-baseline-freeze.json");
  if (!existsSync(freezePath)) rec("s3-baseline-freeze", "FAIL", `${freezePath} 不存在,冻结登记缺失`);
  else {
    const freeze = JSON.parse(readFileSync(freezePath, "utf8"));
    const broken = [];
    for (const [file, sha] of Object.entries(freeze.files || {})) {
      const p = path.join(WC, file);
      if (!existsSync(p)) { broken.push(`${file} 被删除`); continue; }
      const cur = createHash("sha256").update(readFileSync(p)).digest("hex");
      if (cur !== sha) broken.push(`${file} 内容被改(基线重冻=作弊)`);
    }
    rec("s3-baseline-freeze", broken.length ? "FAIL" : "PASS", broken.length ? broken.join("; ") : `${Object.keys(freeze.files || {}).length}个冻结基线文件sha256未被触碰`);
  }
}

// ════ S4 输出层(xlsx结构/透明度/概率合法 + 三处一致) ════
if (ONLY.includes("s4")) {
  if (!existsSync(DELIVER)) rec("s4-deliver", "SKIP", `${DELIVER} 不存在(当日未交付;出表后必须重跑本闸)`);
  else {
    const xlsx = path.join(DELIVER, `神选-竞彩推荐-${DATE}.xlsx`);
    let pyOut = null;
    if (!existsSync(xlsx)) rec("s4-xlsx", "SKIP", `${xlsx} 不存在(当日无竞彩交付)`);
    else {
      try {
        const raw = execFileSync("python", [path.join(ROOT, "scripts", "check-wc-xlsx.py"), xlsx], { encoding: "utf8", timeout: 60000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        pyOut = JSON.parse(raw);
        if (pyOut.errors.length) rec("s4-xlsx", "FAIL", `${pyOut.errors.length}处: ` + pyOut.errors.slice(0, 6).join(" | "));
        else rec("s4-xlsx", "PASS", `${pyOut.matches.length}场×${pyOut.cols}列 结构/透明度/概率/深紫表头全过${pyOut.warnings.length ? `(警告${pyOut.warnings.length})` : ""}`);
      } catch (e) {
        rec("s4-xlsx", "FAIL", `xlsx检查器执行失败(python/openpyxl断=闸断,必须修): ${String(e.message).slice(0, 150)}`);
      }
    }
    // 三处一致: xlsx ↔ html ↔ 对抗审计json
    if (pyOut?.matches?.length) {
      const htmlPath = path.join(DELIVER, "今日足球推荐.html");
      if (!existsSync(htmlPath)) rec("s4-html-consist", "FAIL", "交付夹缺 今日足球推荐.html");
      else {
        const html = readFileSync(htmlPath, "utf8");
        const missH = pyOut.matches.filter((m) => !html.includes(`${m.home} vs ${m.away}`));
        rec("s4-html-consist", missH.length ? "FAIL" : "PASS", missH.length ? `html缺${missH.length}场: ${missH.slice(0, 3).map((m) => m.home + "-" + m.away).join(";")}` : `html与xlsx ${pyOut.matches.length}场对阵一致`);
        const garbage = [/&lt;span/i, /undefined/, /\bNaN\b/, /\{\{/].filter((re) => re.test(html));
        rec("s4-html-garbage", garbage.length ? "FAIL" : "PASS", garbage.length ? `命中: ${garbage.join(" ")}` : "交付html无渲染垃圾");
      }
      const advPath = path.join(DATA, "adversarial", `${DATE}.json`);
      if (!existsSync(advPath)) {
        // 2026-06-12 对齐 0611 用户裁决(feedback_football_always_workflow):signal-verify workflow
        // 仅用户明说才跑,默认单线零token。当日未跑≠闸断,但交付必须逐场诚实标"⚠️未跑"且
        // 绝不出现伪造的证伪背书——诚实标注=SKIP(留痕),发现假背书/无标注=FAIL(防编造审计声明)。
        const xlsxHonest = (() => {
          try {
            const raw = execFileSync("python", ["-c", `
import openpyxl,json,sys
sys.stdout.reconfigure(encoding='utf-8')
wb=openpyxl.load_workbook(r'${path.join(DELIVER, `神选-竞彩推荐-${DATE}.xlsx`)}',read_only=True)
ws=wb[wb.sheetnames[0]]
rows=list(ws.iter_rows(values_only=True))
hi=next((i for i,r in enumerate(rows) if r and any('对阵' in str(c) for c in r if c)),2)
hdr=[str(c) if c else '' for c in rows[hi]]
ais=[i for i,n in enumerate(hdr) if '证伪' in n]
if not ais:
    print(json.dumps({'total':0,'honest':0,'fake':0,'nohdr':True}))
else:
    ai=ais[0]
    cells=[str(r[ai] or '') for r in rows[hi+1:] if r and r[2]]
    print(json.dumps({'total':len(cells),'honest':sum(1 for c in cells if '未跑' in c or '未审计' in c),'fake':sum(1 for c in cells if ('通过' in c or '三票' in c) and '未跑' not in c)}))
`], { encoding: "utf8", timeout: 60000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
            return JSON.parse(raw);
          } catch { return null; }
        })();
        if (!xlsxHonest) rec("s4-adversarial", "FAIL", "对抗审计缺失且无法核验xlsx证伪列诚实标注(检查器断=闸断)");
        else if (xlsxHonest.fake > 0 || xlsxHonest.honest < xlsxHonest.total) rec("s4-adversarial", "FAIL", `对抗审计未跑但xlsx证伪列有${xlsxHonest.fake}处疑似假背书/${xlsxHonest.total - xlsxHonest.honest}处未诚实标'未跑'——绝不编造审计声明`);
        else rec("s4-adversarial", "SKIP", `当日未跑signal-verify(0611裁决:用户明说才起workflow);xlsx证伪列${xlsxHonest.total}场全部诚实标'⚠️未跑',串关列已按'证伪未覆盖'降🟡`);
      }
      else {
        const adv = JSON.parse(readFileSync(advPath, "utf8"));
        const keys = new Set(Object.keys(adv.verdicts || {}));
        const missA = pyOut.matches.filter((m) => !keys.has(`${m.home}|${m.away}`));
        rec("s4-adversarial", missA.length ? "FAIL" : "PASS", missA.length ? `${missA.length}场无对抗证伪: ${missA.slice(0, 3).map((m) => m.home + "-" + m.away).join(";")}` : `对抗证伪${keys.size}场全覆盖`);
      }
    }
  }
  // 实盘下注单一致性(存在才查): 决策源必须=世界杯模型(0611铁律) + EV算术逐行复核 + 14场腿全
  const slipPath = path.join(process.env.FOOTBALL_EXPORT_DIR || "D:\\football-model-exports", `wc-betting-slip-${DATE}.json`);
  if (!existsSync(slipPath)) rec("s4-slip", "SKIP", "当日无实盘下注单(出单后必须重跑本闸)");
  else {
    try {
      const slip = JSON.parse(readFileSync(slipPath, "utf8"));
      const errs = [];
      if (slip.source?.model !== "wc-match-model") errs.push(`决策源=${slip.source?.model}≠wc-match-model(违反0611铁律)`);
      // 赔率新鲜度: 单子引用的竞彩价超10h=陈价,真钱下注前必须重抓重出单(0611挑毛病新增)
      const oddsAge = hours(NOW - Date.parse(slip.source?.jingcaiOddsAt || 0));
      if (!Number.isFinite(oddsAge) || oddsAge > 10) errs.push(`下注单竞彩价${Number.isFinite(oddsAge) ? oddsAge + "h" : "无时间戳"}陈旧(>10h),重抓market后重跑 build-wc-betting-slip`);
      const badEv = (slip.rows || []).filter((r) => Math.abs(r.ev - (r.modelProb * r.odds - 1)) > 0.005);
      if (badEv.length) errs.push(`${badEv.length}行EV算术不符`);
      if (!(slip.rows || []).length) errs.push("下注单0行");
      const f = slip.fourteen;
      if (f && !f.error) {
        if ((f.legs || []).length !== 14) errs.push(`14场腿数=${f.legs?.length}≠14`);
        const noPred = (f.legs || []).filter((l) => l.error).length;
        if (noPred > 0) errs.push(`${noPred}腿无世界杯模型预测(已如实标缺,核对是否该有)`);
      }
      rec("s4-slip", errs.length ? "FAIL" : "PASS", errs.length ? errs.join("; ") : `下注单${slip.rows.length}注+${(slip.parlays || []).length}串+14场${f && !f.error ? "14腿" : "无"} 源/EV/腿数全核过`);
    } catch (e) { rec("s4-slip", "FAIL", `下注单解析失败: ${e.message}`); }
  }
  // worldcup.html ↔ 超算json 数字一致(站点常驻页)
  const wcHtmlPath = path.join(WEB, "worldcup.html");
  const sc2 = existsSync(path.join(WC, "worldcup-supercomputer.json")) ? JSON.parse(readFileSync(path.join(WC, "worldcup-supercomputer.json"), "utf8")) : null;
  if (!existsSync(wcHtmlPath)) rec("s4-wchtml", inWindow ? "FAIL" : "SKIP", `${wcHtmlPath} 不存在`);
  else if (sc2) {
    const html = readFileSync(wcHtmlPath, "utf8");
    const top3 = [...sc2.rows].sort((x, y) => y.blend - x.blend).slice(0, 3);
    // 页面渲染精度可能是1位或2位小数,两种都认
    const hasNum = (v) => html.includes((v * 100).toFixed(1)) || html.includes((v * 100).toFixed(2));
    const miss = top3.filter((r) => !html.includes(r.team) || !hasNum(r.blend));
    rec("s4-wchtml", miss.length ? "FAIL" : "PASS", miss.length ? `worldcup.html与超算不同步: ${miss.map((r) => `${r.team}应${(r.blend * 100).toFixed(2)}%`).join(";")}(重跑 build_wc_html)` : `worldcup.html Top3(${top3.map((r) => r.team + (r.blend * 100).toFixed(1) + "%").join("/")})与超算json一致`);
  }
}

// ════ S5 复盘闭环(预测→赛果→逐场复盘回灌) ════
if (ONLY.includes("s5")) {
  if (NO_TASK) rec("s5-recap-task", "SKIP", "--no-task-check");
  else {
    try {
      const out = execFileSync("schtasks", ["/query", "/tn", "FootballModel-RecapBacktest", "/fo", "LIST", "/v"], { encoding: "utf8", timeout: 15000 });
      const disabled = /Disabled/i.test(out.split(/\r?\n/).find((l) => /^Status|^状态/.test(l.trim())) || "");
      const lastRes = (out.match(/Last Result:\s*(-?\d+)/i) || [])[1];
      if (disabled) rec("s5-recap-task", "FAIL", "RecapBacktest被禁用,复盘闭环断(用户裁决保留的唯一每日任务)");
      else if (lastRes && lastRes !== "0" && lastRes !== "267011") rec("s5-recap-task", "FAIL", `RecapBacktest上次退出码=${lastRes},查日志`);
      else rec("s5-recap-task", "PASS", `RecapBacktest在线(上次结果=${lastRes ?? "未知"})`);
    } catch (e) { rec("s5-recap-task", "FAIL", `查任务失败: ${String(e.message).slice(0, 100)}`); }
  }
  // 完赛>24h的世界杯场必须有结果落store(复盘可信的前提)
  if (matchDates) {
    const finished = Object.values(matchDates.matchDate).filter((m) => Date.parse(m.dateUtc) + 5 * 3600e3 < NOW - 24 * 3600e3);
    if (!finished.length) rec("s5-result-closure", "SKIP", "尚无完赛超24h的世界杯场(首战后自动生效)");
    else {
      const missing = [];
      for (const m of finished) {
        const ld = new Date(Date.parse(m.dateUtc) + 8 * 3600e3).toISOString().slice(0, 10); // 北京日
        let found = false;
        for (const d of [ld, m.localDate]) {
          const p = path.join(DATA, "fixtures", `${d}.json`);
          if (!existsSync(p)) continue;
          try {
            const fx = JSON.parse(readFileSync(p, "utf8"));
            const list = Array.isArray(fx) ? fx : fx.fixtures || [];
            const zh = [zhOf[m.homeTeam], zhOf[m.awayTeam]];
            if (list.some((r) => [r.homeTeam, r.awayTeam].filter(Boolean).every((t) => zh.includes(t)) && (r.result || r.finalScore))) { found = true; break; }
          } catch { /* 坏文件由store探针管 */ }
        }
        if (!found) missing.push(`${m.homeTeam}-${m.awayTeam}@${m.localDate}`);
      }
      rec("s5-result-closure", missing.length ? "FAIL" : "PASS", missing.length ? `${missing.length}场完赛>24h无赛果(复盘断链,跑 npm run recap:backfill): ${missing.slice(0, 4).join(";")}` : `${finished.length}场完赛赛果全回收`);
    }
    // 逐场复盘累计表(wc:recap-match 产物)
    const recapDir = "C:\\Users\\Administrator\\Desktop\\足球推荐\\世界杯复盘";
    const anyFinished = Object.values(matchDates.matchDate).some((m) => Date.parse(m.dateUtc) + 5 * 3600e3 < NOW - 24 * 3600e3);
    if (!anyFinished) rec("s5-recap-table", "SKIP", "首战完赛前不要求复盘表产出");
    else if (!existsSync(recapDir) || !readdirSync(recapDir).length) rec("s5-recap-table", "FAIL", `${recapDir} 空/缺,逐场复盘没出表(跑 npm run wc:recap-match)`);
    else rec("s5-recap-table", "PASS", `世界杯逐场复盘累计表在位(${readdirSync(recapDir).length}个文件)`);
  }
}

// ── 汇总 ──
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n══ audit-wc-pipeline ${DATE}: ${results.length}项 | PASS ${results.length - fails.length - skips.length} | SKIP ${skips.length} | FAIL ${fails.length} ══`);
if (fails.length) { console.error("🔴 世界杯链路闸红,拒绝交付。FAIL项:\n" + fails.map((f) => `  - [${f.id}] ${f.detail}`).join("\n")); process.exit(1); }
process.exit(0);
