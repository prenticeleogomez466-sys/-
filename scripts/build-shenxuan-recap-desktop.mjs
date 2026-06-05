#!/usr/bin/env node
/**
 * 神选复盘 —— 桌面单一总表(2026-05-31 用户硬要求)。
 *
 * 用户要的:桌面一张「神选复盘」,每天用一个复盘的预测,第二天上午 11 点跟实际赛果
 * 回填命中率对比,永久累积。复盘数据本就由 daily-recap.js(FootballModel-RecapBacktest
 * 每日 11:00)产出在 D:\football-model-exports\daily-recap-*.json,但一直埋在 D 盘深处、
 * 用户从没看到过。本脚本把全部历史复盘汇成一张干净的桌面 xlsx。
 *
 * 产物:<导出目录>\神选复盘.xlsx + 桌面副本 神选复盘.xlsx
 *   sheet1 每日命中率 —— 一天一行(最新在上):推荐场次/已结算/待回填/胜平负·比分·半全场命中率/状态
 *   sheet2 逐场复盘明细 —— 每场:日期/赛事/对阵/预测胜平负·比分·半全场/信心/实际/命中/状态
 *   sheet3 说明 —— 数据源/口径/天花板
 *
 * 用法:node scripts/build-shenxuan-recap-desktop.mjs
 * 只读 daily-recap-*.json,不重算、不触网,纯汇总(遵 feedback_no_fabrication_live_only)。
 */
import "../src/env.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { getExportDir } from "../src/paths.js";

const exportDir = getExportDir();
const pct = (hit, total) => (total > 0 ? `${hit}/${total} (${((hit / total) * 100).toFixed(1)}%)` : "—");

// 收集所有 daily-recap-YYYY-MM-DD.json,按日期升序读
const files = readdirSync(exportDir)
  .filter((f) => /^daily-recap-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

if (!files.length) {
  console.error(`未找到任何 daily-recap-*.json(${exportDir});复盘任务可能还没跑过`);
  process.exit(1);
}

const days = [];
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(exportDir, f), "utf8"));
    if (j?.date) days.push(j);
  } catch (e) {
    console.log(`跳过损坏文件 ${f}:${e.message}`);
  }
}

// 让球预测显示:让球主胜/走盘/让球客胜 + 让球线(主队视角,-1=让1球)
const fmtHandicapPred = (r) => {
  if (!r.handicapWld) return "—";
  const ln = r.handicapLine;
  const lnStr = ln === "" || ln == null ? "" : (Number(ln) === 0 ? "(平手)" : `(${Number(ln) > 0 ? "+" : ""}${ln})`);
  return `${r.handicapWld}${lnStr}`;
};
const mark = (v) => (v === true ? "✓ 命中" : v === false ? "✗ 未中" : "");

// 每日让球命中率(从逐场 rows 现算,summary 里没有这一项)
const dayHandicap = (d) => {
  const rs = (d.rows ?? []).filter((r) => r.handicapWldHit === true || r.handicapWldHit === false);
  return { hit: rs.filter((r) => r.handicapWldHit === true).length, total: rs.length };
};

// ---- sheet1 每日命中率(最新在上)----
const dailyHeader = ["日期", "推荐场次", "已结算", "待回填", "胜平负命中", "胜平负(含次选)", "让球命中", "比分命中", "半全场命中", "CLV", "状态"];
const dailyRows = [dailyHeader];
for (const d of [...days].reverse()) {
  const s = d.summary ?? {};
  const settled = s.settled ?? 0;
  const pending = s.pending ?? 0;
  const hc = dayHandicap(d);
  const status = settled === 0 && pending > 0 ? "⏳ 待赛果回填" : pending > 0 ? "🔄 部分回填" : settled > 0 ? "✅ 已结算" : "—";
  dailyRows.push([
    d.date,
    s.predictions ?? "—",
    settled,
    pending,
    pct(s.winDrawLossPrimary?.hit ?? 0, s.winDrawLossPrimary?.total ?? 0),
    pct(s.winDrawLossCover?.hit ?? 0, s.winDrawLossCover?.total ?? 0),
    pct(hc.hit, hc.total),
    pct(s.scorePrimary?.hit ?? 0, s.scorePrimary?.total ?? 0),
    pct(s.halfFullPrimary?.hit ?? 0, s.halfFullPrimary?.total ?? 0),
    s.clv?.measurable ? `${s.clv.verdict ?? ""}` : "⚪ 暂无可测",
    status
  ]);
}

