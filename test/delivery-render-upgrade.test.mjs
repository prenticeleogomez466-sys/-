// 2026-06-11 渲染层升级守护测试(用户裁决①②③④,新逻辑配新测试):
//   ① wcPriorCells:世界杯先验透明列组(非WC场"—";Elo缺/λ缺/超算缺逐项⚠️标缺不编;confedAdj单独注明)
//   ② handicapVerdictParts:让球方向=模型真实裁决,可与胜平负不同向,不同向注逻辑("主胜但难净胜2球→让球客胜")
//   ③ parlaySafety:串关安全度三级(⛔硬币/⛔证伪 > 🟢一二档非高风险未证伪 > 🟡其余)
//   ④ 数据审计表/14场闸裁决表/三列同向自检/H2H·亚盘双源·外盘参考渲染(零交锋⚠️、双源分歧以titan007为准)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wcPriorCells, handicapVerdictParts, parlaySafety, PARLAY_ORDER_NOTE,
  renderH2hCell, renderAsianDualCell, renderEuroRefCell, threeColumnCoherence,
  auditCell, buildAuditSheet, buildFourteenSheetRows, AUDIT_DIMENSIONS, XLSX_HEADERS,
} from "../src/today-delivery-lib.js";

// ── ① 世界杯模型先验透明列组 ──
test("wcPriorCells:非世界杯场三格全'—'(不冒充)", () => {
  assert.deepEqual(wcPriorCells({ isWc: false, prior: null, lambdaCtx: null, wcLine: "" }), { elo: "—", lambda: "—", tourney: "—" });
});

test("wcPriorCells:WC场=Elo三概率+confedAdj单独注明+场馆λ因子+出线夺冠%", () => {
  const cells = wcPriorCells({
    isWc: true,
    prior: { probabilities: { home: 0.7186, draw: 0.2035, away: 0.0779 }, eloDiff: 386, homeAdv: 35, confedAdj: -60 },
    lambdaCtx: { isWC: true, lambdaMult: 1.06, venue: { city: "墨西哥城", altitude_m: 2240, indoor: false }, factors: ["海拔2240m→进球↑6%", "小组赛·开放"] },
    wcLine: "墨西哥 出线95%·夺冠1% ｜ 南非 出线22%·夺冠0%",
  });
  assert.match(cells.elo, /主72%\/平20%\/客8%/);
  assert.match(cells.elo, /confedAdj-60/, "洲际校正值必须单独注明");
  assert.match(cells.elo, /东道主\+35/);
  assert.match(cells.elo, /✅Elo底座/);
  assert.match(cells.lambda, /×1\.06/);
  assert.match(cells.lambda, /墨西哥城·海拔2240m/);
  assert.match(cells.lambda, /小组赛·开放/);
  assert.match(cells.tourney, /出线95%·夺冠1%/);
});

test("wcPriorCells:WC场但Elo缺/λ缺/超算缺 → 逐项⚠️标缺不编", () => {
  const cells = wcPriorCells({ isWc: true, prior: null, lambdaCtx: null, wcLine: "" });
  assert.match(cells.elo, /⚠️Elo先验缺/);
  assert.match(cells.lambda, /⚠️场馆λ缺/);
  assert.match(cells.tourney, /⚠️超算json缺/);
});

// ── ② 让球方向=模型真实裁决 ──
const HW = (pick, pickCode, prob, dist) => ({ pick, pickCode, probability: prob, probabilities: dist });

test("handicapVerdictParts:与胜平负同向 → 注'与胜平负同向',无逻辑注", () => {
  const v = handicapVerdictParts({
    line: -1, wldCode: "3", wldLabel: "主胜",
    hw: HW("让球主胜", "3", 0.48, { home: 0.48, push: 0.23, away: 0.29 }),
    marketDist: { home: 0.43, push: 0.27, away: 0.30 },
  });
  assert.equal(v.sameDir, true);
  assert.equal(v.note, null);
  assert.match(v.text, /让球主胜 过盘48%\(模型\) vs 43%\(市场\)/);
  assert.match(v.text, /与胜平负同向/);
});

