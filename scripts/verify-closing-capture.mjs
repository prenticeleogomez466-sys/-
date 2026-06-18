// 今晚收盘线自验:核 ClosingLineLive 是否真把 final 冻结进盘口数据。
//   判据(任一为真即"已开始写收盘线"):
//     1) 当前进窗(开赛前 windowMin..-10 分)的竞彩场存在 → 这些场应在下一轮 cron 后有 final;
//     2) market 快照里任一玩法 .final 非 null → 收盘线已落值(铁证)。
//   纯只读、不抓网、不改数据。用法:node scripts/verify-closing-capture.mjs [--date YYYY-MM-DD] [--window 20]
import { readFileSync, existsSync } from "node:fs";
import { loadFixtures } from "../src/fixture-store.js";
import { shanghaiDateOf, minutesToKickoff } from "../src/kickoff-time.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const windowMin = Number(arg("window", 20));
const dateArg = arg("date", null);
const bizDates = dateArg ? [dateArg] : [shanghaiDateOf(), shanghaiDateOf(Date.now(), -1)];
const nowMs = Date.now();
const shNow = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());

console.log(`[verify-closing-capture] 上海时间 ${shNow} · 窗口${windowMin}分 · 业务日 ${bizDates.join("+")}`);

// ① 当前进窗场次
const inWindow = [];
let totalJc = 0;
for (const d of bizDates) {
  for (const f of loadFixtures(d).fixtures.filter((f) => f.marketType === "jingcai")) {
    totalJc++;
    const t = minutesToKickoff(f, nowMs);
    if (t === null) continue;
    if (t <= windowMin && t >= -10) inWindow.push({ d, seq: f.sequence, t, m: `${f.homeTeam} vs ${f.awayTeam}`, ko: f.kickoff });
  }
}
console.log(`\n① 当前进窗(应被本轮/下轮 cron 冻结 final)的竞彩场:${inWindow.length}/${totalJc}`);
inWindow.forEach((w) => console.log(`   ${w.seq} ${w.m} | 开赛 ${w.ko} | 距开赛 ${w.t}分`));
if (!inWindow.length) {
  // 找最近一场,告知下一个窗口何时开
  let next = null;
  for (const d of bizDates) for (const f of loadFixtures(d).fixtures.filter((f) => f.marketType === "jingcai")) {
    const t = minutesToKickoff(f, nowMs); if (t === null || t < windowMin) continue;
    if (!next || t < next.t) next = { t, m: `${f.homeTeam} vs ${f.awayTeam}`, ko: f.kickoff };
  }
  if (next) console.log(`   暂无进窗场。最近一场 ${next.m} 开赛 ${next.ko}(距 ${next.t}分),窗口将在开赛前 ${windowMin}分开启。`);
}

// ② market 快照里 final 落值统计(铁证:收盘线已写)
let withFinal = 0, total = 0; const finalRows = [];
for (const d of bizDates) {
  const p = `D:/football-model-data/market/${d}.json`;
  if (!existsSync(p)) continue;
  let j; try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
  for (const s of j.snapshots || []) {
    total++;
    const f = (s.europeanOdds && s.europeanOdds.final) || (s.handicapOdds && s.handicapOdds.final) || (s.asianHandicap && s.asianHandicap.final);
    if (f) { withFinal++; finalRows.push(`${d}#${s.sequence} ${s.homeTeam} vs ${s.awayTeam}`); }
  }
}
console.log(`\n② market 快照已冻结 final 的场:${withFinal}/${total}`);
finalRows.slice(0, 20).forEach((r) => console.log(`   ✅ ${r}`));

// ③ 捕获健康状态文件
const statePath = "D:/football-model-data/closing-capture-state.json";
if (existsSync(statePath)) {
  try {
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    console.log(`\n③ 捕获健康状态:${JSON.stringify(st)}`);
  } catch { console.log(`\n③ 捕获健康状态文件无法解析(${statePath})`); }
} else console.log(`\n③ 捕获健康状态文件尚未生成(${statePath})`);

// 裁决
console.log("\n=== 裁决 ===");
if (withFinal > 0) console.log(`🟢 收盘线采集已生效:${withFinal} 场已冻结真 final。CLV 可对真收盘打分。`);
else if (inWindow.length > 0) console.log(`🟡 ${inWindow.length} 场已进窗但 final 未落值——等下一轮 cron(每15分)冻结后复查;若连跑2轮仍 0 = 需排查抓盘/方向投票。`);
else console.log(`⏳ 当前无场进窗,final 仍为空属正常。等最早一场临近开赛(见①最近一场)再复查。`);
