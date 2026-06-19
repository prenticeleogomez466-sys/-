// 500.com 竞彩兜底注入器
// 背景:官方源(lottery.gov.cn / sporttery.cn / webapi.sporttery.cn)在本机被反爬封锁
//   - lottery.gov.cn 返回 HTTP 567(WAF 反爬挑战)
//   - sporttery.cn / webapi.sporttery.cn TLS 握手被直接拒绝(SEC_E_INVALID_TOKEN)
// 导致 readChinaWebSources 抓不到当日竞彩,实时源闸门硬挂、无人值守流水线天天空跑。
//
// 本脚本用 500.com 公开静态赔率 XML(已验证 HTTP 200、内容 UTF-8)兜底抓取当日竞彩:
//   - 胜平负:https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml
//   - 让球胜平负:https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml
// 解析成与 china-web-sources 官方读取相同的 fixture / marketSnapshot 形状,写入 store,
// 供 prediction-engine 以"市场推断 λ"产出竞彩推荐。
// 来源诚实标记为 500.com-fallback(不冒充官方源)。
//
// 用法:node scripts/ingest-500-jingcai-fallback.mjs --date=2026-05-30

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../src/env.js";
import { saveFixtures, loadFixtures } from "../src/fixture-store.js";
import { saveMarketSnapshots, loadMarketSnapshots } from "../src/market-data-store.js";
import { scopeJingcaiFixtures } from "../src/jingcai-business-day.js";
import { parseJingcaiHandicapLine } from "../src/jingcai-fivehundred-stage.js";
import { orientRowMaps, swapGuardViolation, ORIENT_A_IS_1X2, ORIENT_B_IS_1X2, ORIENT_UNCERTAIN } from "../src/spf-orientation.js";
import { kickoffTimeFromDomCell, domKickoffCellFor, preservedKickoffTime } from "../src/kickoff-time.js";
import { isWorldCupWindow } from "../src/odds-api-rotation.js";

const SPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";
const NSPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml";
// 全赔种接入(2026-06-06 用户铁律"必须全部抓取"):比分/半全场/总进球真实市场盘,
//   替原先 DC 泊松估算冒充。见 feedback_fetch_all_then_audit。
const BF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_bf_2.xml";   // 比分
const BQC_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_bqc_2.xml"; // 半全场
const JQS_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_jqs_2.xml"; // 总进球数
const REFERER = "https://trade.500.com/jczq/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();
// --horizon N:在售窗口天数覆盖(默认 IN_SALE_HORIZON_DAYS=4)。胜负彩期次腿跨度>4天时(如26085期腿12-14在6/16)
//   临时放宽抓全期腿;只影响窗口纳入,不改任何赔率解析口径(2026-06-10)。
const horizonOverride = Number(readArg("--horizon")) || null;

// 仅在直接执行(node scripts/ingest-500-jingcai-fallback.mjs)时跑 main();被 import(单测引 selectInSale)
//   时不执行,避免测试触发真实网络抓取与落盘(jingcai-ingest-wc-singles,2026-06-08)。
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

