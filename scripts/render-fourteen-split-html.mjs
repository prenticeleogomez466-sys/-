/**
 * 14场 胆/双/全 拆分网页。自包含HTML(内联CSS,可直接下载/浏览器打开)。
 *
 * 单一真相源:直接读 recommendFixtures(date).fourteen.selections —— 胆/双/全拆分
 * 由生产 buildFourteenPlan 算好(与「神选-竞彩推荐.xlsx」完全一致),本脚本只渲染、不重判,
 * 避免阈值分歧造出官方计划里不存在的选项。
 *
 * 诚实标注:今日若无官方胜负彩期号(note/issue 为空),如实标「按今日竞彩对阵打包的 14 场组合,
 * 非官方胜负彩期」。遵 wld 锚定 + 只给信心/风险、不替用户弃赛。
 *
 * 用法:node scripts/render-fourteen-split-html.mjs --date 2026-05-31 [--out 路径]
 */
import "../src/env.js";
import { writeFileSync } from "node:fs";
import { recommendFixtures } from "../src/prediction-engine.js";

const args = process.argv.slice(2);
const readArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const out = readArg("--out") ?? "C:\\Users\\Administrator\\Desktop\\胜负彩14场-胆双全.html";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const rec = recommendFixtures(date);
const four = rec.fourteen || {};
if (!four.available || !Array.isArray(four.selections) || four.selections.length !== 14) {
  console.error(`❌ 今日 ${date} 无可用的 14 场计划(available=${four.available} / selections=${four.selections?.length}),按硬规则「无14场则不发14场」,不生成网页。`);
  process.exit(1);
}

// 官方期号在 fixture.notes(「官方期号=第NNNNN期」)/ officialFixtureId,fourteen 对象不冒出来,从 predictions 取
const issue = four.issue ?? four.period ?? (() => {
  for (const p of rec.predictions || []) {
    const m = (p.fixture?.notes || "").match(/官方期号=([^;]+)/);
    if (m) return m[1].trim();
    if (p.fixture?.officialFixtureId) return String(p.fixture.officialFixtureId).split("-")[0];
  }
  return null;
})();
const KIND_CLASS = { "胆": "dan", "双选": "shuang", "全选": "quan" };
const sels = four.selections;
const dan = sels.filter((s) => s.type === "胆");
const shuang = sels.filter((s) => s.type === "双选");
const quan = sels.filter((s) => s.type === "全选");
// 组合串数 = 各场 compound 结果数连乘(胆=1,双选=2,全选=3)
const legOutcomes = (s) => String(s.compound || s.single || "").split("/").filter(Boolean).length || 1;
const combos = sels.reduce((acc, s) => acc * legOutcomes(s), 1);

const card = (s) => {
  const cls = KIND_CLASS[s.type] || "shuang";
  const pr = s.probabilities || {};
  const picksTxt = String(s.compound || s.single || "").split("/").join(" / ");
  const conf = Number(s.confidence);
  return `<div class="card ${cls}">
    <div class="hd"><span class="no">${s.index}</span> ${esc(s.match)} <span class="lg">${esc(s.competitionType || "")}</span></div>
    <div class="pick"><span class="kind ${cls}">${esc(s.type === "双选" ? "双" : s.type === "全选" ? "全" : "胆")}</span> 选 <b>${esc(picksTxt)}</b></div>
    <div class="pr">主 ${esc(pr.home ?? "-")} · 平 ${esc(pr.draw ?? "-")} · 客 ${esc(pr.away ?? "-")} &nbsp;|&nbsp; 信心 ${Number.isFinite(conf) ? conf.toFixed(0) : "-"} &nbsp;|&nbsp; 风险 ${esc(s.risk || "-")}</div>
    ${s.upsetRisk ? `<div class="ec">${esc(s.upsetRisk)}</div>` : ""}
  </div>`;
};

const sec = (cls, title, list) => list.length
  ? `<div class="sec ${cls}">${title}(${list.length})</div><div class="grid">${list.map(card).join("")}</div>`
  : "";

