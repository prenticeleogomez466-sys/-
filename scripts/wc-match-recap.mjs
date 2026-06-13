#!/usr/bin/env node
/**
 * 世界杯【逐场】每日复盘回测(2026-06-11 建)——开赛起每天把"赛前冻结预测 vs 实际赛果"逐场比对、累计命中率。
 * ════════════════════════════════════════════════════════════════════════════════
 * 与 wc-recap.mjs 分工:
 *   - wc-recap.mjs   = 赛事级(出线 Brier / 夺冠 logloss / 存活质量),整届一张表。
 *   - 本脚本         = 逐场级(胜平负 / 比分 / 半全场 / 让球 的逐场命中 + 累计命中率),一张累积明细表。
 *
 * 数据真实性(遵铁律,绝不兜底/绝不假结算):
 *   - 预测来源 = recommendation-ledger.json 里的世界杯行(赛前冻结的真实预测)。每场取【kickoff 之前最后一次】
 *     预测(date 最大者)= 最接近开赛、最充分却仍诚实赛前,绝不用赛后回填冒充。
 *   - 结算逻辑 = 直接复用 src/daily-recap.js 的 updateLedgerRow(含"未开赛拒结算"硬闸,防热身赛假赛果污染),
 *     不另写判定,口径与每日大复盘完全一致。
 *   - 未踢的场 = ⏳pending + 客观理由(updateLedgerRow 给出),绝不编赛果;命中率只统计已结算场。
 *
 * 累积:每次运行都从 ledger + fixture-store 重建,结果随真实赛果到位逐日自动填充,无需手工维护历史。
 * 产物:稳定子文件夹(exports 根会被 16:01 计划任务清空,故落桌面)+ exports JSON 快照。
 * 用法: node scripts/wc-match-recap.mjs [--json]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { preflightOrDie } from "../src/preflight-selfcheck.js";

// 启动自检(复盘口径:不要求当日 fixtures——复盘对象是历史日;冻结基线在位是命门)
await preflightOrDie("wc:recap-match 逐场复盘", { requireFixtures: false });
import { pathToFileURL } from "node:url";
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { getExportDir } from "../src/paths.js";
import { updateLedgerRow, findFixtureForLedger } from "../src/daily-recap.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { STAGE } from "./wc-recap.mjs";

const WC_START = "2026-06-11", WC_END = "2026-07-19";
// 铁律(2026-06-11):世界杯复盘基线只用【世界杯模型】预测(worldcup-match-predictions.json),
//   绝不用每日 recommendation-ledger(俱乐部市场跟随)。FROZEN=防事后偷看:每场首次见到且未开球时冻结当时预测。
const WC_PRED = join(getExportDir(), "worldcup-match-predictions.json");
const FROZEN = join(getExportDir(), "worldcup-recap-baseline-frozen.json");
const SNAPSHOT = join(getExportDir(), "worldcup-match-recap.json");
const DESK_DIR = join(homedir(), "Desktop", "足球推荐", "世界杯复盘");
const STAGE_CN = { group: "小组赛", r32: "32强", r16: "16强", qf: "1/4决赛", sf: "半决赛", final: "决赛/三四名" };
const STAGE_ORDER = ["group", "r32", "r16", "qf", "sf", "final"];
const pct = (h, n) => (n > 0 ? (h / n * 100).toFixed(1) + "%" : "—");
const mark = (v) => (v === true ? "✓" : v === false ? "✗" : "—");

/** 盘口隐含概率(home/draw/away)→ 按概率降序的胜平负方向数组,如 ["主胜","平局","客胜"]。缺赔率→[]。 */
const marketRankWld = (impl) => {
  if (!impl || impl.home == null || impl.draw == null || impl.away == null) return [];
  return [["主胜", impl.home], ["平局", impl.draw], ["客胜", impl.away]]
    .sort((a, b) => b[1] - a[1]).map((x) => x[0]);
};
/** 盘口主推(隐含概率最高方向);无赔率→null。 */
const marketFavWld = (impl) => marketRankWld(impl)[0] || null;

/** 把一条世界杯模型预测(wc-match-model 输出)适配成 updateLedgerRow 可结算的 ledger-row 形状。 */
export function wcPredToLedgerRow(p, seq) {
  return {
    date: p.matchDate, sequence: String(seq), competition: "世界杯", match: `${p.home} 对 ${p.away}`,
    primary: p.wld?.pick, secondary: p.wld?.second,
    scorePrimary: p.score?.primary, scoreSecondary: p.score?.secondary, scoreMode: p.score?.trueMostLikely?.score,
    halfFullPrimary: p.halfFull?.consistent?.hf, halfFullSecondary: p.halfFull?.mostLikely?.hf,
    handicapLine: p.handicap?.fairLine ?? "", handicapWldCode: "", // 让球按比分+线在 updateLedgerRow 内裁
    confidence: p.wld?.pickProb != null ? Math.round(p.wld.pickProb * 100) : null,
    modelSource: "wc-match-model", marketAgree: p.market ? p.market.agree : null,
    marketImplied: p.market?.implied || null // 盘口隐含(开球前冻结),供"盘口主推 vs 模型主推"对照
  };
}

