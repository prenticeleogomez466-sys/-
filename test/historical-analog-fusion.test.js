import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

const PRIOR = { home: 0.45, draw: 0.27, away: 0.28 };
const FIXTURE = { id: "x1", date: "2026-05-30", competition: "Premier League", homeTeam: "A", awayTeam: "B" };

test("historical-analog 已登记进 SIGNAL_NAMES", () => {
  assert.ok(SIGNAL_NAMES.includes("historical-analog"));
});

test("有类比结果且抬高主胜 → historical-analog 信号 fire,LR.home>1", () => {
  const context = {
    historicalAnalog: {
      ok: true, analogCount: 50, effectiveN: 28, wld: "home",
      probabilities: { home: 0.66, draw: 0.18, away: 0.16 }
    }
  };
  const { evidence } = collectFusionEvidence(PRIOR, FIXTURE, {}, context);
  const sig = evidence.find((e) => e.name === "historical-analog");
  assert.ok(sig, "应触发 historical-analog");
  assert.ok(sig.ratio.home > 1);
  assert.ok(sig.ratio.away < 1);
});

test("无类比数据 → historical-analog 休眠,不污染其他信号", () => {
  const { evidence, dormant } = collectFusionEvidence(PRIOR, FIXTURE, {}, {});
  assert.ok(!evidence.find((e) => e.name === "historical-analog"));
  assert.ok(dormant.find((d) => d.name === "historical-analog"));
});

test("有效样本不足 → 休眠(insufficient-analogs)", () => {
  const context = {
    historicalAnalog: { ok: true, analogCount: 4, effectiveN: 3, wld: "home",
      probabilities: { home: 0.8, draw: 0.1, away: 0.1 } }
  };
  const { evidence, dormant } = collectFusionEvidence(PRIOR, FIXTURE, {}, context);
  assert.ok(!evidence.find((e) => e.name === "historical-analog"));
  const d = dormant.find((x) => x.name === "historical-analog");
  assert.ok(d && String(d.dormant).startsWith("insufficient-analogs"));
});