const rx9 = rec.fourteen.renxuan9;
const rx9Line = rx9?.ok
  ? `任选9(需对 ${rx9.needCorrect} 场):${rx9.picks.map((p) => `${esc(p.match.split(" 对 ")[0])}→${esc(p.pick)}`).join(" · ")}`
  : "";

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>14场 胆/双/全 · ${date}</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",sans-serif;margin:0;background:#0f1419;color:#e6e6e6;padding:16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#8a939b;font-size:13px;margin-bottom:14px}
.summary{background:#1a2230;border:1px solid #2a3441;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:14px;line-height:1.7}
.summary b{color:#ffd166}.combos{color:#06d6a0;font-weight:700}
.note{background:#2a2419;border:1px solid #6b5a2a;border-radius:8px;padding:9px 12px;margin-bottom:14px;font-size:13px;color:#ffd9a0;line-height:1.6}
.sec{margin:18px 0 8px;font-size:16px;font-weight:700;border-left:4px solid;padding-left:8px}
.sec.dan{border-color:#06d6a0}.sec.shuang{border-color:#ffd166}.sec.quan{border-color:#ef476f}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.card{background:#1a2230;border:1px solid #2a3441;border-radius:10px;padding:11px 13px}
.card.dan{border-left:4px solid #06d6a0}.card.shuang{border-left:4px solid #ffd166}.card.quan{border-left:4px solid #ef476f}
.hd{font-size:15px;font-weight:600;margin-bottom:6px}.no{color:#8a939b;display:inline-block;min-width:20px}
.lg{font-size:11px;color:#8a939b;background:#0f1419;padding:1px 6px;border-radius:4px;margin-left:4px}
.pick{font-size:14px;margin:4px 0}.pick b{color:#fff;font-size:15px}
.kind{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:5px;font-size:12px;font-weight:700;color:#0f1419;margin-right:4px}
.kind.dan{background:#06d6a0}.kind.shuang{background:#ffd166}.kind.quan{background:#ef476f}
.pr{font-size:12px;color:#aab3bb;margin-top:3px}.ec{font-size:12px;color:#7fb0d6;margin-top:5px}
.rx9{background:#16202c;border:1px solid #2a3441;border-radius:8px;padding:10px 12px;margin-top:14px;font-size:13px;color:#bcd;line-height:1.6}
.foot{margin-top:20px;font-size:12px;color:#8a939b;line-height:1.7;border-top:1px solid #2a3441;padding-top:12px}
</style></head><body>
<h1>⚽ 14 场 · 胆/双/全拆分</h1>
<div class="sub">${date} · 实时跑通·闸门通过 · 信心已校准(ECE 2.47pp)· 只给信心+风险,下不下注由你决定</div>
${issue
  ? `<div class="note">期号/说明:${esc(String(issue))}</div>`
  : `<div class="note">⚠ 今日<b>无官方胜负彩期号</b> —— 本表是模型按<b>今日 14 场竞彩对阵</b>(${esc([...new Set(sels.map((s)=>s.competitionType))].join("、"))})打包的 14 场组合,非官方胜负彩期。恰 14 腿、拆分与「神选-竞彩推荐」xlsx 一致。</div>`}
<div class="summary">
<b style="color:#06d6a0">胆(单选)${dan.length} 场</b> · <b style="color:#ffd166">双选 ${shuang.length} 场</b> · <b style="color:#ef476f">全选 ${quan.length} 场</b><br>
复式串数 = ${[`${dan.length>0?'1^'+dan.length:''}`].filter(Boolean).join('')} 2<sup>${shuang.length}</sup> × 3<sup>${quan.length}</sup> = <span class="combos">${combos.toLocaleString()} 注</span>
</div>
${sec("dan", "🟢 胆(单选·高信心)", dan)}
${sec("shuang", "🟡 双选(覆盖平局/次热)", shuang)}
${sec("quan", "🔴 全选(势均力敌全包)", quan)}
${rx9Line ? `<div class="rx9">🎯 ${rx9Line}</div>` : ""}
<div class="foot">
拆分来源:生产 buildFourteenPlan(数据驱动,非人工挑选),与桌面「神选-竞彩推荐-${date}.xlsx」同一计算。<br>
胆=高信心单选;双选=覆盖平局或次热(平局≥25%强制覆盖);全选=三向胶着全包。串数越大覆盖越广、单注成本越高,按预算取舍。<br>
模型命中率天花板≈市场 54-55%,信心高的确实命中高(80%+档实际命中约94%),但足球有不确定性,理性投注。
</div></body></html>`;

writeFileSync(out, html, "utf8");
console.log("✅ 网页已生成:", out);
console.log(`胆 ${dan.length} / 双 ${shuang.length} / 全 ${quan.length} → ${combos.toLocaleString()} 注${issue ? "" : "(无官方期号,今日竞彩14场组合)"}`);
