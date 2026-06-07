// 验证"半全场降智修复"(2026-06-07 用户):原 primary 锚成"全场方向复制"(主胜恒主胜-主胜),
// 改为"终场=wld 约束下 hfDist 真实最高概率路径"。本脚本对典型 λ 场景对比修复前后,证明逐场差异化。
import { halfFullJoint } from "../src/halftime-fulltime-model.js";
import { ensembleHalfFull } from "../src/ensemble-halffull.js";

const hf = (lh, la, lg) => ensembleHalfFull(lh, la, lg) ?? halfFullJoint(lh, la);
const finalOf = (wld) => ({ "3": "主胜", "1": "平局", "0": "客胜" }[wld]);

const scenarios = [
  ["强队碾压主胜", "3", 2.4, 0.6],
  ["低进球均势主胜", "3", 1.35, 1.0],
  ["接近主胜", "3", 1.55, 1.25],
  ["普通主胜", "3", 1.8, 1.05],
  ["小胜慢热", "3", 1.3, 1.1],
  ["客胜碾压", "0", 0.6, 2.2],
  ["弱客胜", "0", 1.1, 1.5],
];

console.log("场景               λ主  λ客   修复前(机械)    修复后(真实最高路径)         前3真实路径");
for (const [desc, wld, lh, la] of scenarios) {
  const d = hf(lh, la, null);
  const finalCh = finalOf(wld);
  const onDir = Object.entries(d).filter(([k]) => String(k).split("-")[1]?.trim() === finalCh).sort((a, b) => b[1] - a[1]);
  const oldP = `${finalCh}-${finalCh}`;
  const newP = onDir[0] ? `${onDir[0][0]}(${(onDir[0][1] * 100).toFixed(0)}%)` : "—";
  const top3 = onDir.slice(0, 3).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" / ");
  const changed = onDir[0] && onDir[0][0] !== oldP ? "✅差异化" : "—同";
  console.log(`${desc.padEnd(16)} ${lh}  ${la}   ${oldP.padEnd(12)} ${newP.padEnd(16)} ${changed}  [${top3}]`);
}
console.log("\n读法:修复前不管什么场都是'主胜-主胜/客胜-客胜';修复后终场仍=胜负平方向(四列同向),");
console.log("     但上半场按真实 λ 走:碾压=快攻领先、均势低进球='平局-主胜'慢热反超。逐场不再千篇一律。");
