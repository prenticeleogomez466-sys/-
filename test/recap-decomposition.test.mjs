// 深度归因复盘守护(2026-06-15):逐场拆维度+因果;跨场规律带样本n;临场情报维标缺不编;诚实不当edge。
import { test } from "node:test";
import assert from "node:assert/strict";
import { oddsDrift, decomposeMatch, minePatterns } from "../src/recap-decomposition.js";

const row = (o = {}) => ({
  date: "2026-06-14", match: "A vs B", competition: "世界杯", primary: "主胜", actual: "主胜",
  actualScore: "2-0", actualStatus: "settled",
  primaryOpeningOdds: 2.0, primaryOdds: 1.7,
  probabilityHome: 0.55, probabilityDraw: 0.25, probabilityAway: 0.2,
  handicapLine: -1, handicapWld: "主队让1胜", handicapWldCode: "3", actualHandicapCode: "3", handicapWldHit: true,
  scorePrimary: "2-1", scoreHit: false, actualScore: "2-0",
  confidence: 70, tier: "一档", risk: "低",
  ...o,
});

test("oddsDrift: 初盘→收盘漂移方向(收缩=被加注/走高=退烧);缺赔率→null", () => {
  assert.equal(oddsDrift(row({ primaryOpeningOdds: 2.0, primaryOdds: 1.7 })).dir, "收缩(被加注)");
  assert.equal(oddsDrift(row({ primaryOpeningOdds: 1.7, primaryOdds: 2.0 })).dir, "走高(退烧)");
  assert.equal(oddsDrift(row({ primaryOpeningOdds: 2.0, primaryOdds: 2.0 })).dir, "基本不变");
  assert.equal(oddsDrift(row({ primaryOpeningOdds: null, primaryOdds: 1.7 })), null);
});

test("decomposeMatch: 被加注且命中→✅兑现;拆出多维+因果综述", () => {
  const d = decomposeMatch(row());
  const drift = d.dims.find((x) => x.dim.startsWith("赔率漂移"));
  assert.equal(drift.tag, "✅实测");
  assert.equal(drift.verdict, "✅兑现");
  assert.ok(drift.note.includes("资金流向与结果一致"));
  // 让球维兑现
  assert.equal(d.dims.find((x) => x.dim.startsWith("让胜负平")).verdict, "✅兑现");
  // 临场情报维=⚠️缺(诚实,未入历史ledger)
  assert.equal(d.dims.find((x) => x.dim.includes("战意")).tag, "⚠️缺");
  assert.ok(d.synthesis.includes("主推命中"));
});

test("decomposeMatch: 被加注却没中→❌打脸+深层逻辑提示", () => {
  const d = decomposeMatch(row({ actual: "客胜", actualScore: "0-1", handicapWldHit: false, actualHandicapCode: "0" }));
  const drift = d.dims.find((x) => x.dim.startsWith("赔率漂移"));
  assert.equal(drift.verdict, "❌打脸");
  assert.ok(d.synthesis.includes("被加注方向打脸"));
});

test("decomposeMatch: 平局盲区在综述里点名", () => {
  const d = decomposeMatch(row({ actual: "平局", actualScore: "1-1" }));
  assert.ok(d.synthesis.includes("平局"));
});

test("minePatterns: 跨场规律带样本n;小样本不强行归纳;平局占比对照", () => {
  const rows = [];
  // 12 场被加注且命中 + 4 场被加注没中 → "被加注"桶 n=16 命中75%
  for (let i = 0; i < 12; i++) rows.push(row({ match: `H${i}`, actualScore: `${i}-0`, primaryOpeningOdds: 2, primaryOdds: 1.6, actual: "主胜", primary: "主胜" }));
  for (let i = 0; i < 4; i++) rows.push(row({ match: `M${i}`, actualScore: `0-${i + 1}`, primaryOpeningOdds: 2, primaryOdds: 1.6, actual: "客胜", primary: "主胜" }));
  const p = minePatterns(rows, { minN: 8 });
  assert.equal(p.n, 16);
  const drift = p.patterns.find((x) => x.condition.includes("被加注"));
  assert.ok(drift && drift.n === 16);
  assert.equal(drift.hitRate, 75);
  assert.ok(p.note.includes("非预测edge"));
});

test("minePatterns: 样本不足→空规律不编", () => {
  const p = minePatterns([row(), row({ match: "C vs D" })], { minN: 8 });
  assert.equal(p.patterns.length, 0); // 各桶 < 8
});