/**
 * 冻结世界杯模型预测为复盘基线(防事后偷看):
 *   读 worldcup-match-predictions.json 当前预测;对每场,若 FROZEN 里没有 且 该场尚未开球(kickoff>now 或无赛果),
 *   则把当前预测冻结入 FROZEN;已冻结的场永不覆盖。返回 Map match→ledgerRow。
 */
export function freezeWcBaseline(fixtures) {
  if (!existsSync(WC_PRED)) return new Map();
  const preds = (JSON.parse(readFileSync(WC_PRED, "utf8")).results || []).filter((p) => !p.error);
  const frozen = existsSync(FROZEN) ? JSON.parse(readFileSync(FROZEN, "utf8")) : {};
  let seq = Object.keys(frozen).length, added = 0;
  for (const p of preds) {
    const key = `${p.home} 对 ${p.away}`;
    if (frozen[key]) continue; // 已冻结,永不改
    const fx = fixtures.find((f) => f.homeTeam === p.home && f.awayTeam === p.away);
    const kicked = fx?.result || (fx?.kickoff && new Date(fx.kickoff).getTime() <= Date.now());
    if (kicked) continue; // 已开球的场没冻结过 → 诚实跳过(不追溯冻结,防泄漏);只冻结赛前预测
    frozen[key] = wcPredToLedgerRow(p, ++seq);
    added++;
  }
  // 迁移补列:旧冻结行缺 marketImplied 的,从当前预测补齐(开球后盘口已停止刷新→等价开球前快照,诚实)
  let enriched = 0;
  for (const p of preds) {
    const key = `${p.home} 对 ${p.away}`;
    if (frozen[key] && frozen[key].marketImplied == null && p.market?.implied) {
      frozen[key].marketImplied = p.market.implied; enriched++;
    }
  }
  if (added || enriched) writeFileSync(FROZEN, JSON.stringify(frozen, null, 1));
  const byMatch = new Map();
  for (const [k, row] of Object.entries(frozen)) byMatch.set(k, row);
  return byMatch;
}

/** 跨所有 store 收集世界杯 fixtures,按 对阵+比赛日 去重(优先保留带 result 的)。 */
export function collectWcFixtures(dates, loadFn) {
  const seen = new Map();
  for (const d of dates) {
    if (d < "2026-06-06" || d > WC_END) continue;
    for (const f of loadFn(d).fixtures) {
      const isWC = (f.tags || []).includes("worldcup") || /世界杯|World Cup/i.test(f.competition || "");
      if (!isWC) continue;
      const mk = String(f.kickoff || "").slice(0, 10) || f.localDate || d;
      if (mk < WC_START || mk > WC_END) continue;
      const key = [canonicalTeamName(f.homeTeam), canonicalTeamName(f.awayTeam)].sort().join("|") + "@" + mk;
      const prev = seen.get(key);
      if (!prev || (!prev.result && f.result)) seen.set(key, f);
    }
  }
  return [...seen.values()];
}

export function buildWcMatchRecap(predByMatch, fixtures) {
  const rows = [];
  for (const [, pred] of predByMatch) {
    const fx = findFixtureForLedger(pred, fixtures);
    const matchDate = String(fx?.kickoff || "").slice(0, 10) || pred.matchDate || "";
    const stage = STAGE(matchDate || WC_START);
    const settled = updateLedgerRow(pred, fixtures);
    // 盘口主推对照(与模型主推分开各算各的,不合并):隐含概率最高=盘口主推,前二=盘口"双选"
    const rank = marketRankWld(pred.marketImplied);
    const marketWld = rank[0] || null;
    const isSettled = settled.actualStatus === "settled";
    const marketHit = isSettled && marketWld && settled.actual ? marketWld === settled.actual : null;
    const marketCoverHit = isSettled && rank.length >= 2 && settled.actual
      ? rank.slice(0, 2).includes(settled.actual) : null;
    rows.push({ ...settled, _stage: stage, _matchDate: matchDate,
      _marketWld: marketWld, _marketHit: marketHit, _marketCoverHit: marketCoverHit });
  }
  // 按比赛日 → 阶段排序
  rows.sort((a, b) => (a._matchDate || "").localeCompare(b._matchDate || "") ||
    STAGE_ORDER.indexOf(a._stage) - STAGE_ORDER.indexOf(b._stage));
  return rows;
}

