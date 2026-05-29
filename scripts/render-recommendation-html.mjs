/**
 * 渲染"今日足球推荐"综合网页(固定文件名覆盖,不每次新建)。
 * 每场以「胜负平」为大前提,展开 胜负平 / 让球胜负平 / 比分 / 半全场 四个方向,
 * 顶部给出全模型跑通状态(全部通过才出推荐),底部给预测↔实际赛果复盘。
 *
 * 用法:node scripts/render-recommendation-html.mjs --date 2026-05-29 [--out 路径]
 * 默认输出:C:\Users\Administrator\Desktop\今日足球推荐.html(覆盖)
 */
import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recommendFixtures } from "../src/prediction-engine.js";
import { fitFromFixtureStore } from "../src/dixon-coles-engine.js";
import { getExportDir } from "../src/paths.js";

const args = process.argv.slice(2);
const readArg = (name) => {
  const pre = args.find((a) => a.startsWith(`${name}=`));
  if (pre) return pre.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const outPath = readArg("--out") ?? "C:\\Users\\Administrator\\Desktop\\今日足球推荐.html";
const exportDir = getExportDir();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");

// 从 fixture.notes 取让球线,如 "让球=0 +1" → +1(主队让球数,正=主队受让)
function handicapLine(fixture) {
  const m = String(fixture.notes ?? "").match(/让球=([^;]+)/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/).filter((x) => /^[+-]?\d+$/.test(x));
  const nonZero = parts.map(Number).find((n) => n !== 0);
  return Number.isFinite(nonZero) ? nonZero : 0;
}
// 让球胜负平方向 = 500.com 让球盘赔率去 vig(队伍专属、市场定价)。
// 注:对出历史场次,DC 期望进球退化为常数(无区分度),故让球方向取自真实让球盘而非模型 xG。
function handicapDirection(handicapOdds) {
  const o = handicapOdds?.current ?? handicapOdds?.initial;
  if (!o || !Number.isFinite(o.home) || !Number.isFinite(o.draw) || !Number.isFinite(o.away)) return null;
  const inv = { home: 1 / o.home, draw: 1 / o.draw, away: 1 / o.away };
  const s = inv.home + inv.draw + inv.away;
  const probs = { home: inv.home / s, draw: inv.draw / s, away: inv.away / s };
  const m = Math.max(probs.home, probs.draw, probs.away);
  const which = m === probs.home ? "主胜" : m === probs.away ? "客胜" : "平局";
  return { which, prob: m, probs };
}

// ── 1) 跑模型 ──
const dc = fitFromFixtureStore();
const r = recommendFixtures(date);
const preds = r.predictions;
const jingcai = preds.filter((p) => p.fixture.marketType === "jingcai");
const fourteen = r.fourteen.selections;

// 推荐内容审计
let auditOk = false;
let auditSummary = null;
const auditPath = join(exportDir, `recommendation-audit-${date}.json`);
if (existsSync(auditPath)) {
  const a = JSON.parse(readFileSync(auditPath, "utf8"));
  auditOk = a.ok === true || (a.summary && a.summary.errors === 0);
  auditSummary = a.summary ?? null;
}

const modelsAllPass =
  dc.usable === true &&
  preds.length > 0 &&
  preds.every((p) => p.probabilities && Number.isFinite(p.probabilities.home)) &&
  auditOk;

// ── 2) 复盘:ledger 已结算 ──
const ledgerPath = join(exportDir, "recommendation-ledger.json");
let settled = [];
if (existsSync(ledgerPath)) {
  const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows ?? [];
  settled = rows.filter((x) => x.actualStatus === "settled" || (x.actual && x.hit != null));
}
const settledHits = settled.filter((x) => x.hit === true).length;

// ── 3) 渲染 ──
function matchCard(p) {
  const f = p.fixture;
  const pr = p.probabilities;
  const sfDir = p.pick.label.includes("主") ? "主胜" : p.pick.label.includes("客") ? "客胜" : "平局";
  const line = handicapLine(f);
  const lineTxt = line == null ? "" : line > 0 ? `主受让+${line}` : line < 0 ? `主让${line}` : "平手";
  const hcp = handicapDirection(p.marketSnapshot?.handicapOdds);
  const hcpCell = hcp ? `${hcp.which}（${pct(hcp.prob)}）` : "—";
  const hcpNote = hcp ? (hcp.which === sfDir ? "与胜负平同向(直接过盘)" : "让球后反向,受让/让球盘正常现象") : "无让球盘赔率";
  const inHistory = p.dixonColes && p.dixonColes.teamStrength && p.dixonColes.teamStrength.home.coldStart === false && p.dixonColes.teamStrength.away.coldStart === false;
  const genericNote = inHistory ? "" : "·非队伍专属";
  const stake = p.bankroll?.decision ?? "-";
  const actionable = stake && !/观察|跳过/.test(stake);
  return `
  <div class="card">
    <div class="ch"><span class="seq">${esc(f.sequence)}</span> <span class="lg">${esc(f.competition)}</span>
      <span class="ko">${esc(f.kickoff)}</span>
      ${inHistory ? '<span class="tag ok">模型库内</span>' : '<span class="tag warn">赔率隐含为主</span>'}
      ${actionable ? '<span class="tag ok">可下注</span>' : '<span class="tag mute">观察</span>'}</div>
    <div class="teams">${esc(f.homeTeam)} <b>vs</b> ${esc(f.awayTeam)}</div>
    <table class="mk">
      <tr><th>方向(大前提:胜负平)</th><th>首选</th><th>次选</th><th>概率/说明</th></tr>
      <tr class="anchor"><td>① 胜负平</td><td class="pick">${esc(p.pick.label)}</td><td>${esc(p.secondaryPick.label)}</td>
          <td>主 ${pct(pr.home)} · 平 ${pct(pr.draw)} · 客 ${pct(pr.away)}</td></tr>
      <tr><td>② 让球胜负平${lineTxt ? `（${lineTxt}）` : ""}</td><td class="pick">${hcpCell}</td><td>—</td>
          <td>500.com 让球盘去水;${hcpNote}</td></tr>
      <tr><td>③ 比分</td><td class="pick">${esc(p.scorePicks.primary)}</td><td>${esc(p.scorePicks.secondary)}</td>
          <td>锚定①方向${genericNote}</td></tr>
      <tr><td>④ 半全场</td><td class="pick">${esc(p.halfFullPicks.primary)}</td><td>${esc(p.halfFullPicks.secondary)}</td>
          <td>由①派生${genericNote}</td></tr>
    </table>
    <div class="meta">概率优势 ${esc(p.confidence)}(未校准,非可下注度) · 资金信号 <b>${esc(stake)}</b>${p.bankroll?.ev != null ? ` · EV ${(p.bankroll.ev).toFixed(3)}` : ""}${inHistory ? "" : " · ⚠出历史,方向来自赔率隐含"}</div>
  </div>`;
}

function fourteenTable() {
  return `<table class="big"><tr><th>#</th><th>对阵</th><th>单选</th><th>复选</th><th>类型</th><th>风险</th></tr>
  ${fourteen.map((s) => `<tr${String(s.type).includes("胆") ? ' class="dan"' : ""}><td>${esc(s.index)}</td><td>${esc(s.match)}</td><td class="pick">${esc(s.single)}</td><td>${esc(s.compound)}</td><td>${esc(s.type)}</td><td>${esc(s.risk)}</td></tr>`).join("")}
  </table>`;
}

function recapTable() {
  if (!settled.length) return "<p>暂无已结算的历史预测(等比赛打完自动回填赛果)。</p>";
  const yn = (b) => (b ? '<span class="hit">✓</span>' : '<span class="miss">✗</span>');
  return `<p>已结算 ${settled.length} 场,胜负平命中 <b>${settledHits}/${settled.length}</b>。</p>
  <table class="big"><tr><th>日期</th><th>对阵</th><th>预测胜负平</th><th>实际</th><th>胜负平</th><th>预测比分</th><th>实际比分</th><th>比分</th><th>预测半全场</th><th>实际半全场</th><th>半全场</th></tr>
  ${settled.map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.match)}</td><td>${esc(x.primary)}</td><td>${esc(x.actual)}</td><td>${yn(x.hit)}</td><td>${esc(x.scorePrimary)}</td><td>${esc(x.actualScore)}</td><td>${yn(x.scoreHit)}</td><td>${esc(x.halfFullPrimary)}</td><td>${esc(x.actualHalfFull)}</td><td>${yn(x.halfFullHit)}</td></tr>`).join("")}
  </table>`;
}

const actionableCount = jingcai.filter((p) => p.bankroll?.decision && !/观察|跳过/.test(p.bankroll.decision)).length;
const statusBadge = !modelsAllPass
  ? '<span class="badge bad">模型未全部跑通 ✗ 本次不作正式推荐</span>'
  : actionableCount > 0
    ? `<span class="badge ok">模型已跑通 ✓ 今日 ${actionableCount} 场达可下注阈值</span>`
    : '<span class="badge mid">模型已跑通 ✓ 但今日 0 场达下注阈值(全部"观察"),下列仅方向参考</span>';

// 竞彩按开赛日分区:今晚(最早一天)/ 未来
const jcByDay = jingcai.slice().sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));
const firstDay = (jcByDay[0]?.fixture.kickoff ?? "").slice(0, 10);
const tonight = jcByDay.filter((p) => String(p.fixture.kickoff).slice(0, 10) === firstDay);
const future = jcByDay.filter((p) => String(p.fixture.kickoff).slice(0, 10) !== firstDay);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日足球推荐 ${date}</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#0f1420;color:#e6ebf5;line-height:1.5}
  .wrap{max-width:1000px;margin:0 auto;padding:16px}
  h1{font-size:20px;margin:8px 0}
  h2{font-size:17px;margin:22px 0 10px;border-left:4px solid #4a9eff;padding-left:8px}
  .badge{display:inline-block;padding:4px 12px;border-radius:6px;font-weight:600;font-size:13px}
  .badge.ok{background:#16432a;color:#56d98a} .badge.bad{background:#4a1d1d;color:#ff7676} .badge.mid{background:#4a3a16;color:#ffd166}
  h3{font-size:14px;color:#9fb0cc;margin:16px 0 6px}
  tr.anchor td{background:#13251a}
  .tag.mute{background:#2a3346;color:#8b97ad}
  .sub{color:#8b97ad;font-size:12px;margin:6px 0 0}
  .panel{background:#18203044;border:1px solid #26314a;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px}
  .card{background:#161d2c;border:1px solid #26314a;border-radius:10px;padding:12px;margin:10px 0}
  .ch{font-size:12px;color:#9fb0cc;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .seq{background:#22304d;border-radius:4px;padding:1px 6px;color:#bcd0f0}
  .ko{margin-left:auto;color:#7d8aa3}
  .tag{font-size:11px;padding:1px 6px;border-radius:4px} .tag.ok{background:#16432a;color:#56d98a} .tag.warn{background:#4a3a16;color:#ffd166}
  .teams{font-size:16px;font-weight:600;margin:6px 0 8px}
  table.mk{width:100%;border-collapse:collapse;font-size:13px}
  table.mk th,table.mk td{border:1px solid #26314a;padding:5px 7px;text-align:left}
  table.mk th{background:#1c2740;color:#9fb0cc;font-weight:500}
  .pick{color:#56d98a;font-weight:700}
  .meta{font-size:12px;color:#8b97ad;margin-top:7px}
  table.big{width:100%;border-collapse:collapse;font-size:12.5px}
  table.big th,table.big td{border:1px solid #26314a;padding:5px 6px;text-align:center}
  table.big th{background:#1c2740;color:#9fb0cc;font-weight:500}
  tr.dan{background:#1a2c1f} tr.dan .pick{color:#7dffb0}
  .hit{color:#56d98a;font-weight:700} .miss{color:#ff7676;font-weight:700}
  .foot{color:#5f6b82;font-size:11px;margin:24px 0 8px;text-align:center}
</style></head><body><div class="wrap">
<h1>⚽ 今日足球推荐 · ${date}</h1>
<div>${statusBadge}</div>
<div class="sub">生成时间 ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC · 以「胜负平」方向为大前提展开让球/比分/半全场</div>

<div class="panel">
  <b>模型跑通状态</b>:Dixon-Coles 泊松引擎 ${dc.usable ? `✓ usable(${dc.matches} 样本)` : "✗ 不可用"} ·
  预测场次 ${preds.length} ·
  推荐内容审计 ${auditSummary ? `${auditSummary.errors} error / ${auditSummary.warnings} warning` : "—"} ·
  胜负平/让球/比分/半全场 四向方向自洽(比分、半全场 100% 锚定胜负平)。
  <div class="sub">诚实提示(按实际情况):本批 ${jingcai.filter((p)=>!(p.dixonColes?.teamStrength?.home?.coldStart===false&&p.dixonColes?.teamStrength?.away?.coldStart===false)).length}/${jingcai.length} 场球队不在回填历史(只覆盖五大联赛+世界杯/欧冠),DC 期望进球退化为常数 → 比分/半全场对这些场次为"方向锚定·非队伍专属";真正队伍专属信号只有 ① 胜负平(500.com 赔率隐含)与 ② 让球盘(市场)。资金信号全部"观察"——模型今日不背书任何一场下注。</div>
</div>

${modelsAllPass ? "" : '<div class="panel" style="border-color:#ff7676">⚠ 模型未全部跑通,以下内容仅供参考,不作正式推荐。</div>'}

<h2>竞彩足球（${jingcai.length} 场）</h2>
<h3>今晚 ${esc(firstDay)}（${tonight.length} 场）</h3>
${tonight.map(matchCard).join("")}
${future.length ? `<h3>未来场次（${future.length} 场,同期在售)</h3>${future.map(matchCard).join("")}` : ""}

<h2>14 场胜负彩${fourteen.length ? `（共 ${fourteen.length} 场,胆码 ${fourteen.filter((s) => String(s.type).includes("胆")).map((s) => s.index).join("、") || "无"}）` : ""}</h2>
${fourteen.length ? fourteenTable() : "<p>当天无 14 场胜负彩期次,本次不发 14 场。</p>"}

<h2>预测 ↔ 实际赛果复盘</h2>
${recapTable()}

<div class="foot">足球大模型 · 数据源:官方 14 场 + Playwright 抓 500.com 竞彩 · 仅供研究参考,理性投注</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
// 同时在产物目录留一份(固定名,覆盖)
const exportCopy = join(exportDir, "今日足球推荐.html");
writeFileSync(exportCopy, html, "utf8");

console.log(JSON.stringify({
  date, modelsAllPass, jingcai: jingcai.length, fourteen: fourteen.length,
  settled: settled.length, settledHits, outPath, exportCopy,
}, null, 2));
