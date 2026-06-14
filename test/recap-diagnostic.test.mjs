// 诊断型复盘守护(2026-06-14 用户裁决"复盘=进化模型"):模型主推 vs 盘口热门头对头胜率、
//   命中构成(主/次选)、去重(同场多次推荐不灌水)、未中归因。盘口热门=europeanOdds直胜最低赔(✅实测)。
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecapDiagnostic } from "../src/recap-diagnostic.js";

function withMarket(date, snapshots) {
  const dir = mkdtempSync(join(tmpdir(), "recap-diag-"));
  mkdirSync(join(dir, "market"), { recursive: true });
  writeFileSync(join(dir, "market", `${date}.json`), JSON.stringify({ date, snapshots }), "utf8");
  return dir;
}

test("模型 vs 盘口头对头 + 去重 + 命中构成", () => {
  const ledger = [
    // 同场被两个销售日各推一次(队A对队B 1-0)→ 去重保留最晚 date,只算一场
    { date: "2026-06-08", match: "队A 对 队B", sequence: "9", competition: "世界杯", primary: "客胜", actual: "主胜", actualScore: "1-0", actualStatus: "settled", probabilityHome: 0.55, probabilityDraw: 0.25, probabilityAway: 0.20, doubleChanceShort: "12" },
    { date: "2026-06-10", match: "队A 对 队B", sequence: "6008", competition: "世界杯", primary: "客胜", actual: "主胜", actualScore: "1-0", actualStatus: "settled", probabilityHome: 0.55, probabilityDraw: 0.25, probabilityAway: 0.20, doubleChanceShort: "12" },
    { date: "2026-06-10", match: "队C 对 队D", sequence: "6009", competition: "世界杯", primary: "主胜", actual: "主胜", actualScore: "2-0", actualStatus: "settled", probabilityHome: 0.7, probabilityDraw: 0.2, probabilityAway: 0.1, doubleChanceShort: "1X" },
  ];
  const dir = withMarket("2026-06-10", [
    { homeTeam: "队A", awayTeam: "队B", europeanOdds: { current: { home: 1.5, draw: 3.8, away: 6.0 } } }, // 盘口热门=主胜=实际→盘口中、模型(客胜)未中
    { homeTeam: "队C", awayTeam: "队D", europeanOdds: { current: { home: 1.4, draw: 4.2, away: 7.0 } } }, // 盘口热门=主胜=实际→都中
  ]);
  try {
    const { stats } = buildRecapDiagnostic(ledger, { dataDir: dir });
    assert.strictEqual(stats.rawCount, 3, "原始应3行");
    assert.strictEqual(stats.dupRemoved, 1, "应去重1行(队A对队B重复)");
    assert.strictEqual(stats.total, 2, "去重后2场");
    assert.strictEqual(stats.bothCount, 2, "两场盘口直胜赔齐→均可头对头");
    assert.strictEqual(stats.modelHit, 1, "模型主推命中1(队C)");
    assert.strictEqual(stats.marketHit, 2, "盘口热门命中2(两场主胜)");
    assert.ok(stats.edgePp < 0, "模型应跑输盘口(edge为负): " + stats.edgePp);
    // 队A 模型客胜未中但双选12含主胜→次选救回
    assert.strictEqual(stats.secondaryRescue, 1, "队A 双选12 应救回1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("悬殊盘 europeanOdds 缺→盘口热门标缺,不冒充(不计入头对头)", () => {
  const ledger = [
    { date: "2026-06-10", match: "强队 对 弱队", sequence: "7009", competition: "世界杯", primary: "主胜", actual: "主胜", actualScore: "3-0", actualStatus: "settled", probabilityHome: 0.82, probabilityDraw: 0.13, probabilityAway: 0.05 },
  ];
  const dir = withMarket("2026-06-10", [
    { homeTeam: "强队", awayTeam: "弱队", europeanOdds: null, handicapOdds: { current: { home: 1.75, draw: 4, away: 3.15 } } },
  ]);
  try {
    const { stats, perMatch } = buildRecapDiagnostic(ledger, { dataDir: dir });
    assert.strictEqual(stats.bothCount, 0, "直胜赔缺不应计入头对头");
    assert.match(perMatch[0].marketFav, /⚠️/, "应如实标⚠️不冒充盘口热门");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