/** 累计命中率(只统计已结算)。让球/半全场用各自可结算子集。 */
function summarize(rows) {
  const settled = rows.filter((r) => r.actualStatus === "settled");
  const hfSettled = settled.filter((r) => r.actualHalfFull);
  const hcSettled = settled.filter((r) => r.handicapWldHit !== null && r.handicapWldHit !== undefined);
  const mkSettled = settled.filter((r) => r._marketWld != null); // 有盘口隐含的已结算场(盘口口径分母独立)
  const r = (sub, pred) => ({ hit: sub.filter(pred).length, n: sub.length });
  return {
    total: rows.length, settled: settled.length, pending: rows.length - settled.length,
    // —— 模型口径(各档分开算)——
    wld: r(settled, (x) => x.hit === true),
    wldCover: r(settled, (x) => x.hit === true || x.secondaryHit === true || x.doubleChanceHit === true),
    // —— 盘口口径(与模型分开,各算各的,绝不合并)——
    marketWld: r(mkSettled, (x) => x._marketHit === true),
    marketCover: r(mkSettled, (x) => x._marketCoverHit === true),
    score: r(settled, (x) => x.scoreHit === true),
    scoreCover: r(settled, (x) => x.scoreHit === true || x.scoreSecondaryHit === true || x.scoreModeHit === true),
    halfFull: r(hfSettled, (x) => x.halfFullHit === true),
    handicap: r(hcSettled, (x) => x.handicapWldHit === true)
  };
}

function summarySheet(date, S, rows) {
  const banner = `⚽ 2026世界杯 · 逐场复盘命中率回测 · 截至 ${date}`;
  const head = ["玩法", "命中/已结算", "累计命中率", "口径说明"];
  const body = [
    ["【模型】胜平负(主选)", `${S.wld.hit}/${S.wld.n}`, pct(S.wld.hit, S.wld.n), "世界杯模型主推方向 = 实际胜平负"],
    ["【模型】胜平负(含次选/双选)", `${S.wldCover.hit}/${S.wldCover.n}`, pct(S.wldCover.hit, S.wldCover.n), "模型主推或次选或双选覆盖命中"],
    ["【盘口】主推(单选)", `${S.marketWld.hit}/${S.marketWld.n}`, pct(S.marketWld.hit, S.marketWld.n), "盘口隐含概率最高方向 = 实际(与模型分开各算各)"],
    ["【盘口】前二(双选)", `${S.marketCover.hit}/${S.marketCover.n}`, pct(S.marketCover.hit, S.marketCover.n), "盘口隐含概率前二方向任一 = 实际"],
    ["比分(单选)", `${S.score.hit}/${S.score.n}`, pct(S.score.hit, S.score.n), "首选比分 = 实际比分"],
    ["比分(含备选/众数)", `${S.scoreCover.hit}/${S.scoreCover.n}`, pct(S.scoreCover.hit, S.scoreCover.n), "首选/次选/矩阵众数任一命中"],
    ["半全场", `${S.halfFull.hit}/${S.halfFull.n}`, pct(S.halfFull.hit, S.halfFull.n), "仅半场赛果可得的场计入"],
    ["让球胜平负", `${S.handicap.hit}/${S.handicap.n}`, pct(S.handicap.hit, S.handicap.n), "按比分+让球线判,仅有让球线的场"]
  ];
  // 分阶段
  const byStage = STAGE_ORDER.map((s) => {
    const sub = rows.filter((x) => x._stage === s && x.actualStatus === "settled");
    const hit = sub.filter((x) => x.hit === true).length;
    return sub.length ? [STAGE_CN[s], `${hit}/${sub.length}`, pct(hit, sub.length), "该阶段胜平负单选"] : null;
  }).filter(Boolean);
  const stat = [`共 ${S.total} 场 · 已结算 ${S.settled} · 待开赛/待回填 ${S.pending}`];
  const note = S.settled === 0
    ? ["诚实空态:暂无已结算场(首战 6/12),预测已冻结,赛果到位后逐日自动填充命中率。"]
    : ["命中率只统计真实已结算场;⏳待回填见明细表理由列。CLV 才是真 KPI,命中率为辅(见记忆)。"];
  return [[banner], stat, head, ...body,
    ...(byStage.length ? [["— 分阶段(胜平负单选)—", "", "", ""], ...byStage] : []), note];
}

