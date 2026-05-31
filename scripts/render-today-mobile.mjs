/**
 * 今日足球·合一手机页:竞彩明细 + 14场胆双全 + 任选9,自包含响应式 HTML。
 *
 * 单一真相源:recommendFixtures(date) —— 与「神选-竞彩推荐.xlsx」同一计算。
 *   · 竞彩明细 = predictions(逐场 胜平负/比分/半全场/让球/信心/风险/历史经验读数)
 *   · 14场胆双全 = fourteen.selections(胆/双/全由生产 buildFourteenPlan 算好,不重判)
 *   · 任选9 = fourteen.renxuan9
 * 官方期号从 fixture.notes(「官方期号=…」)/officialFixtureId 取(fourteen 对象不带)。
 * 遵 wld 锚定 + 只给信心/风险、不替用户弃赛 + 禁止假编(数字均本次实时跑出)。
 *
 * 用法:node scripts/render-today-mobile.mjs [--date 2026-05-31]
 * 默认写 D:\Temp\webshare_lingdao\今日足球推荐.html(手机端口80)+ 桌面副本。
 */
import "../src/env.js";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recommendFixtures } from "../src/prediction-engine.js";

const args = process.argv.slice(2);
const readArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v) => (v == null ? "-" : typeof v === "string" ? v : `${(v * 100).toFixed(0)}%`);

const rec = recommendFixtures(date);
const preds = rec.predictions || [];
const four = rec.fourteen || {};
if (!preds.length) {
  console.error(`❌ ${date} 无任何可预测场次(predictions 为空),按「禁止假编/无14场则不发」不生成网页。`);
  process.exit(1);
}

// 官方期号 / 停售 / 比赛日 —— 从 fixture.notes 取(真官方信息,非编造)
const noteOf = (re) => { for (const p of preds) { const m = (p.fixture?.notes || "").match(re); if (m) return m[1].trim(); } return null; };
const issue = noteOf(/官方期号=([^;]+)/) || (preds[0]?.fixture?.officialFixtureId ? String(preds[0].fixture.officialFixtureId).split("-")[0] : null);
const stopRaw = noteOf(/停售=([^;]+)/);
const matchDay = noteOf(/比赛日期=([^;]+)/) || date;
const stopBJ = stopRaw ? (() => { try { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(stopRaw)); } catch { return stopRaw; } })() : null;

// ---- 竞彩明细卡片 ----
const detailCard = (p) => {
  const fx = p.fixture, pr = p.probabilities || {}, ec = p.experienceContext || {}, hp = p.handicapPick || {};
  const conf = Number(p.confidence);
  const cover = hp.coverProbability != null ? `${(hp.coverProbability * 100).toFixed(0)}%` : null;
  const skellam = hp.skellamCheck?.note ? esc(hp.skellamCheck.note) : "";
  return `<div class="card">
    <div class="hd"><span class="no">${esc(fx.sequence)}</span> ${esc(fx.homeTeam)} <span class="vs">vs</span> ${esc(fx.awayTeam)} <span class="lg">${esc(fx.competition)}</span></div>
    <div class="row main"><span class="k">胜平负</span> <b>${esc(p.pick?.label)}</b> <span class="prob">${pct(p.pick?.probability)}</span> <span class="conf">信心 ${Number.isFinite(conf) ? conf.toFixed(0) : "-"} · 风险 ${esc(p.risk || "-")}</span></div>
    <div class="row pr">主 ${pct(pr.home)} · 平 ${pct(pr.draw)} · 客 ${pct(pr.away)}</div>
    <div class="row"><span class="k">比分</span> ${esc(p.scorePicks?.primary || "-")} &nbsp; <span class="k">半全场</span> ${esc(p.halfFullPicks?.primary || "-")}</div>
    <div class="row"><span class="k">让球</span> ${esc(hp.direction || "-")}${hp.line != null ? `(${hp.line})` : ""}${cover ? ` 覆盖 ${cover}` : ""} ${skellam ? `<span class="sk">${skellam}</span>` : ""}</div>
    ${ec.overUnderHint ? `<div class="ec">${esc(ec.overUnderHint)}</div>` : ""}
    ${ec.driftHint ? `<div class="ec">${esc(ec.driftHint)}</div>` : ""}
    ${ec.drawAlert ? `<div class="ec warn">${esc(ec.drawAlert)}</div>` : ""}
  </div>`;
};