// 累计总览(所有已结算合计)
let agg = { wdlHit: 0, wdlTotal: 0, wdlCoverHit: 0, hcHit: 0, hcTotal: 0, scoreHit: 0, scoreTotal: 0, hfHit: 0, hfTotal: 0 };
for (const d of days) {
  const s = d.summary ?? {};
  const hc = dayHandicap(d);
  agg.wdlHit += s.winDrawLossPrimary?.hit ?? 0;
  agg.wdlTotal += s.winDrawLossPrimary?.total ?? 0;
  agg.wdlCoverHit += s.winDrawLossCover?.hit ?? 0;
  agg.hcHit += hc.hit;
  agg.hcTotal += hc.total;
  agg.scoreHit += s.scorePrimary?.hit ?? 0;
  agg.scoreTotal += s.scorePrimary?.total ?? 0;
  agg.hfHit += s.halfFullPrimary?.hit ?? 0;
  agg.hfTotal += s.halfFullPrimary?.total ?? 0;
}

// ---- sheet2 逐场复盘明细(最新在上)—— 每玩法 预测/实际/命中 三列并排 ----
const detailHeader = [
  "日期", "赛事", "对阵",
  "预测·胜平负", "实际·胜平负", "胜平负✓",
  "预测·让球胜平负", "实际·让球", "让球✓",
  "预测·比分", "实际·比分", "比分✓",
  "预测·半全场", "实际·半全场", "半全场✓",
  "信心", "档位", "状态", "待结算原因", "来源"
];
const detailRows = [detailHeader];
for (const d of [...days].reverse()) {
  for (const r of d.rows ?? []) {
    const settled = r.actualStatus === "settled" || r.actual;
    detailRows.push([
      d.date,
      r.competition ?? "",
      r.match ?? "",
      r.primary ?? "", settled ? (r.actual ?? "") : "", mark(r.hit),
      fmtHandicapPred(r), settled ? (r.actualHandicap ?? "") : "", mark(r.handicapWldHit),
      r.scorePrimary ?? "", settled ? (r.actualScore ?? "") : "", mark(r.scoreHit),
      r.halfFullPrimary ?? "", settled ? (r.actualHalfFull ?? "") : "", mark(r.halfFullHit),
      Number.isFinite(r.confidence) ? r.confidence : "",
      r.tier ?? "",
      settled ? "已结算" : "⏳ 待回填",
      settled ? "" : (r.pendingReason ?? ""),
      r.provenance ?? r.source ?? ""
    ]);
  }
}

// ---- sheet3 说明 ----
const note = [
  ["神选复盘 · 说明", ""],
  ["这是什么", "每天的神选预测(胜平负/比分/半全场)+ 第二天上午 11:00 自动回填实际赛果与命中率,永久累积。"],
  ["怎么读", "『每日命中率』一天一行(最新在上):当天推荐的预测,赛果出来后回填命中。当天预测当晚/次日比赛 → 次日 11:00 结算。"],
  ["回填时机", "Windows 计划任务 FootballModel-RecapBacktest 每日 11:00 跑,抓前一日赛果逐场结算,本表自动刷新。"],
  ["", ""],
  ["累计总览(全历史已结算)", ""],
  ["胜平负命中(首选)", pct(agg.wdlHit, agg.wdlTotal)],
  ["胜平负命中(含次选覆盖)", pct(agg.wdlCoverHit, agg.wdlTotal)],
  ["让球胜平负命中", pct(agg.hcHit, agg.hcTotal)],
  ["比分命中", pct(agg.scoreHit, agg.scoreTotal)],
  ["半全场命中", pct(agg.hfHit, agg.hfTotal)],
  ["", ""],
  ["诚实天花板(物理上限,别被夸大命中率骗)", ""],
  ["胜平负", "顶级模型/分析师 ≈ 市场 54-55%(本模型走查 51-55%);60%+ 不可持续"],
  ["让球胜平负", "DC-τ覆盖+市场亚盘水位 ≈ 44-46%(让球本质比胜平负更难)"],
  ["比分", "12-15%(单场比分本质高方差)"],
  ["半全场", "28-35%"],
  ["让球早期为'—'说明", "让球预测从 2026-05-31 起才落账本;此前历史场次账本无让球字段,显示'—'属正常。"],
  ["数据源", "daily-recap-*.json(D:\\football-model-exports);赛果来自 OpenLigaDB/ESPN 等免费源,只结算真抓到赛果的场,不臆造。"],
  ["赛果回填", "ESPN 全联赛单日赛果(免费)按 canonical 主队锚定匹配补进,覆盖国际赛/北欧/日职/欧冠/big-5/解放者杯等;每日 11:00 自动补。"],
  ["半全场为何常空", "ESPN 单日赛果不带半场比分 → 半全场命中率只在『有半场数据』的场上算(分母小),不是真 0%。"],
  ["仍 pending 的", "①未踢的比赛(如 6 月世界杯前国际热身赛竞彩提前挂出);②芬超等免费源无同日赛果的联赛;③赛季已结束的沙特等。均诚实留 ⏳,不编造。"],
  ["待回填说明", "状态=⏳ 的行表示赛果还没出/还没结算;第二天 11:00 后再看即回填。"],
];

