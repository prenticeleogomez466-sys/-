// 今日"完整覆盖"竞彩交付 —— 输出层唯一出口(2026-06-10 单写者收敛,缺陷#5#7#8#12#16#17#20)。
// 三面同源:xlsx(20列专业版,桌面+稳定子文件夹)+ 手机页(今日足球推荐.html)+ 英文固定URL页(football.html),
// 渲染统一走 src/today-delivery-lib.js;所有旁路写者已改薄壳转发本脚本,绝不再各写各的。
// 用户铁律 2026-06-09:必须把所有赔率/数据补齐覆盖后再生成,关于一场比赛所有数据内容和赔率情况。
//   · 模型层(不改):胜负平/让胜负平/比分/半全场/信心  ← buildDailyRecommendationPackage(真钱管线)
//   · 补全层(只读真实抓取缓存,绝不造假):
//       大小球 = The Odds API totals de-vig;近5场/H2H/攻防画像 = ESPN 跨league真实战绩(coverage 缓存)
// 数据源单一:coverage = D:/football-model-data/coverage/<date>.json(由 fetch-match-coverage.mjs 产)。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
} from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import {
  resolveDeliveryDate, buildOddsFillCounts, buildDegradeNote, buildOddsCoverageLine,
  buildAuditFoot, buildXlsxSheets, renderMobileHtml, renderEnglishHtml, resolveHtmlWriteTarget,
  // 2026-06-11 渲染层升级(用户裁决①②③④):世界杯先验列组/让球真实裁决/串关安全度/数据审计/14场闸裁决
  wcPriorCells, handicapVerdictParts, parlaySafety, PARLAY_ORDER_NOTE,
  renderH2hCell, renderAsianDualCell, renderEuroRefCell, threeColumnCoherence,
  auditCell, buildAuditSheet, buildFourteenSheetRows, buildIntelSheet,
  // 2026-06-11 用户裁决:四玩法方向各自独立真实裁决(比分/半全场主推=各自盘口de-vig真实热门)+ 全信号面板 + 方向矩阵审计
  marketScoreView, marketHalfFullView, buildSignalPanel, directionMatrixAudit, DIR_LABEL,
  XLSX_HEADERS,
} from "../src/today-delivery-lib.js";
// 2026-06-13 交付契约硬闸(根治版式漂移/另起野页):写完产物自检,违约 fail-loud 拒认成功交付
import { checkContract, CONTRACT_PATH } from "./freeze-delivery-contract.mjs";
import { writeFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
// 串关推荐(2026-06-12 用户需求:最稳/均衡/高赔/爆冷,五玩法混合过关;表+手机页+英文页三处同源)
import { buildParlaySheet } from "../src/today-delivery-lib.js";
import { buildParlayLegs, buildParlayPlan } from "../src/parlay-builder.js";
// 2026-06-12 用户三裁决:信心档注金分层(基础100元·只挂最可信玩法·硬币减半不弃赛)+ 表头战绩行(只读复盘ledger)
import { buildStakeSuggestion, stakeSummary } from "../src/stake-plan.js";
import { buildRecordLine } from "../src/recap-record-line.js";
import { worldCupContextLine } from "../src/worldcup-context.js";
import { worldCupMatchPrior } from "../src/world-cup-priors.js";
import { buildFourteenPlan } from "../src/prediction-engine.js";
import { loadFixtures } from "../src/fixture-store.js";
import { jingcaiWeekdayLabel, sequenceWeekdayPrefix, isTodayDeliveryFixture } from "../src/jingcai-business-day.js";
// fetch-gate-500-1 刀③(2026-06-11):✅500欧赔/✅实测标签从快照来源派生,见值即打✅是缺陷
//   (稳定缓存回填的 06-08 新浪陈旧赔率曾被标"✅500欧赔/✅实测·500竞彩XML(spf)"进真钱交付)。
import { snapshotEuroProvenance } from "../src/market-data-store.js";
// 2026-06-14 情报系统(展示层·不动概率):预测/确认首发+阵型 / 伤停 / 近期热身 / 新闻动机聚合 → 「情报详情」sheet。
//   复用已采集层(advanced:sync 的 layers.lineups/injuries/news)+ 国家队近赛缓存 + 预测首发缓存;缺即标缺不编。
import { loadAdvancedData } from "../src/advanced-data-store.js";
import { loadNationalResults, recentForm } from "../src/wc-national-form.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { buildMatchIntel } from "../src/match-intel.js";

// 日期:必传合法 YYYY-MM-DD 或缺省=本机 UTC+8 当日;非法 fail-loud 退出(缺陷#20:绝不再默认写死历史日期)。
let date;
try {
  date = resolveDeliveryDate(process.argv.slice(2).find((a) => !a.startsWith("--")));
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}

// 启动自检(2026-06-11 用户裁决:所有生成入口启动必检,红=拒跑;--skip-preflight 仅诊断)
const { preflightOrDie } = await import("../src/preflight-selfcheck.js");
await preflightOrDie("today-full-coverage 竞彩+14场", { date });
// dry-run 沙箱(F2 验证用):设 TODAY_FULL_OUT_DIR 时产物全落该目录,不碰桌面/webshare 正式目录。
const outBase = process.env.TODAY_FULL_OUT_DIR || null;
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
// 修2026-06-10(审计rank2):coverage 文件缺失不再 crash——补全列诚实标"⚠️未补全(coverage缺)"继续出表。
let cov = null;
try { cov = JSON.parse(readFileSync(`D:/football-model-data/coverage/${date}.json`, "utf8")); }
catch (e) { console.log(`⚠️ coverage缺:D:/football-model-data/coverage/${date}.json 读取失败(${e.code ?? e.message})——近5/H2H/亚盘/欧赔补全列将标"⚠️未补全(coverage缺)"继续出表;可先跑 node scripts/fetch-match-coverage.mjs ${date} 再重出。`); }
const COV_MISS = "⚠️未补全(coverage缺)";
// 对抗证伪层(football-signal-verify 产,只标注不弃赛;无当日文件则该列如实标⚠️未跑、背书句不写——绝不编造审计声明)
let advData = null;
try { advData = JSON.parse(readFileSync(`D:/football-model-data/adversarial/${date}.json`, "utf8")).verdicts || null; } catch { advData = null; }
const advFor = (p) => advData?.[`${p.fixture.homeTeam}|${p.fixture.awayTeam}`] ?? null;

// 竞彩交付 = 竞彩在售(marketType=jingcai)+ 世界杯场(14场/预售,store 标 marketType=shengfucai)。
// 修2026-06-10(审计rank2+13):废 WC_SINGLES 硬编码4场——世界杯场从当日 fixtures store 动态判定
//   (competition 含"世界杯";store 里世界杯场多为 shengfucai,旧 isJc 闸 + 硬名单会全漏新场次)。
// --jconly 语义改(2026-06-10 起,开赛期间):竞彩在售场=含世界杯单场,不再剔除世界杯
//   (旧"剔除预售世界杯"语义只适用 6/9 预售期,6/11 开赛后按旧语义会把主菜全删)。
const isJc = (p) => p.fixture?.marketType === "jingcai";
const isWorldCupGame = (p) => String(p.fixture?.competition ?? "").includes("世界杯");
const JC_ONLY = process.argv.includes("--jconly");
if (JC_ONLY) console.log("--jconly(2026-06-10 新语义):竞彩在售场含世界杯单场,开赛期间不再剔除世界杯。");
const picked = preds.filter((p) => isJc(p) || isWorldCupGame(p));
const byMatch = new Map();
for (const p of picked) {
  const key = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`;
  const prev = byMatch.get(key);
  if (!prev || (isJc(p) && !isJc(prev))) byMatch.set(key, p);
}
let games = [...byMatch.values()].sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));

// 当日业务日过滤(2026-06-12 用户裁决:"每次只给我推荐当天的竞彩比赛"——交付只含今日业务日
//   在售场,不再把后续业务日(周六/周日…)与下期预售腿堆进同一张表;--all-onsale 保留全在售窗口)。
//   口径权威=竞彩编号周缀(5003 的 5=周五),与 scopeJingcaiFixtures 同源;无编号场无法归业务日,
//   如实排除并打印(绝不猜)。
const ALL_ONSALE = process.argv.includes("--all-onsale");
const WD_DIGIT = { "周一": "1", "周二": "2", "周三": "3", "周四": "4", "周五": "5", "周六": "6", "周日": "7" };
const todayDigit = WD_DIGIT[jingcaiWeekdayLabel(date)] ?? null;
if (!ALL_ONSALE && todayDigit) {
  const before = games.length;
  const dropped = [];
  games = games.filter((p) => {
    // canonical 判定(含跨日场修补,见 src/jingcai-business-day.js isTodayDeliveryFixture)
    const ok = isTodayDeliveryFixture(p.fixture, date);
    if (!ok) dropped.push(`${String(p.fixture?.sequence ?? "") || "无编号"} ${p.fixture.homeTeam}vs${p.fixture.awayTeam}`);
    return ok;
  });
  console.log(`当日业务日过滤(${jingcaiWeekdayLabel(date)}=周缀${todayDigit}):${before}场→${games.length}场;排除${dropped.length}场(后续业务日/预售,--all-onsale 可出全量)`);
  if (!games.length) { console.error(`❌ 今日业务日(${jingcaiWeekdayLabel(date)})无在售竞彩场——不出空表(检查抓取或确为休市日)。`); process.exit(1); }
}

// coverage 按主队中文名匹配(coverage 缺/未抓到该场 → null,补全列诚实标缺)
const covFor = (p) => cov?.matches?.find((m) => (p.fixture.homeTeam || "").includes(m.home.zh) && (p.fixture.awayTeam || "").includes(m.away.zh)) ?? null;

const ko = (p) => { const k = p.fixture?.kickoff; return k && /\d{2}:\d{2}/.test(k) ? k.slice(5, 16) : (k?.slice(5, 10) ?? ""); };
const isWc = isWorldCupGame; // 动态判定(2026-06-10,替代旧 WC_SINGLES 硬名单)
const compTag = (p) => (isWc(p) ? "世界杯·单场" : (p.fixture.competition || "国际赛"));

// 补全层渲染(全真实,缺标缺)
// 2026-06-12 诚实标注:ESPN 实取不足5场时(如美国仅4场)明标"仅N场",不让"近5"表头冒充满额。
const recStr = (side) => side.record5?.n ? `${side.record5.w}胜${side.record5.d}平${side.record5.l}负·进${side.record5.gf}失${side.record5.ga}${side.record5.n < 5 ? `(⚠️ESPN仅${side.record5.n}场)` : ""}` : "❌未取到";
// 比分一律本队视角 gf-ga(胜必然 X>Y,避免"主-客"朝向出现"胜1-2"自相矛盾)+ 对手简称
const last5Str = (side) => side.last5?.length ? side.last5.map((x) => `${x.res}${x.gf}-${x.ga}(${x.homeAway === "home" ? "主" : "客"}${x.oppAbbr})`).join(" ") : "";
// H2H 从当前主队视角 gf-ga(h2h=主队历史筛对手,gf/ga 即主队)
const h2hStr = (c) => c?.h2h?.length ? c.h2h.map((x) => `${x.date} ${c.home.zh}${x.gf}-${x.ga}(${x.res})`).join(" / ") : "近赛季窗口无交锋(ESPN免费源限近赛季)";
const profileStr = (c) => {
  if (!c) return "❌未取到";
  const ap = (s) => s.record5?.n ? `场均进${(s.record5.gf / s.record5.n).toFixed(1)}失${(s.record5.ga / s.record5.n).toFixed(1)}` : "近5缺";
  return `${c.home.zh} ${ap(c.home)} / ${c.away.zh} ${ap(c.away)};真xG缺(FBref·Cloudflare墙)`;
};

// ── 真实赔率提取(全从 500 快照,5赔种;有=✅500真盘 缺=⚠️标缺,绝不用模型冒充市场) ──
// 欧赔回退链(2026-06-11):500欧赔 → ESPN/DK ml → titan007 外盘百家平均(🔶仅方向参考)→ ⚠️未开售
const trip = (o) => o ? `${o.home}/${o.draw}/${o.away}` : null;
const euroStr = (s, c) => {
  const e = s.europeanOdds;
  if (e && e.current) {
    const cur = trip(e.current), ini = trip(e.initial);
    const body = `${cur}${ini && ini !== cur ? `(初${ini})` : ""}`;
    const prov = snapshotEuroProvenance(s);
    if (prov.stale) return `${body} ⚠️稳定缓存回填(采集${String(prov.collectedAt ?? "").slice(0, 16) || "时间缺"}),非本次500实抓·勿当在售实时盘`;
    return `${body} ${prov.from500 ? "✅500欧赔" : `✅${(prov.source || "来源未标").slice(0, 24)}`}`;
  }
  const eo = c?.espnOdds;
  if (eo?.ml) return `竞彩未开售;ESPN/${eo.provider} ${eo.ml.home}/${eo.ml.draw}/${eo.ml.away} ✅`;
  const ref = renderEuroRefCell(c?.euroRef);
  if (ref) return `竞彩未开售;${ref}`;
  return "⚠️未开售(竞彩只卖让球)";
};
const hcStr = (p, s) => {
  const h = s.handicapOdds; if (!h || !h.current) return "让球赔率⚠️缺";
  const cur = trip(h.current), ini = trip(h.initial);
  // 2026-06-13 铁律:只有竞彩官方让球线(jingcaiHandicap.line)在才标"让X ✅500让球";线未抓到=赔率真但线缺,
  //   绝不用模型/推断线(p.handicapPick.line 本就无 line 字段=undefined)冒充"让X ✅500"。
  const realLine = s.jingcaiHandicap?.line;
  if (realLine == null) return `让球赔率✅500=${cur}${ini && ini !== cur ? `(初${ini})` : ""}·⚠️竞彩官方让球线未抓到(以竞彩App实际线为准)`;
  return `让${realLine} ${cur}${ini && ini !== cur ? `(初${ini})` : ""} ✅500让球`;
};
const ouRealStr = (s) => { const t = s.totalGoalsOdds; if (!t || t.over25 == null) return "⚠️未取到"; return `大2.5球 大${Math.round(t.over25 * 100)}%/小${Math.round(t.under25 * 100)}% ✅500总进球`; };
const distStr = (s) => { const d = s.totalGoalsOdds?.dist; if (!d) return ""; return Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, pp]) => `${g}球${Math.round(pp * 100)}%`).join(" "); };
const scoreMktStr = (s) => { const t = s.scoreOdds?.top; return t?.length ? t.slice(0, 5).map((x) => `${x.score}@${x.odds}`).join(" ") + " ✅500比分" : "⚠️未取到"; };
const hfMktStr = (s) => { const t = s.halfFullOdds?.top; return t?.length ? t.slice(0, 4).map((x) => `${x.halfFull}@${x.odds}`).join(" ") + " ✅500半全场" : "⚠️未取到"; };
const asianStr = (eo) => eo?.asian?.line != null
  ? `让${eo.asian.line} 主${eo.asian.homeOdds}/客${eo.asian.awayOdds}${eo.asian.openLine && eo.asian.openLine !== eo.asian.line ? `(开${eo.asian.openLine}→异动)` : ""} ✅${eo.source}`
  : "⚠️未取到(亚盘源降级,无免费源)";
// 透明让球视图:模型过盘 + 市场de-vig 两套数(带队名),分歧大按铁律标"市场更准·谨慎"。
// 修2026-06-09:旧 simpleHandicapCell 头条用市场de-vig却配模型"把握"标签,阿根廷出"40%·把握低"与模型67%自相矛盾。
const hcParts = (p, s) => {
  // 2026-06-13 铁律:竞彩官方让球线缺时,模型过盘按推断线(默认0)算不可信→标缺不冒充,且避免 NaN/undefined 垃圾。
  if (s.jingcaiHandicap?.line == null) {
    const hc = s.handicapOdds?.current;
    return { line: "⚠️竞彩官方让球线未抓到", lineNum: null,
      model: "官方让球线未抓到→模型过盘不出(绝不按推断线冒充)",
      market: hc ? "让球赔率✅500在·过盘对应竞彩实际线(线未抓到,见赔率列,以App为准)" : "缺",
      diverge: false, mkDist: null };
  }
  const line = s.jingcaiHandicap.line;
  const home = p.fixture.homeTeam, away = p.fixture.awayTeam, absL = Math.abs(line);
  const cb = p.handicapPick?.coverBreakdown || {};
  const hc = s.handicapOdds?.current;
  const model = cb.home != null
    ? `${home}${line}过盘${Math.round(cb.home * 100)}% · 走盘${Math.round(cb.push * 100)}% · ${away}+${absL}过盘${Math.round(cb.away * 100)}%`
    : "缺";
  let market = "缺", mkHome = null, mkDist = null;
  if (hc) {
    const ss = 1 / hc.home + 1 / hc.draw + 1 / hc.away;
    mkHome = (1 / hc.home) / ss;
    mkDist = { home: (1 / hc.home) / ss, push: (1 / hc.draw) / ss, away: (1 / hc.away) / ss };
    market = `${home}过盘${Math.round(mkDist.home * 100)}% · 走盘${Math.round(mkDist.push * 100)}% · ${away}+${absL}过盘${Math.round(mkDist.away * 100)}%`;
  }
  const diverge = (cb.home != null && mkHome != null && Math.abs(cb.home - mkHome) > 0.15);
  return { line: `让${line}`, lineNum: line, model, market, diverge, mkDist };
};
const hcViewStr = (p, s) => { const h = hcParts(p, s); return `${h.line} ‖ 模型:${h.model} ‖ 市场de-vig:${h.market}${h.diverge ? " ⚠️模型与市场分歧大(市场更准·谨慎)" : ""}`; };

// ── 数据审计矩阵(2026-06-11 ④):每格=三标签+值+来源+抓取时间,缺标缺不兜底 ──
const tCov = cov?.generatedAt ?? null;
const auditFor = (p, s, c, prior, wcCtx) => {
  const t500 = s.collectedAt ?? null;
  const MISS = (why) => `⚠️缺(${why},标缺不编)`;
  // 刀③:标签由来源派生 —— 稳定缓存回填的陈旧值标"⚠️存疑",绝不冒充"✅实测·500竞彩XML(spf)"。
  const prov = snapshotEuroProvenance(s);
  const euro = s.europeanOdds?.current
    ? (prov.stale
      ? auditCell("⚠️存疑(稳定缓存回填陈旧值,非本次实抓)", trip(s.europeanOdds.current), prov.source.slice(0, 60) || "来源未标", t500)
      : auditCell("✅实测", trip(s.europeanOdds.current), prov.from500 ? "500竞彩XML(spf)" : (prov.source.slice(0, 40) || "来源未标"), t500))
    : c?.espnOdds?.ml ? auditCell("✅实测", `${c.espnOdds.ml.home}/${c.espnOdds.ml.draw}/${c.espnOdds.ml.away}`, `ESPN/${c.espnOdds.provider}`, tCov)
      : MISS("竞彩未开售且ESPN无ml");
  const ec = p.experienceContext;
  return {
    "欧赔": euro,
    "让球": s.handicapOdds?.current
      ? (s.jingcaiHandicap?.line != null
        ? auditCell("✅实测", `让${s.jingcaiHandicap.line} ${trip(s.handicapOdds.current)}`, "500竞彩XML(nspf)", t500)
        : auditCell("🔶部分", `让球赔率✅${trip(s.handicapOdds.current)}·官方让球线⚠️未抓到(不冒充推断线)`, "500竞彩XML(nspf)·线缺", t500))
      : MISS("500让球赔率未抓到"),
    "比分": s.scoreOdds?.top?.length ? auditCell("✅实测", `top${s.scoreOdds.top.length}档`, "500竞彩XML(bf)", t500) : MISS("500比分盘未开售/未抓到"),
    "半全场": s.halfFullOdds?.top?.length ? auditCell("✅实测", `top${s.halfFullOdds.top.length}档`, "500竞彩XML(bqc)", t500) : MISS("500半全场未开售/未抓到"),
    "大小球": s.totalGoalsOdds?.over25 != null ? auditCell("✅实测", `大2.5=${Math.round(s.totalGoalsOdds.over25 * 100)}%`, "500竞彩XML(jqs de-vig)", t500) : MISS("500总进球未抓到"),
    "亚盘DK": c?.asianHandicap?.dk ? auditCell("✅实测", `${c.asianHandicap.dk.line} 主${c.asianHandicap.dk.homeOdds}/客${c.asianHandicap.dk.awayOdds}`, c.asianHandicap.dk.source ?? "ESPN/DraftKings", tCov) : MISS(cov ? "ESPN/DK无该场亚盘" : "coverage缺"),
    "亚盘titan007": c?.asianHandicap?.titan007 ? auditCell("✅实测", `即时主让${c.asianHandicap.titan007.live?.line}(${c.asianHandicap.titan007.companiesCount}家)`, "vip.titan007.com即时盘", c.asianHandicap.titan007.fetchedAt) : MISS(cov ? "titan007无该场" : "coverage缺"),
    "欧赔参考(外盘)": c?.euroRef?.value ? auditCell("🔶推断(外盘均值,仅方向参考)", `${c.euroRef.value.home}/${c.euroRef.value.draw}/${c.euroRef.value.away}(${c.euroRef.companies}家)`, "titan007 1x2百家平均", c.euroRef.fetchedAt)
      : (s.europeanOdds?.current ? "—(竞彩已开售,无需外盘参考)" : MISS(cov ? "外盘参考也未抓到" : "coverage缺")),
    "近5": c?.home?.record5?.n ? auditCell("✅实测", `主${c.home.record5.n}场/客${c.away?.record5?.n ?? 0}场`, "ESPN跨league真实战绩", tCov) : MISS(cov ? "ESPN未取到该场近5" : "coverage缺"),
    "H2H": c?.h2h ? (Array.isArray(c.h2h)
      ? auditCell("✅实测", `${c.h2h.length}次(近赛季)`, "ESPN", tCov)
      : (c.h2h.meetings?.length
        ? auditCell("✅实测", `${c.h2h.meetings.length}次交锋`, c.h2h.source ?? "本地49k历史库", cov?.h2hLocalUpdatedAt ?? tCov)
        : auditCell("⚠️零交锋(已查证为缺,非未查)", "0次", c.h2h.source ?? "本地49k历史库", cov?.h2hLocalUpdatedAt ?? tCov)))
      : MISS(cov ? "该场无H2H记录" : "coverage缺"),
    "国际赛画像": ec ? auditCell("✅实测", `同情境n=${ec.n ?? "?"}·平局率${Number.isFinite(ec.historicalDrawRate) ? Math.round(ec.historicalDrawRate * 100) + "%" : "?"}`, ec.source ?? "经验库", "经验库预构建") : MISS("无同情境经验样本"),
    "世界杯先验": isWc(p)
      ? (prior ? auditCell("✅实测", `eloDiff${prior.eloDiff >= 0 ? "+" : ""}${prior.eloDiff}·confed${prior.confedAdj >= 0 ? "+" : ""}${prior.confedAdj}·λ×${wcCtx?.lambdaMult ?? "?"}`, "team-priors.json+world-cup-priors", "本次运行实时计算") : "⚠️Elo先验缺(48强名单未收录)")
      : "—(非世界杯场)",
  };
};

const rows = games.map((p, i) => {
  const c = covFor(p);
  const s = p.marketSnapshot || {};
  const scoreMkt = !!(s.scoreOdds?.top?.length), hfMkt = !!(s.halfFullOdds?.top?.length);
  const hcP = hcParts(p, s);
  // ① 世界杯模型先验透明列组(Elo先验=worldCupMatchPrior 实时算;λ=prediction 已算好的 worldCup 上下文,不重算)
  const wcCtx = p.probabilityAdjustment?.worldCup ?? null;
  const prior = isWc(p) ? worldCupMatchPrior(p.fixture.homeTeam, p.fixture.awayTeam, { hostHome: true }) : null;
  const wcLine = isWc(p) ? worldCupContextLine(p.fixture.homeTeam, p.fixture.awayTeam, p.fixture.competition) : "";
  const wcCells = wcPriorCells({ isWc: isWc(p), prior, lambdaCtx: wcCtx, wcLine });
  // ② 让球方向=模型真实裁决(handicapWld argmax,可与胜平负不同向,不同向注逻辑)
  const hv = handicapVerdictParts({
    line: s.jingcaiHandicap?.line ?? p.handicapPick?.line,
    wldCode: p.pick?.code, wldLabel: p.pick?.label,
    hw: p.handicapPick?.handicapWld ?? null, marketDist: hcP.mkDist,
    lineReal: s.jingcaiHandicap?.line != null, // 2026-06-13:仅真竞彩官方线才出过盘分析,线缺=标缺不冒充
  });
  const adv = advFor(p);
  // ── 四玩法独立真实裁决(2026-06-11 用户裁决):比分/半全场主推=各自500盘口de-vig真实热门(✅市场,可与胜负平不同向),
  //    模型方向一致视图退居次行;无盘口场如实退模型🔶。绝不人造分歧:盘口真同向时标"同向共振"。
  const msv = marketScoreView(p);
  const mhv = marketHalfFullView(p);
  // 2026-06-12 标签消歧:次行数值来自同一500盘de-vig、只是按模型方向筛(主选3档+次选1档),
  //   旧尾标〔✅500盘口主推〕挂在🔶次行末易误读成"次行=盘口主推"。
  const scoreCell = msv.fromMarket
    ? `${msv.cell}\n模型方向视图🔶(主选3档+次选1档·数值=同盘de-vig): ${simpleScoreCell(p)}`
    : `${simpleScoreCell(p)}〔🔶模型DC矩阵:${msv.basis}〕`;
  const hfCell = mhv.fromMarket
    ? `${mhv.cell}\n模型方向锚🔶(终场=主选/次选方向·数值=同盘de-vig): ${simpleHalfFullCell(p)}`
    : `${simpleHalfFullCell(p)}〔🔶模型半场联合:${mhv.basis}〕`;
  // 信号面板:欧赔初→现异动 + DK亚盘开→现/水位 + 竞彩让球盘资金 + 共振/背离裁决(全部本次实抓,缺标缺)
  const t7live = c?.asianHandicap?.titan007?.live ?? null;
  const panel = buildSignalPanel({
    euroCur: s.europeanOdds?.current ?? null, euroIni: s.europeanOdds?.initial ?? null,
    // 亚盘优先 DK(line/openLine 直读);缺则用 titan007 即时盘(水位=homeWater/awayWater,line>0=主让,语义同向可比水)
    asian: c?.espnOdds?.asian ?? (t7live ? {
      line: t7live.line, openLine: c?.asianHandicap?.titan007?.init?.line ?? null,
      homeOdds: t7live.homeWater, awayOdds: t7live.awayWater,
    } : null),
    hcDist: hcP.mkDist, ouLine: null, lineupKnown: false,
  });
  return {
    idx: i + 1, ko: ko(p), comp: compTag(p),
    match: `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
    // 模型方向概率(🔶,由500真盘de-vig+DC推得)
    wld: simpleWldCell(p), handicap: simpleHandicapCell(p), hcView: hcViewStr(p, s), hcP,
    score: scoreCell, halffull: hfCell,
    msv, mhv, signals: panel.text, signalDirs: panel.dirs,
    scoreSrc: msv.fromMarket ? "主推✅500盘口·次行🔶方向视图" : "🔶DC", hfSrc: mhv.fromMarket ? "主推✅500盘口·次行🔶方向视图" : "🔶DC",
    // 真实赔率(✅500实测 + ESPN/DK与titan007双源亚盘 + 外盘欧赔参考;coverage 缺 → 诚实标缺不编)
    euro: (s.europeanOdds?.current || cov) ? euroStr(s, c) : COV_MISS,
    asian: cov ? (c?.asianHandicap ? renderAsianDualCell(c.asianHandicap) : asianStr(c?.espnOdds)) : COV_MISS,
    hc: hcStr(p, s),
    ouReal: ouRealStr(s), dist: distStr(s),
    scoreMkt: scoreMktStr(s), hfMkt: hfMktStr(s),
    // ESPN 补全(coverage 文件缺 → ⚠️未补全;文件在但该场没抓到 → ❌未取到)
    homeRec: c ? `${c.home.zh} ${recStr(c.home)}` : (cov ? "❌未取到" : COV_MISS),
    awayRec: c ? `${c.away.zh} ${recStr(c.away)}` : (cov ? "❌未取到" : COV_MISS),
    homeLast5: c ? last5Str(c.home) : "", awayLast5: c ? last5Str(c.away) : "",
    // H2H:新版=本地49k历史库(零交锋⚠️如实标);旧 coverage 数组形状兼容
    h2h: c ? renderH2hCell(c.h2h, c.home.zh) : (cov ? "❌未取到" : COV_MISS),
    profile: c ? profileStr(c) : (cov ? "❌未取到" : COV_MISS),
    conf: p.confidence, tier: p.selectionTier?.label ?? "",
    // 💰信心档注金分层(2026-06-12 裁决):每场只挂最可信玩法;档位缺=null 不给金额
    stake: buildStakeSuggestion(p),
    // 🏆赛会(出线/夺冠%)= 世界杯模型超算产物;另入专属列 wcTourney
    wcLine,
    wcElo: wcCells.elo, wcLambda: wcCells.lambda, wcTourney: wcCells.tourney,
    hv,
    // ③ 串关安全度(信心档+risk+证伪标签;只标注不替弃赛)
    parlay: parlaySafety({ tier: p.selectionTier?.label ?? "", risk: p.risk, advLabel: adv?.label ?? "" }),
    // 双选触发(复盘"接住率"口径的赛前依据)
    dc: p.doubleChance?.recommended ? { pick: p.doubleChance.pick, shortCode: p.doubleChance.shortCode } : null,
    // 情景研判一行(自检⑥:scenario-synthesizer 现成 headline,逐场不同,不重算不编造)
    scen: p.scenario?.headline ?? "",
    // 平局画像(2026-06-10 审计rank13:读现成 scenario.dims.draw / experienceContext 字段,不重算;
    //   世界杯场 experienceContext 落全局经验26%不报警,scenario 情景层才有本场平局维度)
    drawRate: p.scenario?.dims?.draw?.prob ?? p.experienceContext?.historicalDrawRate ?? null,
    drawAlert: p.experienceContext?.drawAlert
      ?? ((Number(p.scenario?.dims?.draw?.prob) >= 0.28 && p.pick?.code !== "1") ? (p.scenario.dims.draw.note ?? "平局风险偏高") : null),
    adv,
    // ④ 数据审计矩阵行
    audit: auditFor(p, s, c, prior, wcCtx),
  };
});