test("handicapVerdictParts:主胜但让球客胜(深盘)→ 不同向+'主胜但难净胜2球→让球客胜'逻辑注", () => {
  const v = handicapVerdictParts({
    line: -2, wldCode: "3", wldLabel: "主胜",
    hw: HW("让球客胜", "0", 0.57, { home: 0.25, push: 0.18, away: 0.57 }),
    marketDist: { home: 0.27, push: 0.25, away: 0.48 },
  });
  assert.equal(v.sameDir, false);
  assert.match(v.note, /主胜但难净胜2球→让球客胜/);
  assert.match(v.text, /⚠️与胜平负不同向/);
  assert.match(v.text, /过盘57%\(模型\) vs 48%\(市场\)/);
});

test("handicapVerdictParts:主胜但走盘(恰赢盘口球数)→ 走盘逻辑注", () => {
  const v = handicapVerdictParts({
    line: -1, wldCode: "3", wldLabel: "主胜",
    hw: HW("走盘", "1", 0.40, { home: 0.32, push: 0.40, away: 0.28 }),
    marketDist: { home: 0.30, push: 0.38, away: 0.32 },
  });
  assert.equal(v.sameDir, false);
  assert.match(v.note, /主胜但最可能恰好只赢1球→走盘/);
});

test("handicapVerdictParts:受让盘客胜但主队过盘 → 客侧逻辑注;市场缺 → 标⚠️缺不编", () => {
  const v = handicapVerdictParts({
    line: 1, wldCode: "0", wldLabel: "客胜",
    hw: HW("让球主胜", "3", 0.52, { home: 0.52, push: 0.26, away: 0.22 }),
    marketDist: null,
  });
  assert.equal(v.sameDir, false);
  assert.match(v.note, /客胜但难净胜1球/);
  assert.match(v.text, /市场赔率⚠️缺/);
  // 无让球三态分布 → 整格标缺
  assert.match(handicapVerdictParts({ line: 0, wldCode: "3", wldLabel: "主胜", hw: null, marketDist: null }).text, /⚠️让球真实裁决缺/);
});

// ── ③ 串关安全度三级 ──
test("parlaySafety:硬币场/证伪场=⛔;一二档+非高风险+未证伪=🟢;其余=🟡(注原因)", () => {
  assert.equal(parlaySafety({ tier: "⚪硬币档", risk: "中", advLabel: "" }).grade, "⛔");
  assert.equal(parlaySafety({ tier: "🟢一档", risk: "低", advLabel: "🔴 三视角一致证伪(建议观望)(3/3)" }).grade, "⛔", "一档但被证伪也要⛔");
  assert.equal(parlaySafety({ tier: "🟢二档", risk: "中", advLabel: "🟡部分质疑" }).grade, "🟢");
  const y1 = parlaySafety({ tier: "🟡三档", risk: "中", advLabel: "🟡部分质疑" });
  assert.equal(y1.grade, "🟡");
  assert.match(y1.text, /信心档不足/);
  const y2 = parlaySafety({ tier: "🟢一档", risk: "高", advLabel: "🟡部分质疑" });
  assert.equal(y2.grade, "🟡");
  assert.match(y2.text, /risk=高/);
  const y3 = parlaySafety({ tier: "🟢一档", risk: "低", advLabel: "" });
  assert.equal(y3.grade, "🟡", "未审计≠通过,降🟡");
  assert.match(y3.text, /证伪未覆盖/);
  assert.match(PARLAY_ORDER_NOTE, /🟢串关候选.*🟡谨慎.*⛔串关排除/);
});

// ── ④a H2H 渲染(本地49k历史库新结构 + 零交锋⚠️ + 旧数组兼容) ──
test("renderH2hCell:本地49k库对象→朝向主队比分+赛会+标签;零交锋⚠️如实;旧数组兼容", () => {
  const h2h = {
    source: "martj42-intl-results-local(截至2026-06-03)", label: "✅实测(本地历史库)", homeEn: "Mexico",
    meetings: [
      { date: "2010-06-11", tournament: "FIFA World Cup", home: "South Africa", away: "Mexico", score: "1-1", neutral: false, resForFixtureHome: "平" },
      { date: "2000-06-07", tournament: "USA Cup", home: "Mexico", away: "South Africa", score: "4-2", neutral: true, resForFixtureHome: "胜" },
    ],
  };
  const cell = renderH2hCell(h2h, "墨西哥");
  assert.match(cell, /2010-06-11 墨西哥1-1/, "客场作赛比分须翻转为主队视角");
  assert.match(cell, /2000-06-07 墨西哥4-2\(胜·USA Cup·中立\)/);
  assert.match(cell, /✅实测\(本地历史库\)/);
  // 零交锋:⚠️明示"已查证为缺",不冒充没查
  const zero = renderH2hCell({ source: "martj42-intl-results-local", meetings: [] }, "加拿大");
  assert.match(zero, /⚠️零交锋/);
  assert.match(zero, /49k国际赛历史库/);
  // 旧 ESPN 数组形状兼容
  assert.match(renderH2hCell([{ date: "2025-10-10", gf: 2, ga: 1, res: "胜" }], "主队"), /主队2-1\(胜\)/);
  assert.equal(renderH2hCell(null, "x"), "⚠️未取到");
});