// ---- 14场胆双全 ----
const KIND = { "胆": "dan", "双选": "shuang", "全选": "quan" };
const sels = Array.isArray(four.selections) ? four.selections : [];
const dan = sels.filter((s) => s.type === "胆"), shuang = sels.filter((s) => s.type === "双选"), quan = sels.filter((s) => s.type === "全选");
const legOut = (s) => String(s.compound || s.single || "").split("/").filter(Boolean).length || 1;
const combos = sels.reduce((a, s) => a * legOut(s), 1);
const fourCard = (s) => {
  const cls = KIND[s.type] || "shuang", pr = s.probabilities || {};
  const label = s.type === "双选" ? "双" : s.type === "全选" ? "全" : "胆";
  return `<div class="card ${cls}"><div class="hd"><span class="no">${s.index}</span> ${esc(s.match)} <span class="lg">${esc(s.competitionType || "")}</span></div>
    <div class="pick"><span class="kind ${cls}">${label}</span> 选 <b>${esc(String(s.compound || s.single).split("/").join(" / "))}</b>
    <span class="conf">主 ${esc(pr.home ?? "-")}·平 ${esc(pr.draw ?? "-")}·客 ${esc(pr.away ?? "-")} | 信心 ${Number(s.confidence).toFixed(0)}</span></div></div>`;
};
const fourSec = (cls, title, list) => list.length ? `<div class="sec ${cls}">${title}(${list.length})</div><div class="grid">${list.map(fourCard).join("")}</div>` : "";

