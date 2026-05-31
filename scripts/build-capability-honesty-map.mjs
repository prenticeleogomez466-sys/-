// 模型能力诚实地图(过夜轮12)——把整夜回测验证整合成用户可读的一张 xlsx,
//   诚实标注每项「模型能/不能」+ 回测来源(脚本/样本/日期),不夸大不造假。
// 产物:D:\football-model-exports\模型能力诚实地图.xlsx(+ 桌面副本)。
// 用法:node scripts/build-capability-honesty-map.mjs
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { getExportDir } from "../src/paths.js";

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

// ── Sheet1:能力裁决(数据来自整夜 leak-safe 回测,git 记录,带 provenance)──
const capRows = [
  ["玩法 / 能力", "模型表现", "对照(市场/naive 基线)", "裁决", "回测来源(脚本 · 样本 · 日期)"],
  ["胜负平 1X2(vs 市场)", "≈ 跟随市场", "收盘线 54-55% 已含全部公开信息", "❌ 无独立 edge(市场跟随器)", "signal-crossval / clv 闭环 · 9363+场 · 2026-05-31"],
  ["大小球 O/U 2.5(vs 市场)", "57.0% / Brier 0.2459", "市场收盘 59.0% / 0.2382", "❌ 无 edge(分歧下注 -0.6~-1.5pp)", "run-overunder-vs-market-backtest · 8267场 · 2026-06-01"],
  ["诱盘判定(模型 vs 市场分歧)", "诱盘嫌疑桶热门实际 58.6%", "收盘隐含 55.6%(热门反跑赢)", "❌ 无 edge(市场更准,仅诊断)", "run-trap-verdict-backtest · 8266场 · 2026-06-01"],
  ["爆冷风险 / 盘口移动", "加注热门 55.5% vs 退烧 52.7%", "5年实证同向(+2.8pp)", "🟡 弱方向信号(透明读数,不押注)", "run-upset-trap-backtest · 8906场 · 2026-05-31"],
  ["比分 top-1", "12.4%", "naive 1-1 = 12.1%", "🟡 微胜 naive(1-1 物理众数,价值在分布)", "run-score-halffull-quality-backtest · 8267场 · 2026-06-01"],
  ["比分 top-3", "32.9%", "—", "✅ 有区分度(逐联赛贴合进球画像)", "同上"],
  ["半全场 HT/FT", "31.4%", "naive 主胜-主胜 26.3%", "✅ 真价值(+5.1pp,落诚实区间 28-35%)", "同上"],
  ["信心校准(confidence)", "低36%<中50%<高53%<极高64%", "单调 → 信心可信", "✅ 校准良好(高信心确实高命中)", "model-memory(ledger 174 结算场)· 2026-06-01"],
  ["CLV(击败收盘线)", "平均 -1.4~-2.8%、击败 45-50%", "0% = 市场对自己无 edge", "❌ 无正 CLV(下注价偏差)", "clv 闭环 A实时+B回填 · 2026-05-31"],
];

// ── Sheet2:模型自知(读 model-memory.json 真实战绩)──
const memPath = join(getExportDir(), "model-memory.json");
const selfRows = [["分段", "维度", "胜平负命中", "样本 n", "比分命中", "半全场命中(注:ledger HT 盲区,真值见质量回测)"]];
if (existsSync(memPath)) {
  const m = JSON.parse(readFileSync(memPath, "utf8"));
  const g = m.global;
  selfRows.push(["总体", `已结算 ${m.settledTotal} 场`, pct(g.wldHit), g.wldN, pct(g.scoreHit), `${pct(g.halfFullHit)}(n=${g.halfFullN})`]);
  for (const [b, v] of Object.entries(m.byConfidenceBand ?? {})) selfRows.push(["信心带", b, pct(v.wldHit), v.n, pct(v.scoreHit), pct(v.halfFullHit)]);
  for (const [t, v] of Object.entries(m.byFavoriteTier ?? {})) selfRows.push(["热门档", t, pct(v.wldHit), v.n, pct(v.scoreHit), pct(v.halfFullHit)]);
  const lgs = Object.entries(m.byLeague ?? {}).filter(([, v]) => v.n >= 6).sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  for (const [lg, v] of lgs) selfRows.push(["联赛", lg, pct(v.wldHit), v.n, pct(v.scoreHit), pct(v.halfFullHit)]);
} else {
  selfRows.push(["—", "无 model-memory(先跑 build-model-memory)", "—", 0, "—", "—"]);
}

// ── Sheet3:结论与醒后建议 ──
const concRows = [
  ["主题", "诚实结论 / 建议"],
  ["核心定位", "模型 = 诚实校准的赛前概率器 + 全玩法覆盖器,非'打败市场'机器。1X2/O/U/CLV 均无独立 edge(市场高效)。"],
  ["真正有价值处", "① 信心校准(高信心真高命中);② 半全场(+5.1pp 胜 naive);③ 比分分布/top-3;④ 全玩法覆盖竞彩定价;⑤ 模型自知(分段历史命中)。"],
  ["无 edge 处(别误用)", "① 逆市场选独门(分歧时市场更准);② 诱盘判定(无套利,仅诊断);③ 大小球跟模型下注;④ 公开盘口移动押注。"],
  ["唯一现实增益方向", "速度(赶开盘价收敛前)+ 市场未定价的实时私有信息(伤停/阵容晚到)。公开免费数据已被收盘线充分编码。"],
  ["醒后建议", "① 交互 session 抓今日竞彩出正式推荐;② 修 recap 半全场结算(回填 HT 比分,解 ledger 盲区);③ model-memory build 接进 recap 自动刷新。"],
];

const outDir = getExportDir();
const outPath = join(outDir, "模型能力诚实地图.xlsx");
writeXlsxWorkbook(outPath, [
  { name: "能力裁决", rows: capRows },
  { name: "模型自知", rows: selfRows },
  { name: "结论与建议", rows: concRows },
]);
console.log(`已生成 ${outPath}`);
try {
  const desk = "C:\\Users\\Administrator\\Desktop\\模型能力诚实地图.xlsx";
  copyFileSync(outPath, desk);
  console.log(`桌面副本 ${desk}`);
} catch (e) { console.log("桌面副本跳过:", e.message); }
console.log(`能力裁决 ${capRows.length - 1} 行 · 自知 ${selfRows.length - 1} 行 · 结论 ${concRows.length - 1} 行`);
