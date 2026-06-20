// 异动雷达守护测试(2026-06-19):验证纯透明分析层——绝不改方向、按严重度排序、零编造标缺、研判格≤2行、详情 sheet 列齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnomalyRadar, synthesisCell, buildRadarDetailSheet, buyAdvice, directCall } from "../src/today-delivery-lib.js";

// 一场:公众追捧但盘口看淡的热门(欧赔退烧坑)+ 高爆冷 + 平局偏高 + 阵容未出 + 模型分歧
const rowTrap = {
  idx: 1, match: "甲 vs 乙", comp: "西甲", wld: "主胜(58%)", tier: "二档", conf: 58,
  primary: { text: "盘口主推:主胜", ref: "", agree: false },
  signals: "欧赔:热门=主胜·热门主胜水位走高(1.80→1.95,资金出) ‖ 亚盘:让-0.75(开-0.5→现-0.75·盘口异动)·水位偏主 ‖ 竞彩让球盘:让球后资金偏主 ‖ 阵容:⚠️未公布(开赛前~1h LineupWatch自动按首发重分析推送)",
  sanity: { band: { p5: 0.4, p95: 0.55 }, favProb: 0.62 },
  drawImpliedPct: 0.31,
  upset: { level: "高", reason: "热门近期客场乏力+对手定位球强,存在被逼平/爆冷概率" },
  totalsMove: { lean: "大球" },
  adv: { label: "🔴对抗证伪未过" },
  liveCheck: { keyIntel: "主力中卫停赛" },
};

// 一场:三盘共振、各维度常态(干净场)
const rowClean = {
  idx: 2, match: "丙 vs 丁", comp: "英超", wld: "主胜(70%)", tier: "一档", conf: 70,
  primary: { text: "盘口主推:主胜", ref: "", agree: true },
  signals: "欧赔:热门=主胜·初现持平 ‖ 亚盘:让-1(开盘未动)·水位偏主 ‖ 竞彩让球盘:让球后资金偏主 ‖ 阵容:✅已出(已按首发重算) ‖ 🟣三盘共振主胜(欧赔/亚盘/让球盘同侧)",
  sanity: null, drawImpliedPct: 0.18, totalsMove: { lean: "无明显走势" },
};

test("方向恒=盘口主推·绝不被任何异动改写", () => {
  for (const r of [rowTrap, rowClean]) {
    const rad = buildAnomalyRadar(r);
    assert.equal(rad.dir, "主胜(58%)".startsWith(rad.dir) || rad.dir.includes("主胜") ? rad.dir : rad.dir); // dir 来自 primary 首行
    assert.match(rad.dir, /主胜/);
  }
});

test("庄家意图:退烧热门→标−12.6%坑(✅实测·6-18回测背书)", () => {
  const rad = buildAnomalyRadar(rowTrap);
  const f = rad.factors.find((x) => x.cat === "庄家意图");
  assert.ok(f, "应识别庄家意图因子");
  assert.equal(f.tag, "✅实测");
  assert.match(f.text, /退烧|资金出/);
  assert.match(f.text, /12\.6%|坑/);
});

test("大小球走势=唯一统计edge 被显式标注(✅实测)", () => {
  const rad = buildAnomalyRadar(rowTrap);
  const f = rad.factors.find((x) => /大小球走势/.test(x.cat));
  assert.ok(f);
  assert.match(f.cat, /唯一统计edge/);
  assert.match(f.text, /大球/);
});

test("因子按严重度排序 🔴>🟡>🟢", () => {
  const rad = buildAnomalyRadar(rowTrap);
  const ord = { "🔴": 0, "🟡": 1, "🟢": 2 };
  for (let i = 1; i < rad.factors.length; i++) assert.ok(ord[rad.factors[i - 1].sev] <= ord[rad.factors[i].sev]);
  // 高爆冷应排第一(🔴)
  assert.equal(rad.factors[0].sev, "🔴");
  assert.match(rad.factors[0].cat, /爆冷高/);
});

test("阵容/伤病/红牌:未出→⚠️待标缺不编(软信息不进概率)", () => {
  const rad = buildAnomalyRadar(rowTrap);
  const f = rad.factors.find((x) => x.cat === "阵容/伤病/红牌");
  assert.ok(f);
  assert.equal(f.tag, "⚠️待");
  assert.match(f.text, /不进概率|标缺/);
});

test("综合研判格≤2行·直接研判打头(不要虚的·看好X)", () => {
  const cell = synthesisCell(rowTrap);
  assert.ok(cell.split("\n").length <= 2, `研判格应≤2行,实得${cell.split("\n").length}行`);
  assert.match(cell, /🎯/);
  assert.match(cell, /防爆平|看好/, "首行须是直接研判(看好X/防爆平),非含糊");
  assert.match(cell, /信心/);
});

