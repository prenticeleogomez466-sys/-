import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClubEloCsv, normalizeClubKey, eloWinProb } from "../src/clubelo-loader.js";

const SAMPLE = `Rank,Club,Country,Level,Elo,From,To
1,Arsenal,ENG,1,2065.75805664,2026-05-25,2026-05-30
2,Bayern,GER,1,2000.87036133,2026-05-21,2026-05-31
None,Some Lower,ESP,2,1500.5,2026-05-01,2026-05-10
`;

test("parseClubEloCsv 解析行 + 跳过空/坏行", () => {
  const rows = parseClubEloCsv(SAMPLE);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].club, "Arsenal");
  assert.equal(rows[0].country, "ENG");
  assert.equal(rows[0].rank, 1);
  assert.ok(Math.abs(rows[0].elo - 2065.758) < 0.01);
  assert.equal(rows[2].rank, null); // "None" → null
  assert.equal(rows[2].level, 2);
});

test("parseClubEloCsv 空/非法输入返回 []", () => {
  assert.deepEqual(parseClubEloCsv(""), []);
  assert.deepEqual(parseClubEloCsv(null), []);
  assert.deepEqual(parseClubEloCsv("garbage no header"), []);
});

test("normalizeClubKey 归一化", () => {
  assert.equal(normalizeClubKey("Man City"), "mancity");
  assert.equal(normalizeClubKey("Nott'm Forest"), "nottmforest");
  assert.equal(normalizeClubKey("Real Madrid"), "realmadrid");
});

test("eloWinProb 标准 Elo + 主场加成", () => {
  // 同分 + 主场加成 → 主胜概率 > 0.5
  assert.ok(eloWinProb(1500, 1500) > 0.5);
  // 强队主场 → 高概率
  assert.ok(eloWinProb(2000, 1500) > 0.9);
  // 弱队客场对强队 → 低
  assert.ok(eloWinProb(1500, 2000) < 0.1);
  assert.equal(eloWinProb(NaN, 1500), null);
});