// 结尾【自检】结论(取最近一天的 selfcheck,落 daily-recap-system-prompt output_format)。
const latestWithSc = [...days].reverse().find((d) => d.selfcheck);
if (latestWithSc) {
  const sc = latestWithSc.selfcheck;
  const ok = (v) => (v ? "✓" : "✗");
  note.push(["", ""]);
  note.push([`【自检】(${latestWithSc.date})`, `全场次覆盖${ok(sc["全覆盖"])}(${sc["覆盖场次"] ?? "?"}场) / 赛果穷尽免费源${ok(sc["穷尽免费源"])}(${(sc["免费源"] ?? []).join("+") || "无"}) / 单总表${ok(sc["单总表"])} / ⏳均有理由${ok(sc["⏳均有理由"])}(${sc["待回填已写理由"] ?? 0}/${sc["待回填"] ?? 0}) / 0假结算${ok(sc["0假结算"])}`]);
}

const sheets = [
  { name: "每日命中率", rows: dailyRows },
  { name: "逐场复盘明细", rows: detailRows },
  { name: "说明", rows: note },
];

const outPath = join(exportDir, "神选复盘.xlsx");
writeXlsxWorkbook(outPath, sheets);
console.log(`已生成神选复盘:${outPath}(${days.length} 天 / ${detailRows.length - 1} 场)`);

// 桌面副本(用户每天就看这一张)。
// 2026-06-05 加硬:此前桌面写失败(文件被占用/路径不存在)只 console.log 然后静默退出 0,
//   导致桌面表能无声消失而复盘任务仍报成功(0x0)。改为:任一桌面候选写成即算成功;
//   全部失败则 console.error + 退出码 1,让 recap 自动化的本步骤显式 WARN/ALERT,不再静默。
const desktopCandidates = [join(homedir(), "Desktop"), "D:\\Users\\Administrator\\Desktop"];
let desktopWritten = false;
const desktopErrors = [];
for (const dir of desktopCandidates) {
  if (!existsSync(dir)) { desktopErrors.push(`${dir}(目录不存在)`); continue; }
  const p = join(dir, "神选复盘.xlsx");
  try {
    writeXlsxWorkbook(p, sheets);
    console.log(`桌面副本:${p}`);
    desktopWritten = true;
    break;
  } catch (e) {
    desktopErrors.push(`${p}(${e.message})`);
  }
}
if (!desktopWritten) {
  console.error(`⚠️ 桌面副本写入失败,全部候选均未成功:\n  - ${desktopErrors.join("\n  - ")}`);
  console.error(`   D 盘总表已生成(${outPath}),但用户桌面《神选复盘.xlsx》未刷新——请检查文件是否被占用。`);
  process.exitCode = 1;
}

// 控制台速览(最近 7 天)
console.log("\n最近复盘速览:");
console.log(dailyHeader.slice(0, 8).join(" | "));
for (const r of dailyRows.slice(1, 8)) console.log(r.slice(0, 8).join(" | "));
console.log(`\n累计胜平负命中 ${pct(agg.wdlHit, agg.wdlTotal)} · 比分 ${pct(agg.scoreHit, agg.scoreTotal)} · 半全场 ${pct(agg.hfHit, agg.hfTotal)}`);