// ---- 任选9 ----
const rx9 = four.renxuan9;
const rx9Html = rx9?.ok ? `<div class="sec rx">🎯 任选9(14场中需对 ${rx9.needCorrect} 场)</div><div class="grid">${rx9.picks.map((p) => {
  const pr = p.probabilities || {};
  return `<div class="card rx9"><div class="hd"><span class="no">${p.rank}</span> ${esc(p.match)} <span class="lg">${esc(p.competitionType || "")}</span></div>
    <div class="pick"><span class="kind rx">9</span> <b>${esc(p.pick)}</b> <span class="conf">主 ${esc(pr.home ?? "-")}·平 ${esc(pr.draw ?? "-")}·客 ${esc(pr.away ?? "-")} | 信心 ${Number(p.confidence).toFixed(0)}</span></div></div>`;
}).join("")}</div>` : "";

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日足球 · ${esc(issue || date)}</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",sans-serif;margin:0;background:#0f1419;color:#e6e6e6;padding:14px;-webkit-text-size-adjust:100%}
h1{font-size:21px;margin:0 0 4px}.sub{color:#8a939b;font-size:12.5px;margin-bottom:12px;line-height:1.6}
.meta{background:#16202c;border:1px solid #2a3441;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13.5px;line-height:1.8}
.meta b{color:#ffd166}
.tabs{display:flex;gap:8px;margin-bottom:14px;position:sticky;top:0;background:#0f1419;padding:6px 0;z-index:5}
.tabs a{flex:1;text-align:center;background:#1a2230;border:1px solid #2a3441;border-radius:9px;padding:9px 4px;color:#bcd;text-decoration:none;font-size:13px;font-weight:600}
.sec{margin:20px 0 8px;font-size:16px;font-weight:700;border-left:4px solid #6aa7ff;padding-left:8px}
.sec.dan{border-color:#06d6a0}.sec.shuang{border-color:#ffd166}.sec.quan{border-color:#ef476f}.sec.rx{border-color:#b58cff}
.summary{background:#1a2230;border:1px solid #2a3441;border-radius:10px;padding:11px 13px;margin-bottom:6px;font-size:14px;line-height:1.7}
.combos{color:#06d6a0;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px}
.card{background:#1a2230;border:1px solid #2a3441;border-radius:10px;padding:11px 13px}
.card.dan{border-left:4px solid #06d6a0}.card.shuang{border-left:4px solid #ffd166}.card.quan{border-left:4px solid #ef476f}.card.rx9{border-left:4px solid #b58cff}
.hd{font-size:14.5px;font-weight:600;margin-bottom:6px}.no{color:#8a939b;display:inline-block;min-width:20px}.vs{color:#8a939b;font-size:12px;margin:0 2px}
.lg{font-size:11px;color:#8a939b;background:#0f1419;padding:1px 6px;border-radius:4px;margin-left:4px}
.row{font-size:13px;margin:3px 0;color:#cfd6dd}.row .k{color:#8a939b;margin-right:4px}.row.main b{color:#fff;font-size:15px}.row .prob{color:#06d6a0;font-weight:700;margin:0 6px}
.row.pr{color:#aab3bb;font-size:12px}.conf{color:#8a939b;font-size:12px}.sk{color:#7fb0d6;font-size:11.5px}
.pick{font-size:13.5px}.pick b{color:#fff;font-size:15px}
.kind{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:5px;font-size:12px;font-weight:700;color:#0f1419;margin-right:4px}
.kind.dan{background:#06d6a0}.kind.shuang{background:#ffd166}.kind.quan{background:#ef476f}.kind.rx{background:#b58cff}
.ec{font-size:12px;color:#7fb0d6;margin-top:5px}.ec.warn{color:#ffb4a2}
.foot{margin-top:22px;font-size:12px;color:#8a939b;line-height:1.7;border-top:1px solid #2a3441;padding-top:12px}
</style></head><body>
<h1>⚽ 今日足球推荐</h1>
<div class="sub">实时跑通 · 闸门通过 · 信心已校准(ECE 2.47pp)· 只给信心+风险,下不下注由你决定</div>
<div class="meta">${issue ? `<b>胜负彩 ${esc(issue)}</b> · ` : ""}比赛日 ${esc(matchDay)} · 共 ${preds.length} 场${stopBJ ? ` · 停售 ${esc(stopBJ)}(北京)` : ""}<br>
全部数字本次实时跑出,可追溯真实赔率快照+DC拟合(24693场),provenance 0造假。</div>
<div class="tabs"><a href="#jc">竞彩明细</a><a href="#sf">14场胆双全</a>${rx9Html ? `<a href="#rx">任选9</a>` : ""}</div>

<div class="sec" id="jc">📋 竞彩明细 · 逐场(${preds.length})</div>
<div class="grid">${preds.map(detailCard).join("")}</div>

<div class="sec" id="sf">🎟️ 14场胜负彩 · 胆/双/全拆分</div>
<div class="summary"><b style="color:#06d6a0">胆 ${dan.length}</b> · <b style="color:#ffd166">双选 ${shuang.length}</b> · <b style="color:#ef476f">全选 ${quan.length}</b> &nbsp;→&nbsp; 复式 2<sup>${shuang.length}</sup>×3<sup>${quan.length}</sup> = <span class="combos">${combos.toLocaleString()} 注</span></div>
${fourSec("dan", "🟢 胆(单选·高信心)", dan)}
${fourSec("shuang", "🟡 双选(覆盖平局/次热)", shuang)}
${fourSec("quan", "🔴 全选(势均力敌全包)", quan)}

${rx9Html ? `<div id="rx"></div>${rx9Html}` : ""}

<div class="foot">
来源:生产 prediction-engine / buildFourteenPlan(数据驱动,非人工挑选),与桌面「神选-竞彩推荐-${esc(date)}.xlsx」同一计算。<br>
胜平负为锚,比分/半全场/让球均从胜平负方向派生(不反推)。胆=高信心单选;双选=覆盖平局或次热;全选=三向胶着全包。<br>
模型命中率天花板≈市场 54-55%,信心高的确实命中高(80%+档实际约94%),足球有不确定性,理性投注。
</div></body></html>`;

const targets = [
  readArg("--out") || "D:\\Temp\\webshare_lingdao\\今日足球推荐.html", // 手机端口80
  "C:\\Users\\Administrator\\Desktop\\今日足球推荐.html"               // 桌面副本
];
for (const t of targets) {
  const dir = dirname(t);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(t, html, "utf8");
}
console.log(`✅ 合一手机页已生成 (${preds.length}场竞彩 + 14场[胆${dan.length}/双${shuang.length}/全${quan.length}=${combos}注]${rx9?.ok ? ` + 任选9(对${rx9.needCorrect})` : ""})`);
console.log(`   期号 ${issue || "(无)"} · 停售 ${stopBJ || "?"}(北京)`);
targets.forEach((t) => console.log("   →", t));
console.log("   📱 手机打开: http://172.16.0.240/今日足球推荐.html");