// ── ④b 亚盘双源渲染(口径分歧以 titan007 即时盘为准并注明) ──
test("renderAsianDualCell:DK+titan007并存;线分歧→注明以titan007为准;单源/双缺各诚实", () => {
  const t7 = {
    live: { line: 1.25, lineText: "一球/球半", homeWater: 1.04, awayWater: 0.83 },
    init: { line: 1, lineText: "一球", homeWater: 0.89, awayWater: 0.93 },
    companiesCount: 15, primaryCompany: { name: "Crow*" }, fetchedAt: "2026-06-10T12:00:45.509Z",
  };
  const dk = { line: "-1.5", homeOdds: 2.25, awayOdds: 1.59, openLine: "-0.5", source: "ESPN/DraftKings" };
  const both = renderAsianDualCell({ dk, titan007: t7 });
  assert.match(both, /titan007即时 主让1\.25/);
  assert.match(both, /✅titan007/);
  assert.match(both, /DK -1\.5 主2\.25\/客1\.59/);
  assert.match(both, /⚠️双源口径分歧\(DK主让1\.5 vs titan007主让1\.25\)——以titan007即时盘为准/);
  // 双源同线(DK -1.25 == titan007 +1.25)→ 不报分歧
  const same = renderAsianDualCell({ dk: { ...dk, line: "-1.25", openLine: null }, titan007: t7 });
  assert.doesNotMatch(same, /双源口径分歧/);
  // 仅 titan007(受让盘负线显示"主受让")
  const only = renderAsianDualCell({ titan007: { ...t7, live: { line: -1.75, lineText: "受让球半/两球", homeWater: 0.97, awayWater: 0.89 } } });
  assert.match(only, /主受让1\.75/);
  assert.doesNotMatch(only, /DK /);
  // 双缺
  assert.match(renderAsianDualCell(null), /⚠️未取到\(DK\/titan007双源均缺\)/);
});

test("renderEuroRefCell:外盘百家平均=🔶仅方向参考;缺→null(上层走⚠️未开售)", () => {
  const cell = renderEuroRefCell({ value: { home: 12.489, draw: 6.245, away: 1.229 }, companies: 189 });
  assert.match(cell, /🔶外盘百家平均 12\.489\/6\.245\/1\.229/);
  assert.match(cell, /189家/);
  assert.match(cell, /仅方向参考,非可投注口径/);
  assert.equal(renderEuroRefCell(null), null);
  assert.equal(renderEuroRefCell({ value: null }), null);
});

// ── ④c 三列同向自检(让球列放行,胜负平/比分/半全场仍硬约束) ──
test("threeColumnCoherence:同向全过/违例点名/未开售跳过", () => {
  const ok = { match: "A vs B", wld: "主选 主胜(60%)", score: "2-0(18%)", halffull: "主胜-主胜(45%)" };
  const bad = { match: "C vs D", wld: "主选 客胜(50%)", score: "2-0(18%)", halffull: "主胜-主胜(45%)" };
  const noSale = { match: "E vs F", wld: "⛔ 未开售(只让球)", score: "2-0(18%)", halffull: "主胜-主胜(45%)" };
  const r1 = threeColumnCoherence([ok, noSale]);
  assert.equal(r1.ok, true);
  assert.equal(r1.checked, 1);
  assert.equal(r1.skipped, 1);
  const r2 = threeColumnCoherence([ok, bad]);
  assert.equal(r2.ok, false);
  assert.match(r2.violations[0], /C vs D/);
});

