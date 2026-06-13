// 逐注驱动因子归因守护(2026-06-13)。锁三件:① 俱乐部瀑布的锚=市场×wMkt+模型×wMdl 数学要复原、
// 校准段位移=calibration.adjustment;② WC 路由场用 wcModel.decisiveFactors 出 drivers,route 正确;
// ③ 零编造——data-missing/无 pick 不造数,waterfall.final 概率恒等于 prediction.probabilities。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPickDriverAttribution, attributionLine } from "../src/pick-driver-attribution.js";

// 仿真俱乐部预测(结构取自真实 predictFixture 产出:坦佩雷 vs TPS)。
function clubPrediction() {
  return {
    provenance: "odds(0.65)+dixon-coles(0.35)",
    baseProbabilities: { home: 0.5204, draw: 0.2522, away: 0.2274 },
    probabilities: { home: 0.5166, draw: 0.2542, away: 0.2292 },
    marketImpliedProbabilities: { home: 0.5092, draw: 0.2461, away: 0.2447 },
    dixonColes: { independentProbs: { home: 0.5412, draw: 0.2635, away: 0.1953 } },
    probabilityAdjustment: {
      probabilities: { home: 0.5204, draw: 0.2522, away: 0.2274 },
      fusionGatedOff: true,
      fusion: { applied: false, probabilities: { home: 0.5204, draw: 0.2522, away: 0.2274 }, evidence: [] },
      calibration: { applied: true, source: "isotonic-regression", scope: "isotonic-market", bucket: "45-55", samples: 8455, adjustment: -0.0038 },
      worldCup: null,
    },
    pick: { code: "3", key: "home", label: "主胜", probability: 0.5166 },
  };
}

// 仿真 WC 路由场(结构取自真实:海地 vs 苏格兰)。
function wcPrediction() {
  return {
    provenance: "worldcup-match-model",
    probabilities: { home: 0.1097, draw: 0.2215, away: 0.6688 },
    baseProbabilities: { home: 0.1097, draw: 0.2215, away: 0.6688 },
    probabilityAdjustment: { worldCup: { lambdaMult: 0.97 }, calibration: { applied: false, source: "worldcup-model-bypass" } },
    pick: { code: "0", key: "away", label: "客胜", probability: 0.6688 },
    wcModel: {
      elo: { home: 1548, away: 1782, diff: -314 },
      confed: { home: "CONCACAF", away: "UEFA", adj: -80 },
      venue: { city: "波士顿", altitude_m: 88, temp: 27, indoor: false },
      market: { implied: { home: 0.1001, draw: 0.2028, away: 0.6971 }, marketPickCode: "0", agree: true, divergence: 0.0379 },
      decisiveFactors: [
        { key: "实力(Elo)", detail: "Haiti 1548 vs Scotland 1782(差 -314)", weight: 314, tag: "✅实测" },
        { key: "洲际校正", detail: "CONCACAF vs UEFA → Elo-80", weight: 80, tag: "✅实测(OOS验证)" },
        { key: "市场赔率", detail: "市场主推 客胜(69.7%)·与模型同向", weight: 50, tag: "✅实测(只作对照)" },
      ],
      gaps: [],
    },
  };
}

describe("pick-driver-attribution", () => {
  it("俱乐部路径:锚=市场×wMkt+模型×wMdl 数学可复原(不编造)", () => {
    const attr = buildPickDriverAttribution(clubPrediction());
    assert.equal(attr.route, "club-blend");
    const anchor = attr.waterfall.find((s) => s.stage === "anchor");
    const mkt = attr.waterfall.find((s) => s.stage === "market");
    const mdl = attr.waterfall.find((s) => s.stage === "model");
    // 0.5092*0.65 + 0.5412*0.35 = 0.5204(锚的真实复原)
    const recomputed = mkt.probs.home * mkt.weight + mdl.probs.home * mdl.weight;
    assert.ok(Math.abs(recomputed - anchor.probs.home) < 1e-3, `锚复原 ${recomputed} ≠ ${anchor.probs.home}`);
  });

  it("俱乐部路径:校准段位移=calibration.adjustment,且 fusion 因市场prior标关闭", () => {
    const attr = buildPickDriverAttribution(clubPrediction());
    const fusion = attr.waterfall.find((s) => s.stage === "fusion");
    assert.match(fusion.note, /关闭/);
    const calib = attr.waterfall.find((s) => s.stage === "calibration");
    assert.equal(calib.deltaPP, -0.4); // -0.0038 → -0.4pp
    const calibDriver = attr.drivers.find((d) => d.factor === "isotonic 校准");
    assert.ok(calibDriver && /压主胜/.test(calibDriver.direction));
  });

  it("俱乐部路径:waterfall 最终概率恒等于 prediction.probabilities(零篡改)", () => {
    const p = clubPrediction();
    const attr = buildPickDriverAttribution(p);
    const last = attr.waterfall[attr.waterfall.length - 1];
    assert.deepEqual(last.probs, p.probabilities);
  });

  it("WC 路由场:route 正确,drivers 来自 decisiveFactors,含 Elo/洲际", () => {
    const attr = buildPickDriverAttribution(wcPrediction());
    assert.equal(attr.route, "worldcup-match-model");
    assert.equal(attr.drivers.length, 3);
    assert.equal(attr.drivers[0].factor, "实力(Elo)");
    assert.match(attr.narrative, /Elo 差 -314/);
    assert.match(attr.narrative, /洲际校正 -80/);
    // 场馆 λ 乘子 0.97≠1 应进瀑布
    assert.ok(attr.waterfall.some((s) => s.stage === "venue"));
  });

  it("零编造:无 pick / data-missing → route=data-missing,不造数", () => {
    const attr = buildPickDriverAttribution({ provenance: "data-missing", probabilities: null, pick: null });
    assert.equal(attr.route, "data-missing");
    assert.deepEqual(attr.drivers, []);
    assert.equal(buildPickDriverAttribution(null), null);
  });

  it("attributionLine 出非空中文摘要", () => {
    assert.match(attributionLine(buildPickDriverAttribution(clubPrediction())), /主推 主胜/);
    assert.match(attributionLine(buildPickDriverAttribution(wcPrediction())), /主因/);
  });
});