async function main() {
  const [spfXml, nspfXml] = await Promise.all([fetchXml(SPF_URL), fetchXml(NSPF_URL)]);
  const spfFeed = parseMatches(spfXml);   // pl_spf 文件内容(命名不可信,方向待定)
  const nspfFeed = parseMatches(nspfXml); // pl_nspf 文件内容(命名不可信,方向待定)

  // ===== 方向定向(缺陷#3,2026-06-10):500 两 XML 内容会互换,文件名不可信 =====
  // 06-09 真钱事故:本脚本按文件名硬映射(euro←pl_nspf / 让球←pl_spf),互换日把胜平负与让球喂反,
  //   匈牙利 1.17 大热被推客胜。改接共享离散度投票定向(与 build-scrape-from-xml 同一实现);
  //   投票不确定 = 方向不可证 → 标⚠️人工复核 + exitCode≠0 + 阻断一切落盘(铁律:绝不硬猜兜底)。
  const orient = orientIngestFeeds(spfFeed, nspfFeed);
  if (orient.orientation === ORIENT_UNCERTAIN) {
    console.error(`⚠️ spf/nspf 方向离散度投票不确定(A=${orient.voteA} / B=${orient.voteB},样本${orient.sampled})——方向不可证,阻断落盘,请人工复核两份 XML 内容`);
    console.log(JSON.stringify({ ok: false, date, reason: "spf/nspf 方向投票不确定,需人工复核,未落盘", votes: { A: orient.voteA, B: orient.voteB, sampled: orient.sampled } }, null, 2));
    process.exitCode = 2;
    return;
  }
  console.error(`[orient] 1X2 feed = ${orient.euroFile}  让球 feed = ${orient.hcFile}(离散度投票 A=${orient.voteA} / B=${orient.voteB},样本${orient.sampled})`);
  const euroByNum = new Map(orient.euroList.map((m) => [m.matchnum, m]));
  const hcByNum = new Map(orient.hcList.map((m) => [m.matchnum, m]));
  // 遍历两 feed 并集(让球 feed 为基,补 1X2 独有场):只卖让球的悬殊场只在让球 feed 出现,
  //   旧代码固定遍历 pl_spf 文件,互换日会整批漏掉悬殊场。
  const unionList = [...orient.hcList];
  const seenNums = new Set(unionList.map((m) => m.matchnum));
  for (const m of orient.euroList) if (!seenNums.has(m.matchnum)) { unionList.push(m); seenNums.add(m.matchnum); }
  const spf = unionList;  // 下游变量名沿用:在售选取基准(两 feed 并集)

  // 比分/半全场/总进球 真实市场盘(按 matchid 索引;失败降级该赔种=空,审计闸会标缺)。
  const bfByMatchid = new Map(), bqcByMatchid = new Map(), jqsByMatchid = new Map();
  try {
    const [bfXml, bqcXml, jqsXml] = await Promise.all([
      fetchXml(BF_URL).catch(() => ""), fetchXml(BQC_URL).catch(() => ""), fetchXml(JQS_URL).catch(() => "")]);
    for (const h of parseHeads(bfXml)) { const o = bfToScoreOdds(h); if (o.length) bfByMatchid.set(h.id ?? h.matchid, o); }
    for (const h of parseHeads(bqcXml)) { const o = bqcToHalfFull(h); if (o.length) bqcByMatchid.set(h.id ?? h.matchid, o); }
    for (const h of parseHeads(jqsXml)) { const o = jqsToTotalGoals(h); if (o.over25 != null) jqsByMatchid.set(h.id ?? h.matchid, o); }
    console.error(`全赔种:比分 ${bfByMatchid.size} 场 / 半全场 ${bqcByMatchid.size} 场 / 总进球 ${jqsByMatchid.size} 场`);
  } catch (e) { console.error("比分/半全场/总进球抓取失败,降级标缺:", e.message); }

  // jingcai-ingest-wc-singles(2026-06-08):去掉"单批锚定"。500 静态 XML 的语义是"当前在售即列出"
  //   (已下市不在 feed)→ 在售 = feed 里全部场次。旧逻辑按 matchnum 前三位定系列、只取一个系列,
  //   对世界杯长预售期(matchnum 跨 1/2/.../7 七系列、kickoff 跨 06-09~06-18)会把 4001 墨西哥vs南非
  //   等世界杯单场整批丢弃 → 竞彩漏出。改为纳入 feed 全部场次(可剔已过 kickoff 的场)。
  // fetch-gate-500-2/output-threeway-6/automation-chain-3(2026-06-11):无 --horizon 的调用方
  //   (daily:fallback / jingcai-daily / LineupWatch→Run-Daily)曾按默认+4天窗口整批替换,把 store
  //   里已在售的 6/16+ 世界杯竞彩腿每天静默删除。世界杯窗口内默认窗口动态抬到 7(覆盖整批在售腿)。
  const effectiveHorizon = horizonOverride ?? defaultIngestHorizonDays(date);
  const todays = selectInSale(spf, date, effectiveHorizon);
  if (!todays.length) {
    console.log(JSON.stringify({ ok: false, date, reason: "500 源无任何竞彩场次", spfTotal: spf.length }, null, 2));
    return;
  }
  // 审计:开赛窗口纳入 N 场(spf feed 共 M 场,窗口外远期预售已剔)——便于无人值守察觉异常膨胀。
  const wcN = todays.filter((m) => String(m.league ?? "").includes("世界杯")).length;
  console.error(`在售窗口(业务日${date}+${effectiveHorizon}天):纳入 ${todays.length} 场(其中世界杯单场 ${wcN}),feed 共 ${spf.length} 场`);

  const collectedAt = new Date().toISOString();

  // ---- odds.xml 全盘口接入(2026-06-03):亚盘水位 + 大小球,补 ingest 链路缺口 ----
  const ODDS_URL = "https://www.500.com/static/public/jczq/xml/odds/odds.xml";
  const oddsByNum = new Map();
  try {
    const oddsXml = await fetchXml(ODDS_URL);
    for (const mm of oddsXml.matchAll(/<match\b([^>]*)>([\s\S]*?)<\/match>/g)) {
      const attr = Object.fromEntries([...mm[1].matchAll(/(\w+)="([^"]*)"/g)].map((p) => [p[1], p[2]]));
      const body = mm[2];
      const pick = (tag) => { const t = body.match(new RegExp(`<${tag}\\b([^>]*)/?>`)); return t ? Object.fromEntries([...t[1].matchAll(/(\w+)="([^"]*)"/g)].map((p) => [p[1], p[2]])) : null; };
      oddsByNum.set(attr.processname, { asian: pick("asian"), dxq: pick("dxq") });
    }
    console.error(`odds.xml: ${oddsByNum.size} 场亚盘/大小球`);
  } catch (e) { console.error("odds.xml 抓取失败,亚盘/大小球降级:", e.message); }

  // ---- 官方让球数(playwright 抓 jczq DOM,失败降级 line=0)----
  let hcapByHome = {};
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const tmp = join(here, "..", ".tmp-ingest-handicap.json");
    const r = spawnSync("node", [join(here, "scrape-jingcai-handicap.mjs"), "--out", tmp], { encoding: "utf8", timeout: 90000 });
    if (r.status === 0) { hcapByHome = JSON.parse((await import("node:fs")).readFileSync(tmp, "utf8")); console.error(`官方让球数: ${Object.keys(hcapByHome).length} 场`); }
    else { console.error("让球数抓取失败,降级 line=0:", (r.stderr || "").slice(0, 120)); }
  } catch (e) { console.error("让球数抓取异常,降级 line=0:", e.message); }
  // DOM 开球时刻(缺陷#9 配套,2026-06-10):500 静态 XML 无 matchtime → fixture.kickoff 只有日期,
  //   临场收盘捕获(capture-closing-live)判不了"距开赛 N 分钟"= 永远 0 捕获。jczq DOM 含
  //   "MM-DD HH:MM",由 scrape-jingcai-handicap 一并捕获挂 __kickoffs__。拿不到=如实留日期(不猜时刻)。
  const domKickoffs = (hcapByHome && typeof hcapByHome.__kickoffs__ === "object" && hcapByHome.__kickoffs__) || {};
  if (Object.keys(domKickoffs).length) console.error(`DOM 开球时刻: ${Object.keys(domKickoffs).length} 场`);
  else console.error("⚠️ DOM 开球时刻 0 场(让球数抓取失败或页面改版)——kickoff 将只有日期,临场捕获对这些场跳过");
  // 开球时刻不降级(T5,2026-06-10):DOM 偶发超时的轮次,本店同场先前已捕获的 HH:mm 不得被
  //   重写成"只有日期"(否则恰逢日刷失败=当晚临场收盘捕获全灭)。只沿用编号+主客+赛日全同的
  //   先前真实捕获值(preservedKickoffTime 内自校验,赛日改期即弃),DOM/XML 拿到新值一律以新为准。
  const prevOwnFixtures = loadFixtures(date).fixtures.filter((f) => f.source === "500.com-jczq-fallback");

  // 盘口词/数字 → 数值(平手0 半球0.5 一球1 球半1.5;"2/2.5"→2.25)
  const HW = { "平手": 0, "平手/半球": 0.25, "半球": 0.5, "半球/一球": 0.75, "一球": 1, "一球/球半": 1.25, "球半": 1.5, "球半/两球": 1.75, "两球": 2, "两球/两球半": 2.25, "两球半": 2.5, "两球半/三球": 2.75, "三球": 3 };
  const numLine = (s) => { if (s == null) return null; const k = String(s).trim().replace(/^受/, ""); if (HW[k] != null) return HW[k]; const ps = k.split("/").map(Number).filter((n) => !isNaN(n)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null; };
  // 亚盘式水位(0.80)→ 欧赔(1.80);已是欧赔(>1.5)则不动
  const toEuro = (w) => { const n = Number(w); return Number.isFinite(n) ? (n < 1.5 ? n + 1 : n) : NaN; };
  const firstVal = (o) => o ? (o.am ?? o.bet365 ?? o.lb ?? o.hg ?? o.wl ?? Object.values(o)[0] ?? null) : null;

  const fixtures = [];
  const snapshots = [];
  const swapViolations = [];

  for (const m of todays) {
    const fixtureId = `jc500-${date}-${m.matchnum}-${safeName(m.home)}-${safeName(m.away)}`;
    // 2026-06-10(缺陷#3):不再按文件名硬映射(旧注释"pl_nspf 才是胜平负"在 06-09 互换日恰好反过来,
    //   把匈牙利 1.17 大热喂反)。胜平负/让球一律取上方离散度投票定向后的 feed。
    const euroEntry = euroByNum.get(m.matchnum);
    const hcEntry = hcByNum.get(m.matchnum);
    const euro = euroEntry ? oddsSet(euroEntry, "win", "draw", "lost") : null;  // 胜平负(1X2)
    const handicap = hcEntry ? oddsSet(hcEntry, "win", "draw", "lost") : null;  // 让球胜平负
    // 逐场互换残留守护(缺陷#13):旧守护读 oddsSet 不存在的 .latest 字段=死代码,且只告警不阻断。
    //   改用共享 swapGuardViolation(读 .current);命中即记违例,循环后统一 exitCode≠0 阻断落盘。
    //   2026-06-10 洞1:传竞彩让球线,|线|≥1 整数深线提阈到 ×5 防均势场误报(韩捷/科厄实测假阳致整日断供)。
    const guardLine = parseJingcaiHandicapLine(lookupHandicapLine(hcapByHome, m.home, m.away));
    const violation = swapGuardViolation(euro, handicap, { line: guardLine });
    if (violation) swapViolations.push(`${m.matchnum} ${m.home} vs ${m.away}: ${violation}`);
    const goalLine = euroEntry?.latest?.goalline ?? "";

    // kickoff = 真实赛日 + 开球时刻:XML matchtime 优先(若有),否则 DOM __kickoffs__
    //   (kickoffTimeFromDomCell 校验 DOM MM-DD 与 XML 赛日一致才采信,防错场);
    //   再否则沿用本店同场先前已捕获时刻(T5 不降级);都没有 → 只日期,如实标缺。
    const kickoffTime = String(m.matchtime ?? "").trim()
      || kickoffTimeFromDomCell(m.date, domKickoffCellFor(domKickoffs, m.home, m.away))
      || preservedKickoffTime(prevOwnFixtures, { sequence: m.matchnum, home: m.home, away: m.away, date: m.date })
      || "";
    fixtures.push({
      id: fixtureId,
      date,
      sequence: m.matchnum,
      kickoff: `${m.date} ${kickoffTime}`.trim(),
      competition: m.league || "竞彩足球",
      homeTeam: m.home,
      awayTeam: m.away,
      marketType: "jingcai",
      tags: ["竞彩足球", "500.com兜底"],
      source: "500.com-jczq-fallback",
      officialStatus: "fallback-500",
      officialFixtureId: m.id ?? null,
      notes: `500.com 兜底(官方源被反爬封锁);业务日期=${date};编号=${m.matchnum}`
    });

    // 让球线(竞彩官方,jczq DOM)+ 亚盘水位 + 大小球(odds.xml)
    // 优先 "主队|客队" 复合键(防同一主队当日两场碰撞,如阿根廷vs冰岛让-2 vs 阿根廷vs阿尔及利亚让-1),兜底主队键。
    const jline = guardLine;
    const od = oddsByNum.get(m.matchnum);
    let asianHandicap = null;
    if (od?.asian) {
      const parts = String(firstVal(od.asian) ?? "").split(",").map((s) => s.trim());
      const mag = numLine(parts[1]);
      const up = Number(parts[0]), down = Number(parts[2]);
      if (mag != null && Number.isFinite(up) && Number.isFinite(down)) {
        const sign = jline != null ? Math.sign(jline) : (up <= down ? -1 : 1);
        const node = { line: sign * mag, home: up, away: down };
        asianHandicap = { initial: node, current: node };
      }
    }
    let totals = null;
    if (od?.dxq) {
      const parts = String(firstVal(od.dxq) ?? "").split(",").map((s) => s.trim());
      const ln = numLine(parts[1]);
      const over = toEuro(parts[0]), under = toEuro(parts[2]);
      if (ln != null && Number.isFinite(over) && Number.isFinite(under)) {
        const node = { line: ln, over, under };
        totals = { initial: node, current: node };
      }
    }

    snapshots.push({
      date,
      fixtureId,
      sequence: m.matchnum,
      marketType: "jingcai",
      competition: m.league || "竞彩足球",
      homeTeam: m.home,
      awayTeam: m.away,
      collectedAt,
      europeanOdds: euro,
      // fetch-gate-500-1 刀②(2026-06-11):显式建模"未开售"≠"抓取失败"。本次两 feed 均成功抓到
      //   (失败会在 main 顶部抛错终止),1X2 feed 无此场 = 竞彩明确只卖让球未开售胜平负。
      //   带上 euroUnsold=true 后,odds-stability-cache 绝不对它回填 last-good 欧赔,
      //   findMarketSnapshot 也绝不让陈旧副本 donor 复活(06-08新浪机构赔率冒充在售1X2的真钱事故)。
      euroUnsold: !euro,
      handicapOdds: handicap,
      jingcaiHandicap: jline != null ? { line: jline, source: "500.com-jczq" } : null,
      asianHandicap,
      totals,
      // 比分/半全场/总进球 真实市场盘(按 matchid;无=null 标缺,不冒充)。模型 buildScorePicks/buildHalfFullPicks 优先吃 .top。
      scoreOdds: bfByMatchid.has(m.id) ? { top: bfByMatchid.get(m.id), source: "500.com-jczq-bf" } : null,
      halfFullOdds: bqcByMatchid.has(m.id) ? { top: bqcByMatchid.get(m.id), source: "500.com-jczq-bqc" } : null,
      totalGoalsOdds: jqsByMatchid.has(m.id) ? { ...jqsByMatchid.get(m.id), source: "500.com-jczq-jqs" } : null,
      source: "500.com-jczq-fallback"
    });
  }

  // ===== 互换阻断闸(缺陷#13,2026-06-10):方向可疑的数据绝不写进 market 文件 =====
  // 旧行为=只 console.error 不设 exitCode 不阻断 → 喂反数据照样落盘进真钱管线。
  if (swapViolations.length) {
    console.error(`\n⛔ 逐场互换残留守护命中 ${swapViolations.length} 场,方向可疑,阻断落盘(fixtures/market 均不写),请人工复核:`);
    for (const v of swapViolations) console.error(`  ${v}`);
    console.log(JSON.stringify({ ok: false, date, reason: "spf/nspf 互换残留守护命中,方向可疑,未落盘", violations: swapViolations }, null, 2));
    process.exitCode = 2;
    return;
  }

  // 合并既有 fixture(保留官方 14 场/其它源),只替换 500 兜底竞彩 —— 不破坏官方数据。
  const prevAllFixtures = loadFixtures(date).fixtures;
  const keepFixtures = prevAllFixtures.filter((f) => f.source !== "500.com-jczq-fallback");
  // fetch-gate-500-2/automation-chain-3 根修(2026-06-11):窗口外既有本店未开赛场原样保留,
  //   绝不被"整批替换"静默删除(此前默认+4窗口的无--horizon调用方每天把 6/16+ 在售腿从 store 抹掉,
  //   6/16-17 腿无预测、14场不发)。不变量:ingest 后已存在的未停售竞彩行不得变少。
  const preservedFuture = preserveOutOfWindowFixtures(
    prevAllFixtures.filter((f) => f.source === "500.com-jczq-fallback"), fixtures, date, effectiveHorizon);
  if (preservedFuture.length) {
    console.error(`✅ 保留窗口外既有远期预售场 ${preservedFuture.length} 场(不整批覆盖删除):` +
      preservedFuture.map((f) => `${f.sequence} ${f.homeTeam} vs ${f.awayTeam}(${String(f.kickoff).slice(0, 10)})`).join("；"));
  }
  const mergedSource = keepFixtures.length
    ? `merged:${[...new Set(keepFixtures.map((f) => f.source).filter(Boolean))].join("+")}+500.com-jczq-fallback`
    : "500.com-jczq-fallback";
  // 按业务日覆盖式落盘:对合并后的竞彩限当日 + 跨源去重(周六 vs 6001 重复 / 周日次日),
  // 避免反复兜底把场次越叠越多(17→35→48)。14 场/其它源原样保留。
  // ===== 数据完整性审计闸·真值化(缺陷#4,2026-06-10)=====
  // 旧 gaps 判定只看 比分/半全场/(大小球|总进球替身):胜平负/让球缺失不进 gaps,jqs 有值还遮蔽
  //   totals 全 NULL → 06-10 实测"胜平负 8/10 · 大小球 0/10"仍打"✅全赔种全覆盖"(假✅)。
  // 改为六项(胜平负/让球/比分bf/半全场bqc/总进球jqs/大小球totals)逐项独立真实计数,
  //   任一项任一场缺失即禁打✅,并明确列出缺哪种缺几场(如实标缺,不冒充、不替身)。
  const audit = auditSnapshots(snapshots);
  console.error(`\n=== 数据完整性审计(${audit.total}场)===`);
  console.error(AUDIT_KINDS.map((k) => `${k} ${audit.counts[k]}/${audit.total}`).join(" · "));
  if (audit.fullCoverage) {
    console.error("✅ 全赔种全覆盖(六项逐项核验)");
  } else {
    console.error(`⚠️ 赔种缺口(将如实标缺、不冒充,禁打全覆盖✅):${audit.missingKinds.join(" · ")}`);
    if (audit.gaps.length) console.error(`⚠️ 逐场缺口:\n  ` + audit.gaps.join("\n  "));
  }

  const scopedFixtures = scopeJingcaiFixtures(date, [...keepFixtures, ...fixtures, ...preservedFuture]);
  const fixturesSaved = saveFixtures(date, scopedFixtures, { source: mergedSource });
  // 合并既有快照(不破坏其它源),再保存。
  // fetch-gate-500-1 刀①(2026-06-11):本店旧副本剔除改"包含"判 —— odds-stability-cache 回填会把
  //   source 改写成 "500.com-jczq-fallback+稳定缓存(…)",旧精确比较 !== 永远剔不掉这种副本,
  //   06-08 新浪陈旧欧赔借尸还魂冒充在售1X2(6005卡塔尔/1013西班牙)。verified 与窗口外保留场的快照不剔。
  const preservedIds = new Set(preservedFuture.map((f) => f.id));
  const previous = loadMarketSnapshots(date).snapshots.filter((s) => keepPreviousSnapshot(s, preservedIds));
  // wc-handicap-line-persist-fix2(2026-06-08):previous 里已核实(verified)的世界杯单场真实让球线天然保留
  //   (它们 source≠500.com-jczq-fallback,不被上面 filter 剔除;findMarketSnapshot 又优先 verified donor)。
  //   无人值守流水线留痕:显式审计本次 ingest 保留了多少条已核实让球线,防 verified 静默冻结一条错线无人察觉。
  const verifiedKept = previous.filter((s) => s.verified === true && Number.isFinite(Number(s.jingcaiHandicap?.line)));
  if (verifiedKept.length) {
    console.error(`✅ 保留已核实让球线 ${verifiedKept.length} 条(verified,未被本次 ingest 覆盖):` +
      verifiedKept.map((s) => `${s.homeTeam} vs ${s.awayTeam} 让${s.jingcaiHandicap.line}`).join("；"));
  }
  const marketSaved = saveMarketSnapshots(date, [...previous, ...snapshots], { source: mergedSource });

  console.log(JSON.stringify({
    ok: true,
    date,
    fixtures: fixturesSaved.fixtures.length,
    snapshots: snapshots.length,
    fixturePath: `data/fixtures/${date}.json`,
    marketPath: marketSaved.path,
    orientation: { euroFile: orient.euroFile, hcFile: orient.hcFile, votes: { A: orient.voteA, B: orient.voteB, sampled: orient.sampled } },
    auditMissing: audit.missingKinds,
    sample: todays.map((m) => {
      const e = euroByNum.get(m.matchnum)?.latest;
      const h = hcByNum.get(m.matchnum)?.latest;
      return `${m.matchnum} ${m.league} ${m.home} vs ${m.away} 胜平负=${e ? `${e.win}/${e.draw}/${e.lost}` : "未开售"} 让球=${h ? `${h.win}/${h.draw}/${h.lost}` : "?"}`;
    })
  }, null, 2));
}

async function fetchXml(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Referer: REFERER, Accept: "application/xml,text/xml,*/*" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`);
  const buf = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder("utf-8").decode(buf);
}

// 只解析 <m> 头属性(比分/半全场/总进球的赔率全在头属性里,无 <row>)。
function parseHeads(xml) {
  const heads = [];
  for (const tag of (String(xml).match(/<m\b[^>]*\/?>/g) ?? [])) heads.push(attrMap(tag));
  return heads;
}
// 比分 bf:aXY=主胜X-Y / bXY=客胜(镜像Y-X) / cXX=平局X-X。→ [{score,odds}] 按赔率升序(概率高在前)。
function bfToScoreOdds(attrs) {
  const out = [];
  for (const [k, v] of Object.entries(attrs)) {
    const odds = Number(v); if (!Number.isFinite(odds) || odds <= 1) continue;
    let m;
    if ((m = k.match(/^a(\d)(\d)$/))) out.push({ score: `${m[1]}-${m[2]}`, odds });
    else if ((m = k.match(/^b(\d)(\d)$/))) out.push({ score: `${m[2]}-${m[1]}`, odds });
    else if ((m = k.match(/^c(\d)(\d)$/))) out.push({ score: `${m[1]}-${m[2]}`, odds });
  }
  return out.sort((a, b) => a.odds - b.odds);
}
// 半全场 bqc:首字母=半场,次字母=全场;a=主胜 b=客胜 c=平局。→ [{halfFull,odds}] 按赔率升序。
const BQC_L = { a: "主胜", b: "客胜", c: "平局" };
function bqcToHalfFull(attrs) {
  const out = [];
  for (const [k, v] of Object.entries(attrs)) {
    const odds = Number(v); if (!Number.isFinite(odds) || odds <= 1) continue;
    const m = k.match(/^([abc])([abc])$/);
    if (m) out.push({ halfFull: `${BQC_L[m[1]]}-${BQC_L[m[2]]}`, odds });
  }
  return out.sort((a, b) => a.odds - b.odds);
}
// 总进球 jqs:s0..s7=进0..7+球的赔率。→ 大小球派生(over/under 2.5 由 1/odds 反推概率聚合)。
function jqsToTotalGoals(attrs) {
  const probs = {};
  let sum = 0;
  for (let i = 0; i <= 7; i++) {
    const o = Number(attrs[`s${i}`]);
    if (Number.isFinite(o) && o > 1) { probs[i] = 1 / o; sum += probs[i]; }
  }
  if (sum <= 0) return { over25: null, under25: null, dist: null };
  let under = 0, over = 0;
  for (const [g, p] of Object.entries(probs)) { const np = p / sum; (Number(g) <= 2 ? (under += np) : (over += np)); }
  return { over25: round2(over), under25: round2(under), dist: Object.fromEntries(Object.entries(probs).map(([g, p]) => [g, round2(p / sum)])) };
}
const round2 = (x) => Math.round(x * 1000) / 1000;

// jingcai-ingest-wc-singles(2026-06-08):在售场次选取(纯函数,便于单测)。
//   500 静态 XML 只列"当前在售"竞彩 → 在售集 = feed 全部场次,不再按 matchnum 系列单批锚定。
//   可选剔除已过 kickoff 的场(date 之前赛日的场视为已结束/下市,正常不出现在 feed,这里只做防御)。
//   fixture 仍统一落业务日 date;kickoff 用 m.date+matchtime 真实赛日。
// 竞彩日常推荐的开赛窗口(2026-06-08):业务日 + N 天。聚焦临近场 + 最近世界杯比赛日,
//   不把整届预售(如世界杯 6/12~6/18 全部单场)堆进当日推荐(用户"还有2"=只要最近的,非25场)。
export const IN_SALE_HORIZON_DAYS = 4;
// 世界杯预售期在售腿跨度 7 天(实测 06-11 feed 列出 06-12~06-18 共24场全部在售),
//   默认+4窗口会把 6/16+ 在售腿主动丢弃 → 世界杯窗口(2026-06-11~07-19)内默认抬到 7。
export const WC_IN_SALE_HORIZON_DAYS = 7;
export function defaultIngestHorizonDays(date) {
  return isWorldCupWindow(date) ? WC_IN_SALE_HORIZON_DAYS : IN_SALE_HORIZON_DAYS;
}

// fetch-gate-500-2/automation-chain-3(纯函数便于单测):窗口外既有本店未开赛场保留清单。
//   窗口内的场以本次抓取为准(feed 没列出=已下市);已过赛日的场不保;
//   本次新批已含同场(编号+主客同)则以新抓为准不重复。
export function preserveOutOfWindowFixtures(previousOwn, newFixtures, date, horizonDays) {
  const horizon = addDaysIso(date, horizonDays);
  const idKey = (f) => `${f.sequence}|${f.homeTeam ?? f.home}|${f.awayTeam ?? f.away}`;
  const seen = new Set((newFixtures ?? []).map(idKey));
  return (previousOwn ?? []).filter((f) => {
    const d = String(f.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!d || d < String(date) || d <= horizon) return false;
    return !seen.has(idKey(f));
  });
}

// fetch-gate-500-1 刀①(纯函数便于单测):既有快照保留判定。
//   - verified=true(人工核实让球线)永远保留;
//   - 窗口外保留场(preservedFixtureIds)的本店快照保留(保场必须保赔,否则远期预售场失盘);
//   - 其余只要 source 含 "500.com-jczq-fallback"(含被稳定缓存改写过的副本)一律剔除,以本次新抓为准。
export function keepPreviousSnapshot(snapshot, preservedFixtureIds = new Set()) {
  if (snapshot?.verified === true) return true;
  if (preservedFixtureIds.has(snapshot?.fixtureId)) return true;
  return !String(snapshot?.source ?? "").includes("500.com-jczq-fallback");
}

function addDaysIso(isoDate, days) {
  const m = String(isoDate ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoDate ?? "");
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

export function selectInSale(spfMatches, date, horizonDays = IN_SALE_HORIZON_DAYS) {
  const list = Array.isArray(spfMatches) ? spfMatches : [];
  // 在售=feed列出且赛日在[业务日, 业务日+horizonDays]窗口内。
  //   下界:剔除赛日严格早于业务日的已结束场。上界:聚焦临近,不堆整届预售。
  //   无 m.date 的场保留(不因缺日期丢场)。
  const horizon = addDaysIso(date, horizonDays);
  return list.filter((m) => {
    const d = String(m?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!d) return true;
    return d >= String(date) && d <= horizon;
  });
}

// ===== 方向定向(缺陷#3,纯函数便于单测)=====
// 输入:pl_spf / pl_nspf 两份 parseMatches 结果(文件名不可信)。
// 输出:离散度投票后的 1X2 / 让球 feed 归属;uncertain 时 euroList/hcList = null(调用方必须阻断)。
export function orientIngestFeeds(spfList, nspfList) {
  const toRowMap = (list) => new Map((list ?? []).map((m) => [m.matchnum, m.latest]));
  const o = orientRowMaps(toRowMap(spfList), toRowMap(nspfList));
  if (o.orientation === ORIENT_A_IS_1X2) {
    return { ...o, euroList: spfList, hcList: nspfList, euroFile: "pl_spf", hcFile: "pl_nspf" };
  }
  if (o.orientation === ORIENT_B_IS_1X2) {
    return { ...o, euroList: nspfList, hcList: spfList, euroFile: "pl_nspf", hcFile: "pl_spf" };
  }
  return { ...o, euroList: null, hcList: null, euroFile: null, hcFile: null };
}

// ===== 审计闸真值化(缺陷#4,纯函数便于单测)=====
// 六项逐项独立计数:总进球(jqs)绝不替身大小球(totals),胜平负/让球缺失同样计入缺口。
export const AUDIT_KINDS = ["胜平负", "让球", "比分", "半全场", "总进球", "大小球"];
export function auditSnapshots(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const counts = Object.fromEntries(AUDIT_KINDS.map((k) => [k, 0]));
  const gaps = [];
  for (const s of list) {
    const miss = [];
    const tally = (kind, present) => { if (present) counts[kind] += 1; else miss.push(kind); };
    tally("胜平负", Boolean(s.europeanOdds));
    tally("让球", Boolean(s.handicapOdds));
    tally("比分", Boolean(s.scoreOdds?.top?.length));
    tally("半全场", Boolean(s.halfFullOdds?.top?.length));
    tally("总进球", s.totalGoalsOdds?.over25 != null);
    tally("大小球", Boolean(s.totals));
    if (miss.length) gaps.push(`${s.homeTeam} vs ${s.awayTeam}: 缺 ${miss.join("/")}`);
  }
  const total = list.length;
  const missingKinds = AUDIT_KINDS.filter((k) => counts[k] < total).map((k) => `${k} 缺${total - counts[k]}/${total}`);
  return { counts, gaps, missingKinds, total, fullCoverage: total > 0 && missingKinds.length === 0 };
}

function parseMatches(xml) {
  const matches = [];
  for (const block of xml.match(/<m\b[^>]*>[\s\S]*?<\/m>/g) ?? []) {
    const head = block.slice(0, block.indexOf(">") + 1);
    const attrs = attrMap(head);
    const rows = [...block.matchAll(/<row\b([^>]*?)\/?>/g)].map((r) => attrMap(`<row ${r[1]}>`));
    if (!rows.length) continue;
    // 500 XML row 顺序:索引 0 = 最新即赔,末尾 = 最早开盘
    matches.push({
      id: attrs.id,
      matchnum: attrs.matchnum,
      date: (attrs.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? attrs.date,
      matchtime: attrs.matchtime,
      league: attrs.league,
      home: attrs.home,
      away: attrs.away,
      latest: rows[0],
      opening: rows[rows.length - 1],
      rows
    });
  }
  return matches;
}

function oddsSet(match, hKey, dKey, aKey) {
  const toRow = (r) => {
    const home = Number(r?.[hKey]); const draw = Number(r?.[dKey]); const away = Number(r?.[aKey]);
    return [home, draw, away].every((v) => Number.isFinite(v) && v > 1) ? { home, draw, away } : null;
  };
  const current = toRow(match.latest);
  const initial = toRow(match.opening) ?? current;
  if (!current && !initial) return null;
  return { initial, current };
}

function attrMap(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

// 让球线查找容错(2026-06-17):官方让球 DOM 把长队名截断(塞伊奈约基→塞伊奈),
//   精确键 `${home}|${away}` 与存键 `塞伊奈|瓦萨` 不匹配 → line=null → 守护退回 ×2 误杀让1深盘场。
//   退而做双向前缀容错(home 与 away 都需前缀命中,防同前缀误配);只为给 swapGuard 选对阈值
//   + 补全显示让球线,不进任何赔率口径(铁律:不冒充、不兜底,只把真线匹配到正确场次)。
export function lookupHandicapLine(hcapByHome, home, away) {
  if (!hcapByHome || !home) return undefined;
  const exact = hcapByHome[`${home}|${away}`] ?? hcapByHome[home];
  if (exact != null) return exact;
  const pfx = (a, b) => Boolean(a) && Boolean(b) && (a.startsWith(b) || b.startsWith(a));
  for (const [k, v] of Object.entries(hcapByHome)) {
    const i = k.indexOf("|");
    if (i < 0) { if (pfx(home, k)) return v; continue; }
    if (pfx(home, k.slice(0, i)) && pfx(away, k.slice(i + 1))) return v;
  }
  return undefined;
}

function safeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

function readArg(name) {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