// ── ④d 数据审计表 + 14场闸裁决表 ──
test("buildAuditSheet:12维表头+每行铺审计格+内容审计区;auditCell=标签+值+来源+时间", () => {
  assert.equal(AUDIT_DIMENSIONS.length, 12);
  const cell = auditCell("✅实测", "1.3/4.15/8.4", "500竞彩XML(spf)", "2026-06-10T12:00:00Z");
  assert.match(cell, /^✅实测 1\.3\/4\.15\/8\.4｜源:500竞彩XML\(spf\)｜抓取:2026-06-10T12:00:00Z$/);
  assert.match(auditCell("⚠️缺", "x", "y", null), /抓取:时间未记录/);
  const sheet = buildAuditSheet({
    date: "2026-06-11",
    rows: [{ idx: 1, match: "A vs B", audit: { "欧赔": "✅实测 …", "世界杯先验": "—(非世界杯场)" } }],
    contentAudit: [["三列同向自检", "✅ 1场全同向"], "单串行说明"],
  });
  assert.equal(sheet.name, "数据审计");
  assert.match(sheet.rows[0][0], /数据审计 · 2026-06-11 · 1场×12维/);
  assert.deepEqual(sheet.rows[1].slice(0, 2), ["#", "对阵"]);
  assert.equal(sheet.rows[1].length, 14); // #+对阵+12维
  assert.equal(sheet.rows[2][2], "✅实测 …");
  assert.match(sheet.rows[2][3], /⚠️缺\(该维未登记\)/, "未登记维度不空格,显式标缺");
  const flat = JSON.stringify(sheet.rows);
  assert.match(flat, /内容审计区/);
  assert.match(flat, /三列同向自检/);
});

test("buildFourteenSheetRows:闸不过→⛔+依据原话+期次事实,绝不渲染腿表;闸过→腿表+任选9", () => {
  const blocked = buildFourteenSheetRows({
    date: "2026-06-11",
    fourteen: { available: false, note: "14 场胜负彩第26085期比赛日不在 2026-06-11(本期赛在未来),按规则今日不发 14 场。", selections: [{ index: 1 }] },
    periodFacts: [["期次事实", "第26085期·停售2026/6/11 22:00"]],
  });
  const blockedFlat = JSON.stringify(blocked);
  assert.match(blockedFlat, /⛔ 今日不发14场段\(任选9 同闸不发\)/);
  assert.match(blockedFlat, /比赛日不在 2026-06-11/);
  assert.match(blockedFlat, /第26085期·停售/);
  assert.doesNotMatch(blockedFlat, /"腿","对阵"/, "不可发时绝不渲染腿表冒充可买");

  const okSheet = buildFourteenSheetRows({
    date: "2026-06-11",
    fourteen: {
      available: true, singleLine: "3 1 0", compoundLine: "31 1 30",
      selections: [{ index: 1, match: "A 对 B", single: "主胜", compound: "主胜/平局", type: "双选", probabilities: { home: "55%", draw: "25%", away: "20%" }, upsetRisk: "标准", confidence: 70, reason: "测试" }],
      renxuan9: { ok: false, reason: "测试不出" }, bankerParlay: null,
    },
    periodFacts: [],
  });
  const okFlat = JSON.stringify(okSheet);
  assert.match(okFlat, /✅ 本期可发/);
  assert.match(okFlat, /A 对 B/);
  assert.match(okFlat, /不出\(测试不出\)/);
});

// ── 列头归属(用户裁决①:世界杯模型列与市场锚列并排,归属一眼分清) ──
test("XLSX_HEADERS:模型归属注明+新列齐全+末列对抗证伪", () => {
  // 27列(2026-06-12 注金裁决:信心档后+💰建议注金列;2026-06-11 四玩法独立裁决:信号面板列等)
  assert.equal(XLSX_HEADERS.length, 27);
  assert.match(XLSX_HEADERS[3], /足球大模型/);
  assert.match(XLSX_HEADERS[4], /市场锚/);
  assert.equal(XLSX_HEADERS.filter((h) => h.includes("世界杯模型")).length, 3);
  assert.match(XLSX_HEADERS[8], /真实裁决.*可与胜平负不同向/);
  assert.match(XLSX_HEADERS[11], /DK\+titan007双源/);
  assert.match(XLSX_HEADERS[12], /信号面板/);
  assert.match(XLSX_HEADERS[13], /盘口✅真实热门主推\+模型🔶/);
  assert.match(XLSX_HEADERS[24], /建议注金/);
  assert.match(XLSX_HEADERS[25], /串关安全度/);
  assert.match(XLSX_HEADERS[26], /对抗证伪/);
});
