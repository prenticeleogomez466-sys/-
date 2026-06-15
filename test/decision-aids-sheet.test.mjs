// 决策辅助工作表产品化守护(2026-06-16):把 honest-pass-gate/分歧雷达/组合凯利/精选 4 个原 test-only
// 模块接进交付,本守护钉死「已产品化·不退回僵尸」+ 内容真实(过关裁决/精选/雷达/注金闸四节齐) + 空态优雅。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionAidsSheet } from "../src/today-delivery-lib.js";

const mkRow = (over) => ({
  match: over.match,
  decision: {
    match: over.match, competition: over.competition ?? "世界杯", dir: over.dir ?? "主胜", tier: over.tier ?? "二档",
    prob: over.prob, modelProb: over.modelProb ?? over.prob, marketProb: over.marketProb ?? over.prob,
    odds: over.odds ?? 1.5, ev: over.ev, risk: over.risk ?? "中", divergencePp: over.divergencePp ?? 2, aligned: over.aligned ?? true,
    modelProbs: over.modelProbs ?? { home: 0.6, draw: 0.25, away: 0.15 },
    marketProbs: over.marketProbs ?? { home: 0.58, draw: 0.26, away: 0.16 },
    stakeUnits: over.stakeUnits ?? 1, stakeAmount: over.stakeAmount ?? 100,
  },
});

test("决策辅助:四节齐(诚实过关/精选/分歧雷达/组合注金闸)且基于真实输入", () => {
  const rows = [
    mkRow({ match: "强热门 vs 弱旅", prob: 0.73, ev: 0.06, risk: "低", divergencePp: 1 }),     // 应过关(正EV+低风险+可信桶)
    mkRow({ match: "悬殊 vs 大热", prob: 0.66, ev: -0.12, risk: "高" }),                          // 应观望(负EV+高风险)
  ];
  const sheet = buildDecisionAidsSheet({ date: "2026-06-16", rows });
  assert.equal(sheet.name, "决策辅助");
  const flat = sheet.rows.map((r) => r.join("｜")).join("\n");
  assert.match(flat, /【A】逐场诚实过关闸/);
  assert.match(flat, /【B】今日精选/);
  assert.match(flat, /【C】模型↔市场分歧雷达/);
  assert.match(flat, /【D】组合注金相关性闸/);
  // honest-pass-gate 真裁决:正EV低风险可信桶过关、负EV高风险观望
  assert.match(flat, /强热门 vs 弱旅[^\n]*✅ 诚实过关/);
  assert.match(flat, /悬殊 vs 大热[^\n]*🔻 观望/);
  // 精选只收 ≥65%
  assert.match(flat, /强热门 vs 弱旅[^\n]*65-100/);
});

test("决策辅助:无可归一推荐行 → 优雅标缺不编(空态)", () => {
  const sheet = buildDecisionAidsSheet({ date: "2026-06-16", rows: [{ match: "x", decision: null }] });
  assert.equal(sheet.name, "决策辅助");
  const flat = sheet.rows.map((r) => r.join("")).join("\n");
  assert.match(flat, /决策辅助本次不出/);
});
