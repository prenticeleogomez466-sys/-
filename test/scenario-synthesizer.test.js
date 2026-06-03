import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeScenario, scenarioNarrative } from "../src/scenario-synthesizer.js";

function base(overrides = {}) {
  return {
    fixture: { competition: "英超", homeTeam: "A", awayTeam: "B" },
    probabilities: { home: 0.5, draw: 0.27, away: 0.23 },
    differentialAnalysis: { archetype: { strength: { label: "小幅占优", key: "slight-edge" } } },
    scorePicks: { deepAnalysis: { concentration: "中等", topScoreProb: 0.11, bands: {} } },
    extendedMarkets: { overUnder: { "2.5": { over: 0.5 } } },
    handicapPick: { upsetTrap: { upsetLevel: "中", upsetRisk: 0.45, tier: "中等热门", trapVerdict: "中性·价实相符", reason: "中性" } },
    ...overrides,
  };
}

test("缺基本字段返回 null", () => {
  assert.equal(synthesizeScenario({}), null);
  assert.equal(synthesizeScenario({ fixture: {} }), null);
});

test("平局概率高 → 平局带=高 + 指引兼顾平局", () => {
  const sc = synthesizeScenario(base({ probabilities: { home: 0.38, draw: 0.34, away: 0.28 } }));
  assert.equal(sc.dims.draw.band, "高");
  assert.ok(sc.marketGuidance.some((g) => /平局|双选/.test(g.lean)));
});

test("over2.5 高 → 大球;低 → 小球", () => {
  const big = synthesizeScenario(base({ extendedMarkets: { overUnder: { "2.5": { over: 0.62 } } } }));
  assert.equal(big.dims.goals.lean, "大球");
  assert.ok(big.marketGuidance.some((g) => g.market === "大小球" && /大球/.test(g.lean)));
  const small = synthesizeScenario(base({ extendedMarkets: { overUnder: { "2.5": { over: 0.40 } } } }));
  assert.equal(small.dims.goals.lean, "小球");
});

test("校准值优先于裸 over", () => {
  const sc = synthesizeScenario(base({ extendedMarkets: { overUnder: { "2.5": { over: 0.40, overCalibrated: 0.60 } } } }));
  assert.equal(sc.dims.goals.lean, "大球");
});

test("大小球缺 → λ合计回退", () => {
  const sc = synthesizeScenario(base({ extendedMarkets: null, dixonColes: { expectedGoals: { home: 2.0, away: 1.4 } } }));
  assert.equal(sc.dims.goals.source, "λ合计");
  assert.equal(sc.dims.goals.lean, "大球");
});

test("爆冷探测器缺 → 实力差回退(势均=高爆冷)", () => {
  const sc = synthesizeScenario(base({
    handicapPick: {},
    differentialAnalysis: { archetype: { strength: { label: "势均力敌", key: "even" } } },
  }));
  assert.equal(sc.dims.upset.band, "高");
});

test("友谊赛 → 重要度低 + 降参考权重指引", () => {
  const sc = synthesizeScenario(base({ fixture: { competition: "国际友谊赛" } }));
  assert.equal(sc.dims.importance.level, "低");
  assert.ok(sc.marketGuidance.some((g) => /降参考权重/.test(g.lean)));
});

test("淘汰赛 → 重要度高", () => {
  const sc = synthesizeScenario(base({ fixture: { competition: "欧冠半决赛" } }));
  assert.equal(sc.dims.importance.level, "高");
});

test("headline 含各维度且逐场可变", () => {
  const sc = synthesizeScenario(base());
  assert.ok(typeof sc.headline === "string" && sc.headline.length > 0);
  assert.match(sc.headline, /平局/);
});

test("scenarioNarrative 拼出情景研判 + 玩法指引块", () => {
  const sc = synthesizeScenario(base({ extendedMarkets: { overUnder: { "2.5": { over: 0.62 } } } }));
  const narr = scenarioNarrative(sc);
  assert.match(narr, /【情景研判】/);
  assert.match(narr, /【玩法指引】/);
});

test("比分分散 → 指引别单押精确比分", () => {
  const sc = synthesizeScenario(base({ scorePicks: { deepAnalysis: { concentration: "分散", topScoreProb: 0.08, bands: {} } } }));
  assert.ok(sc.marketGuidance.some((g) => g.market === "精确比分" && /别单押/.test(g.lean)));
});
