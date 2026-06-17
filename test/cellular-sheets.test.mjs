import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandicapSanitySheet, buildUpsetAnalysisSheet, buildIntelSheet } from "../src/today-delivery-lib.js";
import { handicapSanity } from "../src/handicap-sanity.js";
import { analyzeUpsetTrap, diagnoseUpsetRisk } from "../src/upset-trap-detector.js";
import { analyzeTotalsMovement } from "../src/totals-movement-signal.js";

// 三大块细胞级守护(2026-06-16 用户:展开到细胞·全接验证过的真信号)。
const flat = (sh) => sh.rows.map((r) => (Array.isArray(r) ? r.join(" ") : String(r))).join("\n");

describe("盘口合理性细胞级(逐玩法真实数字+历史区间+深浅+水位失衡+盘口移动+综合裁决)", () => {
  const rows = [{
    match: "法国 vs 塞内加尔", favProbSource: "盘口",
    sanity: handicapSanity({ ahLine: -1.25, p1x2Fav: 0.671 }),
    sanityOdds: { euro: { home: 1.32, draw: 4.2, away: 7.45 }, euroInit: { home: 1.38, draw: 3.9, away: 6.75 }, hcp: { home: 2.07, draw: 3.45, away: 2.81 }, jcLine: -1, ahLine: -1.25, ahLineInit: -1, anchorLine: -1.25, anchorIsAsian: true, ahHomeWater: 1.02, ahAwayWater: 0.82, over25: 0.6, under25: 0.4, dkAsianLine: -1.5, dkAsianSrc: "DraftKings", intlOverProb: 0.545, intlOverBooks: 13 },
  }];
  const sh = buildHandicapSanitySheet({ date: "2026-06-16", rows });
  it("每行 7 列(与历史总表同宽·writer 列头识别正确)", () => {
    const w = Math.max(...sh.rows.map((r) => r.length));
    assert.equal(w, 7);
  });
  it("含真实赔率数字+历史区间数字(无 P5/P95 黑话)", () => {
    const t = flat(sh);
    assert.match(t, /1\.32/); assert.match(t, /1\.37–1\.5/);
    assert.doesNotMatch(t, /P5|P95/);
  });
  it("含新增细胞维度:亚盘水位失衡/盘口移动/跨源交叉验证/综合裁决", () => {
    const t = flat(sh);
    assert.match(t, /亚盘水位/); assert.match(t, /钱压客队过盘/);
    assert.match(t, /盘口移动/); assert.match(t, /56\.4%/);
    assert.match(t, /跨源交叉验证/); assert.match(t, /DraftKings-1\.5/);  // 真外盘对比
    assert.match(t, /综合盘口裁决/);
  });
  it("亚盘缺→竞彩让球线兜底锚(不再整块判不了)", () => {
    const r2 = [{ ...rows[0], sanity: handicapSanity({ ahLine: -1, p1x2Fav: 0.72 }), sanityOdds: { ...rows[0].sanityOdds, ahLine: null, anchorLine: -1, anchorIsAsian: false, ahHomeWater: null, ahAwayWater: null } }];
    const t = flat(buildHandicapSanitySheet({ date: "2026-06-16", rows: r2 }));
    assert.match(t, /用竞彩让球线/);
    assert.match(t, /🔴过浅|🟢合理|🔴过深/);  // 仍能判深浅
  });
});

describe("爆冷研判细胞级(排行榜+逐场多因子分解·全接验证信号·无英文泄漏)", () => {
  const diag = diagnoseUpsetRisk({ p1x2Fav: 0.62, ahLine: 1.75, totalsLine: 2.5, drawImplied: 0.27, favDrift: -0.03 });
  const trap = analyzeUpsetTrap({ opening: { home: 0.18, draw: 0.27, away: 0.55 }, closing: { home: 0.16, draw: 0.26, away: 0.58 }, model: { home: 0.17, draw: 0.28, away: 0.55 } });
  const tm = analyzeTotalsMovement({ openOverProb: 0.50, closeOverProb: 0.44, ahDepth: 1.75 });
  const rows = [{
    match: "伊拉克 vs 挪威", favProbSource: "模型(1X2未开售)", notWinPct: 38, eloDiff: -120, drawImpliedPct: 0.27, histLineUpset: 0.24,
    sanity: handicapSanity({ ahLine: 1.75, p1x2Fav: 0.62 }), sanityOdds: { over25: 0.44 },
    upsetDiag: diag, upsetTrap: trap, totalsMove: tm, drawRateExp: 0.31, drawRateExpN: 48,
    upsetData: { drawScore: "1-1", drawScoreProb: 0.13, drawHalfFull: 0.10, goalsLean: "小球" }, upsetMarketDraw: null,
  }];
  const sh = buildUpsetAnalysisSheet({ date: "2026-06-16", rows });
  it("排行榜(9列)+细胞分解块都在", () => {
    assert.equal(Math.max(...sh.rows.map((r) => r.length)), 9);
    const t = flat(sh);
    assert.match(t, /排名.*对阵.*热门不胜%/);
    assert.match(t, /细胞级因子分解/);
  });
  it("含 z>4 真edge 大小球走势 + OOS平局信号 + 诚实noise标注", () => {
    const t = flat(sh);
    assert.match(t, /大小球走势.*z>4/);
    assert.match(t, /平局隐含/);
    assert.match(t, /1X2.*走势.*噪声|噪声/);   // 诚实标 1X2 走势=噪声
  });
  it("盘口移动 classification 不泄漏英文(drift/steam 已中文化)", () => {
    const t = flat(sh);
    assert.doesNotMatch(t, /\bdrift\b|\bflat\b|strong-steam/);
  });
});

describe("情报详情细胞级(逐球员首发频次+阵型态势/对位)", () => {
  const intelByMatch = {
    "法国 vs 塞内加尔": {
      home: { lineup: { tag: "🔶推断", status: "预测首发", formation: "4-2-3-1", n: 4, source: "近4场聚合", xi: [{ name: "Kylian Mbappé", position: "F", starts: 3 }, { name: "Marko Farji", position: "LB", starts: 2 }] }, stats: {} },
      away: { lineup: { tag: "🔶推断", status: "预测首发", formation: "5-3-2", n: 4, source: "近4场聚合", xi: [{ name: "Iliman Ndiaye", position: "F", starts: 4 }] }, stats: {} },
      injuries: { text: "无" }, news: { text: "—" }, maturity: 3, comparison: { text: "对位读" }, web: null,
    },
  };
  const rows = [{ idx: 1, match: "法国 vs 塞内加尔" }];
  const sh = buildIntelSheet({ date: "2026-06-16", rows, intelByMatch });
  const t = flat(sh);
  it("逐球员显示位置+首发频次+铁主力/轮换", () => {
    assert.match(t, /姆巴佩\(前锋·3\/4首发\)/);
    assert.match(t, /Marko Farji\(左后卫·2\/4首发·轮换\)/);  // 生僻保留原名
  });
  it("阵型带态势 + 阵型对位读(攻守对撞)", () => {
    assert.match(t, /4-2-3-1\(均衡/);
    assert.match(t, /阵型对位/);
    assert.match(t, /主攻客守|主守客攻|对攻|闷战|均衡对位/);
  });
});