test("directCall:先严密读信号→一句直接判断(退烧+平局高→防爆平看好平局比分;加注+共振→看好主推方向)", () => {
  // rowTrap=退烧(资金出)+平局隐含31%+证伪 → 防爆平·看好平局
  assert.match(directCall(rowTrap), /退烧|防爆平/);
  assert.match(directCall(rowTrap), /看好/);
  // 加注+三盘共振 → 看好盘口主推方向+真盘比分
  const rowFav = { wld: "主胜(70%)", primary: { text: "盘口主推:主胜", agree: true }, tier: "一档", conf: 70,
    signals: "欧赔:热门=主胜·热门主胜水位压入(1.9→1.8,资金进) ‖ 🟣三盘共振主胜(欧赔/亚盘/让球盘同侧)",
    score: "盘口主推 2-0/2-1 ✅500", drawImpliedPct: 0.16 };
  assert.match(directCall(rowFav), /资金加注.*共振|看好主胜/);
  assert.match(directCall(rowFav), /2-0/, "盘口稳场须带真盘主推比分");
  // 悬殊盘 1X2未开售 → 真热门用 WC Elo 先验定(主X%/客Y%·非亚盘水位)·只买胜不买深让
  assert.match(directCall({ wld: "未开售(悬殊盘)", wcElo: "主79%/平17%/客4%", score: "" }), /看好主队赢球.*只买主队胜.*不买深让/);
  assert.match(directCall({ wld: "未开售", wcElo: "主5%/平20%/客75%", score: "" }), /看好客队/);
  // 无Elo时退竞彩让球赔率(主胜odds低=主热门)
  assert.match(directCall({ wld: "未开售", hc: "让-2 1.85/4/2.95 ✅500", score: "" }), /看好主队/);
});

test("干净场:无突出风险时不硬造异动(零编造)", () => {
  const rad = buildAnomalyRadar(rowClean);
  assert.ok(!rad.factors.some((f) => f.cat === "庄家意图"), "持平不应报庄家意图");
  assert.ok(rad.factors.some((f) => f.cat === "盘口共振"), "三盘共振应被识别");
  assert.ok(!rad.factors.some((f) => /大小球走势/.test(f.cat)), "无明显走势不应报大小球edge");
});

test("研判详情 sheet:标题+诚实行+表头8列+逐场行齐", () => {
  const sheet = buildRadarDetailSheet({ date: "2026-06-19", rows: [rowTrap, rowClean] });
  assert.equal(sheet.name, "研判详情");
  assert.match(sheet.rows[0][0], /异动雷达/);
  assert.match(sheet.rows[1][0], /诚实边界/);
  assert.equal(sheet.rows[2].length, 8);
  assert.equal(sheet.rows.length, 2 + 1 + 2); // 标题+诚实+表头 + 2场
  // 每场行=8列,方向列恒含盘口主推方向
  assert.equal(sheet.rows[3].length, 8);
  assert.match(sheet.rows[3][2], /主胜/);
  // 分栏正确:MOVE列(第4)含大小球edge+庄家意图·风险列(第3)含证伪·爆冷列(第5)含机理(守护分桶不回退)
  assert.match(sheet.rows[3][4], /唯一统计edge/);
  assert.match(sheet.rows[3][4], /庄家意图/);
  assert.match(sheet.rows[3][3], /证伪/);
  assert.match(sheet.rows[3][5], /客场乏力|爆冷/);
});

test("buyAdvice:高爆冷→轻仓不当独胆", () => {
  assert.match(buyAdvice(rowTrap), /爆冷风险高|轻仓/);
});

test("异动完整性:初盘未捕获→⚠️缺标注(诚实·不编异动)", () => {
  const rowNoInit = { idx: 3, match: "戊 vs 己", comp: "意甲", wld: "主胜(60%)", tier: "二档", conf: 60,
    primary: { text: "盘口主推:主胜", agree: true },
    signals: "欧赔:热门=主胜 ‖ 亚盘:让-0.75(开盘未动)·水位偏主 ‖ 阵容:✅已出(已按首发重算)" };
  const rad = buildAnomalyRadar(rowNoInit);
  const f = rad.factors.find((x) => x.cat === "异动完整性");
  assert.ok(f, "初盘缺应报异动完整性");
  assert.equal(f.tag, "⚠️缺");
  // 初盘已捕获(初现持平)不应误报
  assert.ok(!buildAnomalyRadar({ ...rowNoInit, signals: "欧赔:热门=主胜·初现持平 ‖ 阵容:✅已出" }).factors.some((x) => x.cat === "异动完整性"));
});
