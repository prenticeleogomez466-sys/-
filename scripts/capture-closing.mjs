// A: 收盘线冻结器 (capture-closing)
// ──────────────────────────────────────────────────────────────────────────
// 实时CLV 的卡点是 market 快照 final(收盘)永远 null。免费方案: 既有爬虫一直在更新
// europeanOdds.current / asianHandicap.current; 本 runner 在比赛结束后把"最后一次 current"
// 冻结成 final(收盘) —— 不抓任何新数据、零成本, current 即临场最新价≈收盘价。
//
// 用法:
//   node scripts/capture-closing.mjs                # 冻结"昨天"(上海时区)的收盘
//   node scripts/capture-closing.mjs 2026-05-30     # 指定日期
//   node scripts/capture-closing.mjs --range 7      # 回填最近7天所有缺 final 的
// 建议挂计划任务每天 06:00 跑(冻结前一日)。

import { loadMarketSnapshots, saveMarketSnapshots } from "../src/market-data-store.js";
import { shanghaiDateOf } from "../src/kickoff-time.js";

// 时区根修(缺陷#9 姊妹脚本补刀,2026-06-10):旧手算式 `(8*60 - getTimezoneOffset())*60000`
// 在本机 UTC+8 下双重 +8h(实际 +16h),本地 16:00 后运行会把"昨天/今天"算成 +1 天,
// 冻结错业务日的 final;统一改走 src/kickoff-time.js 的 shanghaiDateOf(机器时区无关)。
function shanghaiDate(offsetDays = 0) {
  return shanghaiDateOf(Date.now(), offsetDays);
}

function freezeOne(snap) {
  let changed = 0;
  for (const book of ["europeanOdds", "asianHandicap", "jingcaiHandicap", "handicapOdds"]) {
    const b = snap[book];
    if (b && b.current && !b.final) { b.final = JSON.parse(JSON.stringify(b.current)); changed++; }
  }
  if (changed) snap.closingCapturedAt = new Date().toISOString();
  return changed;
}

function processDate(date) {
  const set = loadMarketSnapshots(date);
  if (!set.snapshots.length) return { date, total: 0, frozen: 0 };
  let frozen = 0, fixturesTouched = 0;
  for (const s of set.snapshots) { const c = freezeOne(s); if (c) { frozen += c; fixturesTouched++; } }
  if (fixturesTouched) saveMarketSnapshots(date, set.snapshots, { source: `${set.source}+closing-frozen` });
  return { date, total: set.snapshots.length, frozen: fixturesTouched };
}

const args = process.argv.slice(2);
let dates = [];
if (args[0] === "--range") {
  const n = parseInt(args[1] || "7", 10);
  for (let i = 1; i <= n; i++) dates.push(shanghaiDate(-i));
} else if (args[0]) {
  dates = [args[0]];
} else {
  dates = [shanghaiDate(-1)];   // 默认昨天
}

console.log(`[capture-closing] 冻结收盘线(current→final), 日期: ${dates.join(", ")}`);
let totalFrozen = 0;
for (const d of dates) {
  const r = processDate(d);
  console.log(`  ${r.date}: ${r.total} 场, 冻结收盘 ${r.frozen} 场`);
  totalFrozen += r.frozen;
}
console.log(`完成, 共冻结 ${totalFrozen} 场收盘价。以后实时CLV可对这些 final 打分。`);
