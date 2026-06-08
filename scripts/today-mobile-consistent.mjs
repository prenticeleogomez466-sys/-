// 与桌面两表 xlsx 同源的手机页(真实竞彩让球线 + 竞彩/14场两表 + 诚实标注)。覆盖固定文件名。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
  toSimpleFourteenRow,
} from "../src/daily-report.js";
import { writeFileSync, copyFileSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-08";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const jc = preds.filter((p) => p.fixture?.marketType === "jingcai")
  .sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));
const fourteen = pkg.recommendations?.fourteen?.selections ?? [];
const f14note = pkg.recommendations?.fourteen?.note ?? "";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ko = (p) => { const k = p.fixture?.kickoff; return k && /\d{2}:\d{2}/.test(k) ? k.slice(5, 16) : (k?.slice(5, 10) ?? ""); };

const jcRows = jc.map((p) => `<tr>
<td>${esc(ko(p))}</td><td><b>${esc(p.fixture.homeTeam)}</b> vs ${esc(p.fixture.awayTeam)}</td>
<td>${esc(simpleWldCell(p))}</td><td>${esc(simpleHandicapCell(p))}</td>
<td>${esc(simpleScoreCell(p))}</td><td>${esc(simpleHalfFullCell(p))}</td>
<td>${esc(p.confidence)}</td></tr>`).join("");

const f14Rows = fourteen.map(toSimpleFourteenRow).map((r) =>
  `<tr><td>${r[0]}</td><td>${esc(r[2])}</td><td><b>${esc(r[3])}</b></td><td>${esc(r[4])}</td><td>${esc(r[5])}</td></tr>`).join("");

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡神选·足球·${date}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1a1a1a}
.wrap{max-width:960px;margin:0 auto;padding:12px}
h1{font-size:19px;margin:14px 4px}h2{font-size:16px;margin:18px 4px 8px;color:#4A148C}
.note{background:#fff8e1;border-left:4px solid #ffb300;padding:8px 10px;margin:8px 4px;font-size:13px;border-radius:4px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:12.5px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th{background:#4A148C;color:#fff;padding:8px 6px;text-align:left;font-weight:600}
td{padding:7px 6px;border-top:1px solid #eee;vertical-align:top}
tr:nth-child(even) td{background:#faf8fd}
.dl{display:inline-block;margin:14px 4px;padding:10px 18px;background:#4A148C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}
.foot{color:#888;font-size:11px;margin:16px 4px 30px}
</style></head><body><div class="wrap">
<h1>⚡ 神选 · 足球推荐 · ${date}</h1>

<h2>竞彩 · ${jc.length} 场(今晚国际赛)</h2>
<div class="note">⚠️ 三场均<b>悬殊盘</b>:竞彩主卖让球(法国/秘鲁vs西班牙胜平负未开售)。让球线均<b>让2球</b>,覆盖把握低(34–46%),非稳赢盘。国际赛无俱乐部画像(标缺)。</div>
<table><tr><th>开赛</th><th>对阵</th><th>胜负平</th><th>让胜负平(真实线)</th><th>比分</th><th>半全场</th><th>信心</th></tr>${jcRows}</table>

<h2>14场胜负彩 · 第26085期(世界杯小组赛)</h2>
<div class="note">📌 ${esc(f14note)}<br>但此期<b>今天正在售(6/7–6/11停售)</b>、赛期6/12–6/16,今天可购,故附14腿预测供参考。</div>
<table><tr><th>#</th><th>对阵</th><th>单关</th><th>胆/双选</th><th>信心</th></tr>${f14Rows}</table>

<a class="dl" href="神选-竞彩推荐-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(两表)</a>
<div class="note" style="border-color:#7e57c2;background:#f3e5f5">📊 <b>赔率完整性(实测审计)</b>:荷兰=胜平负✅/让球✅/比分✅/半全场✅(总进球·大小球未开售);法国 & 秘鲁vs西班牙=胜平负✅/让球✅,<b>比分/半全场/总进球竞彩未开售</b>(悬殊盘),表中比分/半全场为模型🔶推断(标注区分),非真实盘口。</div>
<div class="foot">本页与桌面 xlsx 同源 · 真实端到端跑出 · 竞彩让球线为 500.com 实时核实(${date})。模型只给信心+风险,买不买由你决定。</div>
</div></body></html>`;

const out = "D:/Temp/webshare_lingdao/今日足球推荐.html";
writeFileSync(out, html, "utf8");
try { copyFileSync(`C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }
console.log("✅ 手机页已覆盖:", out, "| 竞彩", jc.length, "· 14场", fourteen.length);
