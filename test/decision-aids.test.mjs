// 决策辅助守护(2026-06-15):组合凯利相关性闸 + 模型↔市场分歧雷达。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPortfolioRisk } from "../src/portfolio-kelly.js";
import { rankByDivergence } from "../src/market-divergence-radar.js";
import { selectHighConfidence } from "../src/selective-picks.js";

test("组合凯利:同场跨玩法总注超 perMatchCap → 按比例缩放", () => {
  const r = assessPortfolioRisk([
    { match: "A 对 B", market: "1x2", stakeUnits: 2 },
    { match: "A 对 B", market: "handicap", stakeUnits: 2 }, // 同场共 4U > 2U
    { match: "C 对 D", market: "1x2", stakeUnits: 1 },
  ], { perMatchCap: 2, totalCap: 100 });
  const ab = r.picks.filter((p) => p.match === "A 对 B");
  assert.ok(Math.abs(ab.reduce((s, p) => s + p.adjustedStake, 0) - 2) < 1e-6); // 缩到 2U
  assert.equal(ab[0].capped, "per-match");
  assert.equal(r.picks.find((p) => p.match === "C 对 D").adjustedStake, 1); // 未触顶不动
  assert.ok(r.warnings.length >= 1);
});

test("组合凯利:全天总注超 totalCap → 全局缩放", () => {
  const r = assessPortfolioRisk([
    { match: "A 对 B", stakeUnits: 6 },
    { match: "C 对 D", stakeUnits: 6 },
  ], { perMatchCap: 100, totalCap: 10 });
  assert.ok(Math.abs(r.totalAfter - 10) < 1e-6);
  assert.equal(r.picks[0].capped, "total");
});

test("组合凯利:缺 stake/空输入安全", () => {
  const r = assessPortfolioRisk([{ match: "X 对 Y" }], {});
  assert.equal(r.totalBefore, 0);
  assert.equal(assessPortfolioRisk(null).picks.length, 0);
});

test("分歧雷达:按分歧降序 + 高分歧 flagged", () => {
  const rows = [
    { match: "低分歧", modelProbs: { home: 0.5, draw: 0.3, away: 0.2 }, marketProbs: { home: 0.52, draw: 0.28, away: 0.2 } },
    { match: "高分歧", modelProbs: { home: 0.6, draw: 0.25, away: 0.15 }, marketProbs: { home: 0.3, draw: 0.3, away: 0.4 } },
  ];
  const out = rankByDivergence(rows, { threshold: 0.25 });
  assert.equal(out[0].match, "高分歧"); // 分歧大的在前
  assert.equal(out[0].flagged, true);
  assert.equal(out[0].agree, false);   // 模型主胜 vs 市场客胜
  assert.equal(out[1].flagged, false);
});

test("分歧雷达:无市场隐含 → hasMarket:false 排末尾,分歧不可判", () => {
  const rows = [
    { match: "有市场", modelProbs: { home: 0.6, draw: 0.25, away: 0.15 }, marketProbs: { home: 0.55, draw: 0.27, away: 0.18 } },
    { match: "无市场", modelProbs: { home: 0.6, draw: 0.25, away: 0.15 }, marketProbs: null },
  ];
  const out = rankByDivergence(rows);
  assert.equal(out[out.length - 1].match, "无市场");
  assert.equal(out[out.length - 1].hasMarket, false);
  assert.equal(out[out.length - 1].divergence, null);
});

test("选择性精选:只留 favorite≥门槛,降序 + 桶标注 + 覆盖率", () => {
  const picks = [
    { match: "强热门", favoriteProb: 0.78 },
    { match: "中等", favoriteProb: 0.58 },
    { match: "硬币", favoriteProb: 0.48 },
  ];
  const { selected, coverage } = selectHighConfidence(picks, { minConfidence: 0.65 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].match, "强热门");
  assert.equal(selected[0].bucket, "65-100");
  assert.equal(coverage.total, 3);
  assert.equal(coverage.rate, 0.333);
});

test("选择性精选:maxPicks 截断 + 空输入安全", () => {
  const picks = [{ match: "A", favoriteProb: 0.9 }, { match: "B", favoriteProb: 0.8 }, { match: "C", favoriteProb: 0.7 }];
  assert.equal(selectHighConfidence(picks, { minConfidence: 0.65, maxPicks: 2 }).selected.length, 2);
  assert.equal(selectHighConfidence(null).selected.length, 0);
});
