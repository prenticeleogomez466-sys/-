#!/usr/bin/env node
/**
 * 组合触发器引擎 端到端验证 + 逐场演示(2026-06-22)。
 * 数据=386张截图(独立外部集:组合规律是从12458场football-data挖的,这里是没参与训练的真竞彩场)。
 * 验证:触发某预测的场,实际命中多少?(证明引擎在没见过的数据上真有效,不是自说自话)
 */
import fs from "node:fs";
import { comboTriggers } from "../src/combo-triggers.js";
const ss = JSON.parse(fs.readFileSync("D:/football-model-data/screenshots-ocr/all.json", "utf8")).filter((x) => x.finished && Array.isArray(x.ft) && x.crow_eu_close);
const pc = (x) => (x * 100).toFixed(0) + "%";

function toMatch(x) {
  const c = x.crow_eu_close, o = x.crow_eu_open;
  if (!Array.isArray(c) || !c.every((v) => v > 1)) return null;
  return {
    euClose: { home: c[0], draw: c[1], away: c[2] },
    euOpen: Array.isArray(o) && o.every((v) => v > 1) ? { home: o[0], draw: o[1], away: o[2] } : null,
    ahLineClose: x.crow_ah_close ? x.crow_ah_close[1] : null,
    ahLineOpen: x.crow_ah_open ? x.crow_ah_open[1] : null,
  };
}
function actual(x) { const [h, a] = x.ft; return { res: h > a ? "主胜" : h < a ? "客胜" : "平局", over: h + a > 2.5, goals: h + a }; }
function hit(predict, act, feat) {
  if (predict === "主胜") return act.res === "主胜";
  if (predict === "客胜") return act.res === "客胜";
  if (predict.includes("平局")) return act.res === "平局";
  if (predict === "大球") return act.over;
  if (predict === "小球") return !act.over;
  if (predict.includes("命中骤降") || predict.includes("别当胆")) return feat.favHome ? act.res !== "主胜" : act.res !== "客胜"; // 退烧:热门不胜=提醒正确
  if (predict.includes("可靠")) return feat.favHome ? act.res === "主胜" : act.res === "客胜";
  return null;
}

// ===== 引擎验证:按规则聚合命中 =====
const agg = {};
let fired = 0;
const rows = ss.map((x) => { const m = toMatch(x); if (!m) return null; const r = comboTriggers(m); if (!r) return null; return { x, m, r, act: actual(x) }; }).filter(Boolean);
for (const { r, act } of rows) {
  if (r.triggers.length) fired++;
  for (const t of r.triggers) {
    const h = hit(t.predict, act, r.features);
    if (h === null) continue;
    (agg[t.id] ||= { id: t.id, predict: t.predict, tier: t.tier, claimTr: t.hitRate.tr, claimTe: t.hitRate.te, n: 0, k: 0 });
    agg[t.id].n++; if (h) agg[t.id].k++;
  }
}
console.log("████ 组合触发器引擎·端到端验证(386张独立真竞彩截图) ████");
console.log(`触发≥1条规律的场: ${fired}/${rows.length} (${pc(fired / rows.length)})\n`);
console.log("规则                          预测        信心  截图命中(N)   vs回测命中(tr/te)");
for (const a of Object.values(agg).sort((x, y) => (y.k / y.n) - (x.k / x.n))) {
  const ok = a.n >= 8 ? (a.k / a.n >= a.claimTe - 0.12 ? "✅符合" : "🔶偏低") : "⚠️样本小";
  console.log(`${a.id.padEnd(28)} ${a.predict.slice(0, 8).padEnd(10)} ${a.tier.padEnd(4)} ${pc(a.k / a.n)}(${String(a.n).padStart(3)})   ${pc(a.claimTr)}/${pc(a.claimTe)}  ${ok}`);
}

// ===== 逐场演示:挑8场触发了高/中信心的 =====
console.log("\n████ 逐场触发演示(挑触发高/中信心规律的场) ████");
let shown = 0;
for (const { x, r, act } of rows) {
  const strong = r.triggers.filter((t) => t.tier === "高" || t.tier === "中");
  if (!strong.length || shown >= 8) continue;
  shown++;
  console.log(`\n【${x.league || "?"}】${x.home} vs ${x.away}  实际:${x.ft[0]}-${x.ft[1]}(${act.res}/${act.over ? "大球" : "小球"})`);
  for (const t of r.triggers) console.log(`   ${t.tier === "高" ? "🟢" : t.tier === "中" ? "🟡" : t.tier === "提醒" ? "⚠️" : "·"} [${t.market}] ${t.predict} ← ${t.why}  (历史命中${pc(t.hitRate.te)})`);
}
console.log("\n口径:截图为独立外部集(组合从football-data挖);'✅符合'=截图命中≥回测命中-12pp,证明引擎可迁移。高命中≠盈利。");