function detailSheet(rows) {
  const head = ["比赛日", "阶段", "对阵", "模型主推", "实际", "模型✓", "盘口主推", "盘口✓", "预测比分", "实际比分", "✓",
    "预测半全场", "实际半全场", "✓", "让球线", "让球预测", "让球实际", "✓", "状态/⏳理由"];
  const body = rows.map((r) => {
    const pendDot = r.actualStatus === "settled" ? "已结算" : "⏳ " + (r.pendingReason || "待开赛/待回填");
    const wldPred = r.primary + (r.secondary ? `/${r.secondary}` : "") +
      (Array.isArray(r.doubleChanceCodes) && r.doubleChanceCodes.length ? `(双选${r.doubleChanceShort || ""})` : "");
    return [r._matchDate || "—", STAGE_CN[r._stage] || r._stage, r.match,
      wldPred, r.actual || "", mark(r.hit),
      r._marketWld || "", mark(r._marketHit),
      r.scorePrimary + (r.scoreSecondary ? `/${r.scoreSecondary}` : ""), r.actualScore || "", mark(r.scoreHit || r.scoreSecondaryHit || r.scoreModeHit),
      r.halfFullPrimary || "", r.actualHalfFull || "", mark(r.halfFullHit),
      r.handicapLine ?? "", r.handicapWld || "", r.actualHandicap || "", mark(r.handicapWldHit),
      pendDot];
  });
  return [head, ...body];
}

function runMain() {
  const fixtures = collectWcFixtures(listFixtureDates(), loadFixtures);
  if (!existsSync(WC_PRED)) { console.log("无 worldcup-match-predictions.json,先跑 npm run wc:predict(世界杯模型出预测)。"); process.exit(0); }
  const predByMatch = freezeWcBaseline(fixtures);
  if (!predByMatch.size) { console.log("世界杯模型预测基线为空(无赛前可冻结场)。"); process.exit(0); }

  const rows = buildWcMatchRecap(predByMatch, fixtures);
  const S = summarize(rows);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n=== 2026世界杯逐场复盘(${rows.length}场冻结预测,已结算 ${S.settled},待开赛/回填 ${S.pending})===`);
  console.log(`【模型】主选 ${S.wld.hit}/${S.wld.n}(${pct(S.wld.hit, S.wld.n)}) | 含次选/双选 ${pct(S.wldCover.hit, S.wldCover.n)}`);
  console.log(`【盘口】主推 ${S.marketWld.hit}/${S.marketWld.n}(${pct(S.marketWld.hit, S.marketWld.n)}) | 前二双选 ${pct(S.marketCover.hit, S.marketCover.n)}   ← 与模型分开各算各`);
  console.log(`比分 ${pct(S.score.hit, S.score.n)} | 半全场 ${pct(S.halfFull.hit, S.halfFull.n)} | 让球 ${pct(S.handicap.hit, S.handicap.n)}`);
  if (S.settled === 0) console.log("诚实空态:首战 6/12,暂无已结算场;预测已冻结,赛果到位后逐日自动回测填充。");

  if (!existsSync(DESK_DIR)) mkdirSync(DESK_DIR, { recursive: true });
  const xlsxPath = join(DESK_DIR, "2026世界杯逐场复盘命中率_累计.xlsx");
  writeXlsxWorkbook(xlsxPath, [
    { name: "命中率汇总", rows: summarySheet(today, S, rows) },
    { name: "逐场复盘明细", rows: detailSheet(rows) }
  ]);
  console.log("📊 累计复盘表:", xlsxPath);

  writeFileSync(SNAPSHOT, JSON.stringify({ generatedAt: new Date().toISOString(), date: today, summary: S,
    rows: rows.map((r) => ({ matchDate: r._matchDate, stage: r._stage, match: r.match, primary: r.primary,
      actual: r.actual || null, hit: r.hit ?? null,
      marketWld: r._marketWld || null, marketHit: r._marketHit ?? null, marketCoverHit: r._marketCoverHit ?? null,
      scorePrimary: r.scorePrimary, actualScore: r.actualScore || null,
      scoreHit: r.scoreHit ?? null, halfFullPrimary: r.halfFullPrimary, actualHalfFull: r.actualHalfFull || null,
      halfFullHit: r.halfFullHit ?? null, handicapWld: r.handicapWld, actualHandicap: r.actualHandicap || null,
      handicapWldHit: r.handicapWldHit ?? null, status: r.actualStatus, pendingReason: r.pendingReason || null })) }, null, 1));
  console.log("🗂  JSON 快照:", SNAPSHOT);

  if (process.argv.includes("--json")) console.log(JSON.stringify(S, null, 1));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runMain();
