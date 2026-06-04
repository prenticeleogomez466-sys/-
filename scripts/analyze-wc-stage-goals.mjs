/**
 * 世界杯分阶段进球率实证(leak-safe 描述统计,用于检验 tournament-simulator 的 phaseIntensity)。
 * 数据:data/intl-results/results.csv(martj42,Public Domain)。
 * 无阶段列 → 用现代32队赛制(1998-2022,每届固定 64 场=48组+16淘汰)按届内日期顺序切分:
 *   前 48 场=小组赛,后 16 场=淘汰赛(R16/QF/SF/3rd/Final)。
 * 输出:各阶段场均总进球、平局率(90分钟记录口径),与模型 base 2.6 对比,推导经验 intensity。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csv = fs.readFileSync(path.join(__dirname, "..", "data", "intl-results", "results.csv"), "utf8");
const lines = csv.trim().split(/\r?\n/);
const rows = lines.slice(1).map((l) => {
  // 简单 CSV(无字段内逗号转义需求,城市名可能有逗号 → 用前6列+末3列稳取)
  const p = l.split(",");
  return { date: p[0], home: p[1], away: p[2], hs: +p[3], as: +p[4], tournament: p[5], neutral: p[p.length - 1] };
});

const wc = rows.filter((r) => r.tournament === "FIFA World Cup" && Number.isFinite(r.hs) && Number.isFinite(r.as));
// 按年份分组
const byYear = {};
for (const r of wc) {
  const y = r.date.slice(0, 4);
  (byYear[y] ||= []).push(r);
}

const MODERN = ["1998", "2002", "2006", "2010", "2014", "2018", "2022"]; // 32队/64场固定赛制
const stats = (arr) => {
  const n = arr.length;
  const goals = arr.reduce((s, r) => s + r.hs + r.as, 0);
  const draws = arr.filter((r) => r.hs === r.as).length;
  return { n, gpg: goals / n, drawRate: draws / n };
};

const group = [], ko = [];
for (const y of MODERN) {
  const ms = (byYear[y] || []).sort((a, b) => a.date.localeCompare(b.date));
  if (ms.length !== 64) { console.log(`⚠️ ${y} 场次=${ms.length}(非64,跳过该届切分)`); continue; }
  group.push(...ms.slice(0, 48));
  ko.push(...ms.slice(48));
}

const g = stats(group), k = stats(ko);
console.log("=== 世界杯分阶段进球实证(1998-2022,32队×7届)===");
console.log(`小组赛  : n=${g.n}  场均总进球=${g.gpg.toFixed(3)}  平局率=${(g.drawRate * 100).toFixed(1)}%`);
console.log(`淘汰赛  : n=${k.n}  场均总进球=${k.gpg.toFixed(3)}  平局率(90' 记录口径)=${(k.drawRate * 100).toFixed(1)}%`);
console.log(`全部    : n=${g.n + k.n}  场均总进球=${stats([...group, ...ko]).gpg.toFixed(3)}`);
console.log("");
console.log(`模型 base lambdaTotal=2.6,groupIntensity=1 → 期望小组 2.600 球`);
console.log(`经验 intensity(相对小组赛):小组=1.000  淘汰=${(k.gpg / g.gpg).toFixed(3)}`);
console.log(`经验 intensity(相对模型base 2.6):小组=${(g.gpg / 2.6).toFixed(3)}  淘汰=${(k.gpg / 2.6).toFixed(3)}`);
console.log("");
console.log("当前模型 phaseIntensity(写死): r32~1.18 r16 1.20 qf 1.25 sf/final 1.28");
console.log("→ 若经验淘汰 intensity < 小组,则当前设定方向相反,淘汰赛进球被高估、点球大战被低估。");
