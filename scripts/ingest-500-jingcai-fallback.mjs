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
  const spf = parseMatches(spfXml);
  const nspf = parseMatches(nspfXml);

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
  const todays = selectInSale(spf, date);
  if (!todays.length) {
    console.log(JSON.stringify({ ok: false, date, reason: "500 源无任何竞彩场次", spfTotal: spf.length }, null, 2));
    return;
  }
  // 审计:开赛窗口纳入 N 场(spf feed 共 M 场,窗口外远期预售已剔)——便于无人值守察觉异常膨胀。
  const wcN = todays.filter((m) => String(m.league ?? "").includes("世界杯")).length;
  console.error(`在售窗口(业务日${date}+${IN_SALE_HORIZON_DAYS}天):纳入 ${todays.length} 场(其中世界杯单场 ${wcN}),feed 共 ${spf.length} 场`);

  const nspfByNum = new Map(nspf.map((m) => [m.matchnum, m]));
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

  // 盘口词/数字 → 数值(平手0 半球0.5 一球1 球半1.5;"2/2.5"→2.25)
  const HW = { "平手": 0, "平手/半球": 0.25, "半球": 0.5, "半球/一球": 0.75, "一球": 1, "一球/球半": 1.25, "球半": 1.5, "球半/两球": 1.75, "两球": 2, "两球/两球半": 2.25, "两球半": 2.5, "两球半/三球": 2.75, "三球": 3 };
  const numLine = (s) => { if (s == null) return null; const k = String(s).trim().replace(/^受/, ""); if (HW[k] != null) return HW[k]; const ps = k.split("/").map(Number).filter((n) => !isNaN(n)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null; };
  // 亚盘式水位(0.80)→ 欧赔(1.80);已是欧赔(>1.5)则不动
  const toEuro = (w) => { const n = Number(w); return Number.isFinite(n) ? (n < 1.5 ? n + 1 : n) : NaN; };
  const firstVal = (o) => o ? (o.am ?? o.bet365 ?? o.lb ?? o.hg ?? o.wl ?? Object.values(o)[0] ?? null) : null;

  const fixtures = [];
  const snapshots = [];

  for (const m of todays) {
    const fixtureId = `jc500-${date}-${m.matchnum}-${safeName(m.home)}-${safeName(m.away)}`;
    // ⚠️ 2026-06-02 修正重大映射错误(4角度对抗证伪+百家欧赔佐证):
    //   500 的 pl_spf_2.xml 实际是【让球胜平负】、pl_nspf_2.xml 才是【胜平负(不让球)】——
    //   与文件名直觉相反。旧代码把 spf(让球)当胜平负喂模型 → 1X2 方向系统性错(把客队让球盘当成主队胜平负)。
    //   实测:克罗地亚vs比利时 真胜平负=2.57/2.85/2.57(势均,百家欧赔2.59/3.34/2.57佐证),
    //         让球盘(主-1)=5.50/4.48/1.38(1.38是让球客胜非比利时大热)。
    const nspfEntry = nspfByNum.get(m.matchnum);
    const euro = nspfEntry ? oddsSet(nspfEntry, "win", "draw", "lost") : null;  // 胜平负 ← pl_nspf
    const handicap = oddsSet(m, "win", "draw", "lost");                          // 让球胜平负 ← pl_spf
    // 一致性守护:胜平负热门方(min赔)的让球盘赔率应更高(让1球更难cover);若反了说明仍喂反,告警。
    if (euro && handicap) {
      const favSide = euro.latest ? ["win","draw","lost"].reduce((b,k)=> (euro.latest[k]??9)<(euro.latest[b]??9)?k:b,"win") : null;
      if (favSide && euro.latest && handicap.latest && Number(euro.latest[favSide]) > Number(handicap.latest[favSide]) + 0.3) {
        console.error(`⚠️ 赔率一致性告警 ${m.home} vs ${m.away}:胜平负热门方赔率(${euro.latest[favSide]})高于让球(${handicap.latest[favSide]}),疑似 spf/nspf 仍喂反,请核查!`);
      }
    }
    const goalLine = nspfByNum.get(m.matchnum)?.latest?.goalline ?? "";

    fixtures.push({
      id: fixtureId,
      date,
      sequence: m.matchnum,
      kickoff: `${m.date} ${m.matchtime ?? ""}`.trim(),
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
    const jline = parseJingcaiHandicapLine(hcapByHome[m.home]);
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

  // 合并既有 fixture(保留官方 14 场/其它源),只替换 500 兜底竞彩 —— 不破坏官方数据。
  const keepFixtures = loadFixtures(date).fixtures.filter((f) => f.source !== "500.com-jczq-fallback");
  const mergedSource = keepFixtures.length
    ? `merged:${[...new Set(keepFixtures.map((f) => f.source).filter(Boolean))].join("+")}+500.com-jczq-fallback`
    : "500.com-jczq-fallback";
  // 按业务日覆盖式落盘:对合并后的竞彩限当日 + 跨源去重(周六 vs 6001 重复 / 周日次日),
  // 避免反复兜底把场次越叠越多(17→35→48)。14 场/其它源原样保留。
  // ===== 数据完整性审计闸(2026-06-06 用户铁律"抓完先审计核查再走下一步")=====
  // 逐赔种核查覆盖率;缺失场如实告警(不静默用 DC 估算冒充市场盘)。覆盖严重不足时显著告警。
  const audit = { 胜平负: 0, 让球: 0, 比分: 0, 半全场: 0, 大小球: 0, 总进球: 0, gaps: [] };
  for (const s of snapshots) {
    if (s.europeanOdds) audit.胜平负++;
    if (s.handicapOdds) audit.让球++;
    if (s.scoreOdds?.top?.length) audit.比分++;
    if (s.halfFullOdds?.top?.length) audit.半全场++;
    if (s.totals) audit.大小球++;
    if (s.totalGoalsOdds?.over25 != null) audit.总进球++;
    const miss = [];
    if (!s.scoreOdds?.top?.length) miss.push("比分");
    if (!s.halfFullOdds?.top?.length) miss.push("半全场");
    if (s.totalGoalsOdds?.over25 == null && !s.totals) miss.push("大小球/总进球");
    if (miss.length) audit.gaps.push(`${s.homeTeam} vs ${s.awayTeam}: 缺 ${miss.join("/")}`);
  }
  const n = snapshots.length || 1;
  console.error(`\n=== 数据完整性审计(${snapshots.length}场)===`);
  console.error(`胜平负 ${audit.胜平负}/${snapshots.length} · 让球 ${audit.让球}/${snapshots.length} · 比分 ${audit.比分}/${snapshots.length} · 半全场 ${audit.半全场}/${snapshots.length} · 大小球 ${audit.大小球}/${snapshots.length} · 总进球 ${audit.总进球}/${snapshots.length}`);
  if (audit.gaps.length) console.error(`⚠️ 缺口(将如实标缺、不冒充):\n  ` + audit.gaps.join("\n  "));
  else console.error("✅ 全赔种全覆盖");

  const scopedFixtures = scopeJingcaiFixtures(date, [...keepFixtures, ...fixtures]);
  const fixturesSaved = saveFixtures(date, scopedFixtures, { source: mergedSource });
  // 合并既有快照(不破坏其它源),再保存
  const previous = loadMarketSnapshots(date).snapshots.filter((s) => s.source !== "500.com-jczq-fallback");
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
    sample: todays.map((m) => { const n = nspfByNum.get(m.matchnum)?.latest; return `${m.matchnum} ${m.league} ${m.home} vs ${m.away} 胜平负=${n?`${n.win}/${n.draw}/${n.lost}`:"?"} 让球=${m.latest.win}/${m.latest.draw}/${m.latest.lost}`; })
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