// ── 情报系统装配(2026-06-14 展示层·不动概率):预测/确认首发+阵型 / 伤停 / 近期热身 / 新闻动机 ──
//   数据全来自已采集层(advanced:sync 的 layers.lineups/injuries/news)+ 国家队近赛缓存 + 预测首发缓存;
//   任一缺 → 该格如实标⚠️缺(buildMatchIntel 内部逐项标),绝不编造。
let advLayers = null;
try { advLayers = loadAdvancedData(date); } catch { advLayers = null; }
let predictedXi = null;
try { predictedXi = JSON.parse(readFileSync(`D:/football-model-data/intel/predicted-lineups-${date}.json`, "utf8")); }
catch { console.log(`⚠️ 预测首发缓存缺(intel/predicted-lineups-${date}.json):预测首发列标⚠️(确认首发/伤停/近赛照出),先跑 node scripts/sync-predicted-lineups.mjs ${date} 可补。`); }
// 全网赛前情报缓存(伤停/交锋史/小组形势/球队风格·主帅/场地天气/新闻战意,中文+来源URL;展示层不进概率)。
let webIntel = null;
try { webIntel = JSON.parse(readFileSync(`D:/football-model-data/intel/web-intel-${date}.json`, "utf8")); }
catch { console.log(`ℹ️ 全网情报缓存缺(intel/web-intel-${date}.json):伤停/交锋史等扩展情报列标⚠️缺(预测首发/近赛照出)。`); }
const natCache = loadNationalResults();
const layerFor = (layer, fxId) => advLayers?.layers?.[layer]?.fixtureData?.[fxId] ?? null;
// 对话紧凑版首发摘要(详情见 xlsx「情报详情」表;缺标缺不编)
const intelLineupSummary = (side) => {
  if (!side || !side.xi?.length) return `${side?.tag ?? "⚠️缺"}${side?.status ?? ""}`;
  const names = side.xi.slice(0, 5).map((p) => p.name).join("、");
  return `${side.tag}${side.status}${side.formation ? ` ${side.formation}` : ""}:${names}${side.xi.length > 5 ? `…等${side.xi.length}人` : ""}`;
};
const intelByMatch = {};
for (const p of games) {
  const key = `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`;
  const pkey = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`;
  const pred = predictedXi?.predicted?.[pkey] ?? null;
  const web = webIntel?.matches?.[pkey] ?? null;
  intelByMatch[key] = buildMatchIntel({
    fixture: p.fixture,
    lineupSide: layerFor("lineups", p.fixture.id),
    injuriesLayer: layerFor("injuries", p.fixture.id),
    newsLayer: layerFor("news", p.fixture.id),
    predictedHome: pred?.home ?? null,
    predictedAway: pred?.away ?? null,
    homeForm: recentForm(natCache, canonicalTeamName(p.fixture.homeTeam)),
    awayForm: recentForm(natCache, canonicalTeamName(p.fixture.awayTeam)),
    webIntel: web,
  });
}

// ── 14场/任选9(2026-06-11 ③):26085 期腿在历日 store 标 shengfucai,当日 store 为竞彩孪生。
//    从近7天 store 找停售未过的恰14腿期次,映射到今日预测(同对阵同模型),跑 buildFourteenPlan 闸如实裁决;
//    胆位护栏 isLowSampleWorldCup 在 buildFourteenPlan 内部生效(世界杯样本<20不当胆)。 ──
const addDaysIso = (iso, k) => {
  const d = new Date(`${iso}T12:00:00+08:00`);
  d.setDate(d.getDate() + k);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};
let fourteen = null, fourteenFacts = [], fourteenLegs = null, fourteenStoreDate = null;
try {
  for (let k = 0; k <= 6 && !fourteenLegs; k++) {
    const dd = addDaysIso(date, -k);
    let fx = [];
    try { fx = loadFixtures(dd).fixtures ?? []; } catch { fx = []; }
    const legs = fx.filter((f) => f.marketType === "shengfucai" && /第\d+期/.test(f.notes ?? ""));
    if (legs.length !== 14) continue;
    const stopIso = (legs[0].notes ?? "").match(/停售=([0-9T:.\-Z]+)/)?.[1] ?? null;
    const stopDate = stopIso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(stopIso)) : null;
    if (stopDate && stopDate < date) continue; // 过期期次不算(诚实跳过)
    fourteenLegs = legs; fourteenStoreDate = dd;
  }
  if (fourteenLegs) {
    const periodLabel = (fourteenLegs[0].notes ?? "").match(/第\d+期/)?.[0] ?? "本期";
    const stopIso = (fourteenLegs[0].notes ?? "").match(/停售=([0-9T:.\-Z]+)/)?.[1] ?? null;
    const stopBj = stopIso ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(stopIso)) : "未知";
    const views = []; const missing = [];
    for (const leg of fourteenLegs) {
      const pred = byMatch.get(`${leg.homeTeam}|${leg.awayTeam}`);
      if (!pred) { missing.push(`${leg.homeTeam} vs ${leg.awayTeam}`); continue; }
      // 视图包装:模型预测原样(同场同模型),fixture 换成胜负彩腿元数据(期号/停售/marketType)供闸读取——非编造
      views.push({ ...pred, fixture: { ...pred.fixture, marketType: "shengfucai", notes: leg.notes, tags: leg.tags ?? pred.fixture.tags, sequence: leg.sequence } });
    }
    if (missing.length) {
      fourteenFacts.push(["期次事实", `${periodLabel}(store=${fourteenStoreDate})14腿中 ${missing.length} 腿未映射到今日预测:${missing.join("/")}——不硬凑,不发`]);
    } else {
      fourteen = buildFourteenPlan(views, date);
      const kos = fourteenLegs.map((l) => String(l.kickoff ?? "").slice(0, 10)).filter(Boolean).sort();
      const matchOnDate = kos.includes(date);
      fourteenFacts.push(
        ["期次事实", `${periodLabel}·14/14腿已从 store(${fourteenStoreDate})映射到今日模型预测·停售(北京)${stopBj}·腿开赛${kos[0] ?? "?"}~${kos[kos.length - 1] ?? "?"}`],
        ["闸明细", `恰14腿=✅ ｜ 停售未过(${date})=✅ ｜ matchOnDate(当日有腿开赛)=${matchOnDate ? "✅" : (fourteen?.stopSaleDayRelease ? `⛔→✅停售日放行(2026-06-11用户裁决"停售日=最后购买日可发":今日为停售日${stopBj},腿开赛均在未来,买的就是本期)` : `⛔(所有腿开赛日均晚于业务日${date},且今日非停售日;停售日当天将按"停售日=最后购买日"口径放行)`)}`],
        ["胆护栏", "世界杯样本<20一律不当胆(isLowSampleWorldCup,2026-06-10审计rank11):本期14腿全为世界杯场→即便发也0胆只作多选,护栏在buildFourteenPlan内部生效"],
      );
    }
  } else {
    fourteenFacts.push(["期次事实", `近7天 store 未找到停售未过的恰14腿胜负彩期次(${date}回看至${addDaysIso(date, -6)}),如实不发`]);
  }
} catch (e) {
  fourteenFacts.push(["期次事实", `14场期次装配失败(${e.message}),如实不发,不硬凑`]);
}

// ── banner / note 派生(真实数据) ──
const wcN = rows.filter((r) => /世界杯/.test(r.comp)).length, intlN = rows.length - wcN;
const coinRows = rows.filter((r) => /硬币/.test(r.tier));
const handicapOnly = rows.filter((r) => /未开售/.test(r.wld));
let riskNote = "";
if (coinRows.length) riskNote += `最高风险=${coinRows.map((r) => r.match).join("/")}(硬币档·势均易平),强烈建议不单押。`;
if (handicapOnly.length) riskNote += `${handicapOnly.map((r) => r.match.split(" vs ")[0]).join("/")}=悬殊盘只卖让球,信心反映"赢球方向"非"让球过盘",勿当胆。`;
// 平局画像提示(2026-06-10 审计rank13):drawAlert=现成字段(experienceContext.drawAlert 或
//   scenario.dims.draw 平局≥28%且主推非平),只拼提示不重算。
const drawHeavy = rows.filter((r) => r.drawAlert);
if (drawHeavy.length) riskNote += `平局画像风险:${drawHeavy.map((r) => `${r.match}(平${Number.isFinite(r.drawRate) ? Math.round(r.drawRate * 100) + "%" : "⚠️缺"})`).join("/")} 平局维度偏高,主推非平建议双选兼顾。`;
const advKilled = rows.filter((r) => r.adv && /证伪/.test(r.adv.label));
if (advKilled.length) riskNote += `🔴三视角对抗证伪:${advKilled.length}/${rows.length}场被一致证伪(EV全负·模型本质市场跟随器无独立edge),点开看每场致命点;证伪只标注不替你弃赛,买不买你定。`;
// 缺陷#8修(2026-06-10):banner 分子=各赔种真实填充实数(欧赔/让球/比分/半全场/大小球/亚盘逐项),
//   绝不写"n/n 全覆盖";任一赔种降级即 banner 显著⚠️(缺陷#12)。
const counts = buildOddsFillCounts(rows);
const degradeNote = buildDegradeNote(counts, !cov);
const covNote = cov ? "近5场/H2H/攻防=ESPN真实战绩+本地49k历史库H2H" : `近5场/H2H/攻防=⚠️未补全(coverage缺,先跑 fetch-match-coverage)`;
// ── 2026-06-11 新口径段:三列同向自检(让球列放行真实裁决)+ 不同向场清单 + 串关排序说明 + 14场闸裁决 ──
const hvDiverge = rows.filter((r) => r.hv?.sameDir === false);
// ── 四玩法方向矩阵审计(2026-06-11 用户裁决,取代"三列同向"硬约束):
//    每个与胜负平不同向的玩法格必须带依据(来自哪个盘/什么逻辑),无依据=直接 throw 拒交付;
//    同向≠模板复制——同向场=盘口与方向真实共振,不同向场=盘口真实热门所在,两者都可追溯。 ──
const dirMatrix = directionMatrixAudit(rows.map((r) => ({
  match: r.match,
  wldLabel: (String(r.wld).match(/主胜|平局|客胜/) || ["—"])[0],
  markets: [
    { name: "让球", dirLabel: r.hv?.verdict ?? "—", sameAsWld: r.hv?.sameDir, basis: r.hv?.note ?? "模型比分分布真实裁决(0610口径)" },
    { name: "比分", dirLabel: r.msv?.dir ? DIR_LABEL[r.msv.dir] : "—", sameAsWld: r.msv?.sameAsWld, basis: r.msv?.basis },
    { name: "半全场", dirLabel: r.mhv?.dir ? DIR_LABEL[r.mhv.dir] : "—", sameAsWld: r.mhv?.sameAsWld, basis: r.mhv?.basis },
  ],
})));
if (!dirMatrix.ok) throw new Error(`方向矩阵审计FAIL(存在不同向但无依据的玩法格,拒绝交付):${dirMatrix.errors.join(" ; ")}`);
const scoreDiv = rows.filter((r) => r.msv?.sameAsWld === false).length;
const hfDiv = rows.filter((r) => r.mhv?.sameAsWld === false).length;
const resonate = rows.filter((r) => r.msv?.sameAsWld === true && r.mhv?.sameAsWld === true && r.hv?.sameDir !== false).length;
const cohNote = `四玩法独立真实裁决(2026-06-11用户裁决):胜负平=模型综合;让球=模型vs市场过盘裁决(${hvDiverge.length}场与胜负平不同向,逐场注逻辑);比分主推=500比分盘de-vig真实热门(${scoreDiv}场与胜负平不同向);半全场主推=500半全场盘de-vig真实热门(${hfDiv}场不同向);${resonate}场四玩法盘口真实共振同向。方向矩阵逐场审计通过(不同向均带依据,绝无模板复制、绝无人造分歧)。`;
const parlayCount = { g: rows.filter((r) => r.parlay?.grade === "🟢").length, y: rows.filter((r) => r.parlay?.grade === "🟡").length, b: rows.filter((r) => r.parlay?.grade === "⛔").length };
const parlayNote = `串关安全度:🟢${parlayCount.g}/🟡${parlayCount.y}/⛔${parlayCount.b}。${PARLAY_ORDER_NOTE}`;

// ── 串关推荐(2026-06-12 用户需求):总进球原始赔率须实抓(store 只存 de-vig 概率),缺=总进球不出腿如实标。──
let jqsRaw = null;
try { jqsRaw = JSON.parse(readFileSync(`D:/football-model-data/market/jqs-raw-${date}.json`, "utf8")); } catch { jqsRaw = null; }
if (!jqsRaw) console.log(`⚠️ 总进球原始赔率缺(D:/football-model-data/market/jqs-raw-${date}.json 未抓):串关"总进球"玩法不出腿,先跑实抓再重出可补。`);
const parlayGames = games.map((p) => buildParlayLegs(p, jqsRaw?.matches?.[String(p.fixture?.sequence ?? "")]?.odds ?? null));
const parlayPlan = buildParlayPlan(parlayGames);
const parlayAdvBanner = advKilled.length
  ? `🔴当日${advKilled.length}/${rows.length}场被三视角对抗证伪(EV负)、串关安全度⛔${parlayCount.b}场:串关=风险叠乘,本表只按要求给搭法标注,不构成下注建议,买不买你定。`
  : (parlayCount.b ? `⛔串关排除${parlayCount.b}场在列,搭法仅标注参考。` : "");
const fourteenNote = fourteen?.available
  ? `14场/任选9:本期可发(见"14场·任选9"工作表,世界杯腿一律不当胆)。`
  : `14场/任选9:今日不发——${fourteen?.note ?? (fourteenFacts[0]?.[1] ?? "无本期映射")}(详见"数据审计"表内容审计区)。`;
const BANNER = `🔴 完整覆盖交付(${date}):${rows.length}场=${intlN}国际赛+${wcN}世界杯单场。赔率覆盖(逐赔种实数):${buildOddsCoverageLine(counts)};${covNote}。${degradeNote}真缺口:国家队真xG(FBref Cloudflare墙)、零交锋场H2H(49k历史库已查证为缺),已⚠️标不编。${cohNote}${parlayNote}${fourteenNote}${riskNote}模型概率由真盘de-vig派生,1X2系统打不过收盘线、本质市场跟随器,买不买你定。`;
// 审计背书(缺陷#17修):全部从本次 rows + adversarial/<date>.json 动态生成;无当日审计文件 → 不写"已审计"背书句。
const auditFoot = buildAuditFoot({ rows, advData });

// ── 💰注金汇总 + 📊战绩行(2026-06-12 三裁决;ledger 读不到=战绩行不出,不留空假象) ──
const stakeSum = stakeSummary(rows.map((r) => r.stake));
let recordLine = null;
try {
  const ledger = JSON.parse(readFileSync("D:/football-model-exports/recommendation-ledger.json", "utf8"));
  recordLine = buildRecordLine(ledger, date);
} catch { console.log("⚠️ 复盘ledger读取失败:战绩行本次不出(不编)。"); }

// ── 内容审计区(数据审计表末尾,2026-06-11 ④) ──
const advAudited = rows.filter((r) => r.adv).length;
const dcRows = rows.filter((r) => r.dc);
const contentAudit = [
  ["四玩法方向矩阵审计(2026-06-11新口径,取代三列同向)", dirMatrix.ok ? `✅ ${rows.length}场逐场过审:比分不同向${scoreDiv}场/半全场不同向${hfDiv}场/让球不同向${hvDiverge.length}场,全部带依据;${resonate}场盘口真实共振同向` : `⛔FAIL:${dirMatrix.errors.join(";")}`, "不同向=该玩法盘口真实热门所在;同向=盘口共振,非模板复制"],
  ...dirMatrix.lines.map((l) => ["方向矩阵", l]),
  ["让球真实裁决·与胜平负不同向场", hvDiverge.length ? hvDiverge.map((r) => `${r.match}:${r.hv.verdict}(${r.hv.note})`).join(" ║ ") : "无(本次让球裁决全部与胜平负同向)"],
  ["双选触发场(复盘'接住率'口径=任一兑现)", dcRows.length ? dcRows.map((r) => `${r.match} ${r.dc.pick}(${r.dc.shortCode})`).join(" ║ ") : "无"],
  ["证伪标签汇总", `🔴证伪${advKilled.length}场 / 已审计${advAudited}场 / 未审计${rows.length - advAudited}场(未审计≠通过,串关列按"证伪未覆盖"降🟡)`],
  ["串关安全度汇总", `🟢${parlayCount.g}·🟡${parlayCount.y}·⛔${parlayCount.b}`, PARLAY_ORDER_NOTE],
  ["14场/任选9闸裁决", fourteen?.available ? "✅可发(见14场·任选9工作表)" : `⛔不发:${fourteen?.note ?? "无本期映射"}`],
  ...fourteenFacts,
  ["三处口径一致", `xlsx/手机页/英文页由同次运行同源渲染(today-delivery-lib 单写者,T4架构),日期=${date}·行数=${rows.length},生成后另跑 Grep 终检`],
];

// ── xlsx(25列专业版 + 数据审计 + 14场闸裁决,经 xlsx-writer:深紫FF4A148C表头/banner跨列合并/内容感知行高/冻结筛选) ──
const sheets = [
  ...buildXlsxSheets({ date, rows, banner: BANNER, advDataPresent: !!(advData && Object.keys(advData).length), recordLine: recordLine?.text ?? null, stakeNote: stakeSum.note }),
  buildParlaySheet({ date, plan: parlayPlan, jqsFetchedAt: jqsRaw?.fetchedAt ?? null, advBanner: parlayAdvBanner }),
  buildAuditSheet({ date, rows, contentAudit }),
  buildIntelSheet({ date, rows, intelByMatch }),
  { name: "14场·任选9", rows: buildFourteenSheetRows({ date, fourteen, periodFacts: fourteenFacts }) },
];
if (outBase) mkdirSync(outBase, { recursive: true });
// 权威产物=桌面稳定子文件夹(2026-06-11 EBUSY 根修:用户常开着桌面根 xlsx 在看,WPS/Excel 文件锁
//   不该让整条交付链第一步就崩死)。先写子文件夹权威份,桌面根/手机站副本降级 best-effort。
const stableDir = outBase ?? `C:/Users/Administrator/Desktop/足球推荐/${date}`;
mkdirSync(stableDir, { recursive: true });
const xlsxTarget = `${stableDir}/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(xlsxTarget, sheets);

// ── 手机页(核心7列表 + 点行展开该场全部细节;用户 2026-06-09 选定"一打开全部看得见") ──
// 固定文件名防回退(2026-06-10):webshare 现页若已是更新日期(并行会话先交付了明日表),
// 重出旧日期绝不顶掉 —— 改写日期命名副本 足球推荐-<date>.html / football-<date>.html,固定URL保最新。
const readIfExists = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
// 头条副标题=逐赔种真计数 + 降级句进头条(2026-06-10 审计确认缺陷:禁硬编码"5赔种全覆盖"假声明,三面同口径)。
const html = renderMobileHtml({ date, rows, riskNote, intlN, wcN, auditFoot, counts, degradeNote, parlayPlan, recordLine: recordLine?.text ?? null, stakeSum: stakeSum.note });
let htmlTarget = outBase ? `${outBase}/今日足球推荐.html` : "D:/Temp/webshare_lingdao/今日足球推荐.html";
if (!outBase) {
  const mob = resolveHtmlWriteTarget({
    existingHtml: readIfExists(htmlTarget), date, canonicalPath: htmlTarget,
    datedPath: `D:/Temp/webshare_lingdao/足球推荐-${date}.html`, dateRe: /神选·竞彩·(\d{4}-\d{2}-\d{2})/,
  });
  if (mob.preservedNewer) console.log(`⚠️ 固定手机页已是更新日期(${mob.preservedNewer})的交付,不顶掉;本次 ${date} 写日期副本:${mob.path}`);
  htmlTarget = mob.path;
}
writeFileSync(htmlTarget, html, "utf8");

// ── 英文固定URL页 football.html(缺陷#16:三面同源同日期,不再停在旧日期) ──
const enHtml = renderEnglishHtml({ date, rows, riskNote, intlN, wcN, banner: BANNER, auditFoot, parlayPlan, recordLine: recordLine?.text ?? null, stakeSum: stakeSum.note });
let enTarget = outBase ? `${outBase}/football.html` : "D:/Temp/webshare_lingdao/football.html";
if (!outBase) {
  const en = resolveHtmlWriteTarget({
    existingHtml: readIfExists(enTarget), date, canonicalPath: enTarget,
    datedPath: `D:/Temp/webshare_lingdao/football-${date}.html`, dateRe: /神选·足球·(\d{4}-\d{2}-\d{2})/,
  });
  if (en.preservedNewer) console.log(`⚠️ 固定英文页已是更新日期(${en.preservedNewer})的交付,不顶掉;本次 ${date} 写日期副本:${en.path}`);
  enTarget = en.path;
}
writeFileSync(enTarget, enHtml, "utf8");

// ── 副本落位(全部 best-effort,锁住/占用只警告不崩链;权威份已在稳定子文件夹) ──
if (!outBase) {
  try { writeFileSync(`${stableDir}/今日足球推荐.html`, html, "utf8"); } catch (e) { console.log("子文件夹html副本skip:", e.message); }
  try { copyFileSync(xlsxTarget, `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`); }
  catch (e) { console.log(`⚠️ 桌面根副本被占用未更新(多半是表格软件开着旧表,关掉后重跑即可刷新):${e.message}`); }
  try { copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/jingcai-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }
}

// ── 对话(完整) ──
console.log(`\n## ⚡ 今日竞彩完整覆盖交付 · ${date} · ${rows.length}场\n`);
if (recordLine) console.log(recordLine.text);
console.log(stakeSum.note);
for (const r of rows) {
  console.log(`### ${r.idx}. ${r.match}(${r.comp})· ${r.ko} · ${r.tier}${Math.round(r.conf)} · ${r.stake ? `💰${r.stake.text}` : "💰—"} · ${r.parlay?.text ?? ""}`);
  if (r.wcLine) console.log(`  🏆 赛会: ${r.wcLine}`);
  if (r.wcElo && r.wcElo !== "—") console.log(`  🌍 世界杯模型: Elo先验 ${r.wcElo} | 场馆λ ${r.wcLambda}`);
  if (r.scen) console.log(`  🎬 情景: ${r.scen}`);
  console.log(`  ① 胜负平🔶: ${r.wld}`);
  console.log(`     胜平负赔率✅: ${r.euro}`);
  console.log(`  ② 让球真实裁决🔶: ${String(r.hv?.text ?? "⚠️缺").replace(/\n/g, " ")}`);
  console.log(`     竞彩让球🔶: ${r.hcView}`);
  console.log(`     竞彩让球赔率✅: ${r.hc}`);
  console.log(`     博彩亚盘✅: ${String(r.asian).replace(/\n/g, " ")}`);
  console.log(`     📡 信号面板: ${String(r.signals ?? "⚠️未拼装").replace(/\n/g, " ")}`);
  console.log(`  ③ 比分〔${r.scoreSrc}〕: ${String(r.score).replace(/\n/g, " ‖ ")} | 赔率✅: ${r.scoreMkt}`);
  console.log(`     半全场〔${r.hfSrc}〕: ${String(r.halffull).replace(/\n/g, " ‖ ")} | 赔率✅: ${r.hfMkt}`);
  console.log(`     大小球✅: ${r.ouReal} | 进球分布: ${r.dist}`);
  console.log(`  ④ 近5✅: ${r.homeRec} 〔${r.homeLast5}〕 ‖ ${r.awayRec} 〔${r.awayLast5}〕`);
  console.log(`     H2H: ${r.h2h} | 攻防: ${r.profile}`);
  const it = intelByMatch[r.match];
  if (it) {
    console.log(`  🕵️ 情报(展示·不动概率·成熟度${it.maturity}/5):`);
    console.log(`     首发: 主=${String(intelLineupSummary(it.home.lineup)).replace(/\n/g, " ")} ‖ 客=${String(intelLineupSummary(it.away.lineup)).replace(/\n/g, " ")}`);
    console.log(`     伤停: ${it.injuries.text} | 近期: 主 ${it.home.recentForm.text} ‖ 客 ${it.away.recentForm.text}`);
    if (it.news?.text) console.log(`     新闻/动机: ${it.news.text}`);
  }
  if (r.adv) console.log(`  🔴 对抗证伪: ${r.adv.label}${r.adv.ev != null ? ` EV=${r.adv.ev}` : ""} — ${r.adv.kill}`);
  console.log("");
}
// ── 串关推荐(对话口径与 xlsx"串关推荐"表一致) ──
console.log(`\n## 🔗 串关推荐(混合过关·全2串1)`);
if (parlayPlan.ok) {
  for (const t of parlayPlan.tiers) {
    for (const c of t.combos) {
      console.log(`${t.tier} ${c.legs.map((l) => `〔${l.match}〕${l.label}(${Math.round(l.probMkt * 100)}%)`).join(" × ")}`);
      console.log(`   串赔✅${c.odds} · 联合概率🔶${(c.probMkt * 100).toFixed(1)}%${c.probModel != null ? `(模型${(c.probModel * 100).toFixed(1)}%)` : ""} · EV市场口径${c.evMkt} · 2元1注可中${Math.round(c.odds * 2 * 100) / 100}元 · ${c.why}`);
    }
  }
  if (parlayAdvBanner) console.log(`   ${parlayAdvBanner}`);
} else {
  console.log(`⚠️ ${parlayPlan.note}(如实不出)`);
}

// ── 14场/任选9 闸裁决(对话口径与 xlsx"14场·任选9"表一致) ──
console.log(`\n## 🎯 14场/任选9 闸裁决`);
if (fourteen?.available) {
  console.log(`✅ 本期可发:单式串 ${fourteen.singleLine}`);
  console.log(`   复式串 ${fourteen.compoundLine}`);
} else {
  console.log(`⛔ 今日不发14场段(任选9同闸):${fourteen?.note ?? "无本期映射"}`);
}
for (const f of fourteenFacts) console.log(`   ${f[0]}: ${f[1] ?? ""}`);
console.log(`\n## 🔍 内容审计区摘要`);
for (const ca of contentAudit) console.log(`   ${ca[0]}: ${ca[1] ?? ""}`);
console.log(`\n✅ xlsx: ${xlsxTarget}`);
console.log(`✅ 手机页: ${htmlTarget}`);
console.log(`✅ 英文页: ${enTarget}`);
console.log(`\nBANNER: ${BANNER}`);

// ── 交付契约自检(2026-06-13 用户最高指令焊死版式漂移/野页):写完产物即校验,违约 fail-loud ──
//   列序/列数 != 冻结契约,或交付目录冒出第二个带交付banner的页(0613式另起页) → exit 1,本次交付不算成功。
//   合法改列/canonical名=显式跑 freeze-delivery-contract.mjs --write 重冻并提交(增减都要过用户)。
try {
  let contract = null;
  try { contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")); } catch { /* 缺契约下方报 */ }
  const scanDir = outBase || "D:/Temp/webshare_lingdao";
  let bearing = [];
  if (contract) {
    const bannerRes = (contract.deliveryBannerPatterns || []).map((p) => new RegExp(p));
    let files = [];
    try { files = readdirSync(scanDir).filter((f) => f.endsWith(".html")); } catch { /* 目录读不了跳过野页项 */ }
    for (const f of files) {
      try { const t = readFileSync(`${scanDir}/${f}`, "utf8"); if (bannerRes.some((re) => re.test(t))) bearing.push(f); } catch { /* skip */ }
    }
  }
  const v = checkContract(contract, XLSX_HEADERS, bearing);
  if (v.length) {
    console.error("\n🔴 交付契约自检不过(本次交付不算成功):\n" + v.map((x) => "  - " + x).join("\n"));
    console.error("如属合法改动:node scripts/freeze-delivery-contract.mjs --write 重冻并提交后重跑。");
    process.exit(1);
  }
  console.log(`✅ 交付契约自检通过(列序${XLSX_HEADERS.length}逐字 + 交付页唯一,扫${scanDir}带banner ${bearing.length}个均合法)`);
} catch (e) {
  console.error(`🔴 交付契约自检异常(拒认成功交付):${e.message}`); process.exit(1);
}
