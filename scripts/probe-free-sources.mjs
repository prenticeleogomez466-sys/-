#!/usr/bin/env node
import { probeFreeSources } from "../src/free-source-probe.js";

console.log("探测全球免授权足球数据源(实测能否免 key 抓 + 是否真有内容)...\n");
const res = await probeFreeSources();
const icon = { usable: "✅", empty: "⚪", blocked: "🚫", error: "❌" };
console.log("源                              信号                状态     说明");
for (const r of res.results) {
  console.log(`${r.name.padEnd(30)} ${r.signal.padEnd(18)} ${icon[r.status] || "?"}${r.status.padEnd(7)} ${r.detail}`);
}
console.log(`\n可用源:${res.usableCount}/${res.results.length}`);
console.log("说明:✅可用 ⚪空(在线但无数据,可能休赛期) 🚫被反爬 ❌错误。伤停目前只有 FPL(英超)可用。");
