import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 学习域隔离守护(2026-06-10 审计rank12):世界杯/国际赛(含友谊/世预)行不得灌进
// 俱乐部真钱管线的学习路径——signal-weight-tuner 信号权重 + evolution-backtest 的
// ledger 校准档。判定口径复用 competition-soft-recalibration.isSoftCompetition
// (全仓唯一软赛事口径,不造第三套)。统计口径(summary.settled 等)保持全量。

// tuner/backtest 的 ledgerPath 在模块加载时由 getExportDir() 定死 →
// 必须先设 FOOTBALL_EXPORT_DIR 再动态 import。
const dir = mkdtempSync(join(tmpdir(), "fb-domain-iso-"));
process.env.FOOTBALL_EXPORT_DIR = dir;
const { buildSignalWeightsProfile } = await import("../src/signal-weight-tuner.js");
const { runEvolutionBacktest } = await import("../src/evolution-backtest.js");
const { isSoftCompetition } = await import("../src/competition-soft-recalibration.js");

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });

function settledRow(competition, i) {
  return {
    date: "2026-06-01",
    sequence: String(i),
    competition,
    match: `主队${i} 对 客队${i}`,
    primary: "主胜",
    actual: i % 3 === 0 ? "客胜" : "主胜",
    actualStatus: "settled",
    hit: i % 3 !== 0,
    probabilityHome: 0.5,
    probabilityDraw: 0.27,
    probabilityAway: 0.23,
    eloHome: 1500 + i,
    eloAway: 1480 - i,
  };
}

// 12 条俱乐部行 + 6 条世界杯/国际赛行(全部 settled 且带概率)
const clubRows = Array.from({ length: 12 }, (_, i) => settledRow(i % 2 === 0 ? "英超" : "瑞超", i + 1));
const softRows = [
  settledRow("世界杯", 101),
  settledRow("世界杯", 102),
  settledRow("国际友谊", 103),
  settledRow("国际友谊", 104),
  settledRow("世预赛", 105),
  settledRow("U21欧青赛附加赛(International)", 106),
];
writeFileSync(join(dir, "recommendation-ledger.json"), JSON.stringify([...clubRows, ...softRows], null, 2), "utf8");

test("域判定口径:世界杯/友谊/世预=软赛事,俱乐部联赛不误伤", () => {
  for (const name of ["世界杯", "国际友谊", "世预赛", "World Cup", "Friendly"]) {
    assert.equal(isSoftCompetition(name), true, `${name} 应判软赛事`);
  }
  for (const name of ["英超", "瑞超", "日职", "德甲"]) {
    assert.equal(isSoftCompetition(name), false, `${name} 不得判软赛事`);
  }
});

test("tuner 只吃俱乐部行:18 条 settled 里只数 12 条,WC/国际赛 6 条被排除", () => {
  // 默认 minSamples=30:若 WC 行漏进来会数到 18/30,排除后必须是 12/30。
  const profile = buildSignalWeightsProfile();
  assert.equal(profile.usable, false);
  assert.equal(profile.samples, 12, "samples 必须只含俱乐部行");
  assert.equal(profile.excludedSoftRows, 6, "6 条世界杯/国际赛行必须被排除");
  assert.equal(profile.domain, "club-only");
  assert.match(profile.reason, /12\/30/, "冷启动理由须为 12/30(证明 WC 行没进分母)");
});

test("tuner 样本达标时同样只学俱乐部行", () => {
  const profile = buildSignalWeightsProfile({ minSamples: 10 });
  assert.equal(profile.usable, true);
  assert.equal(profile.samples, 12);
  assert.equal(profile.excludedSoftRows, 6);
  assert.equal(profile.domain, "club-only");
});

test("evolution-backtest:ledger 校准档只学俱乐部行,统计口径保持全量", () => {
  const summary = runEvolutionBacktest();
  assert.equal(summary.settled, 18, "summary 统计口径保持全量(含 WC 行)");
  assert.equal(summary.calibration.domain, "club-only");
  assert.equal(summary.calibration.samples, 12, "校准档样本必须只含俱乐部行");
  assert.equal(summary.calibration.excludedSoftSettled, 6, "6 条 WC/国际赛 settled 行排除出校准学习");
});
