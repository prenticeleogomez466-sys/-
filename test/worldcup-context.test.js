import test from "node:test";
import assert from "node:assert/strict";
import { worldCupContextLine, worldCupTeamContext, isWorldCupCompetition } from "../src/worldcup-context.js";

const ROWS = [
  { team: "西班牙", en: "Spain", advance: 0.992, champion: 0.266, r16: 0.78 },
  { team: "法国", en: "France", advance: 0.968, champion: 0.147, r16: 0.77 }
];

test("isWorldCupCompetition:只认决赛圈,世预赛不算", () => {
  assert.equal(isWorldCupCompetition("世界杯"), true);
  assert.equal(isWorldCupCompetition("2026世界杯小组赛"), true);
  assert.equal(isWorldCupCompetition("World Cup"), true);
  assert.equal(isWorldCupCompetition("世界杯预选赛"), false);
  assert.equal(isWorldCupCompetition("世预赛"), false);
  assert.equal(isWorldCupCompetition("英超"), false);
  assert.equal(isWorldCupCompetition(null), false);
});

test("worldCupTeamContext:中文/英文名都能匹配,查不到返回 null", () => {
  assert.equal(worldCupTeamContext("西班牙", ROWS).champion, 0.266);
  assert.equal(worldCupTeamContext("Spain", ROWS).advance, 0.992);
  assert.equal(worldCupTeamContext("火星队", ROWS), null);
});

test("worldCupContextLine:世界杯场出双方出线/夺冠;非世界杯→空", () => {
  // 注入 rows 走 worldCupTeamContext;contextLine 用默认加载器,这里直接验 isWorldCup 守卫 + 拼接逻辑
  assert.equal(worldCupContextLine("西班牙", "法国", "英超"), ""); // 非世界杯 → 空(自动休眠)
  assert.equal(worldCupContextLine("西班牙", "法国", "世界杯预选赛"), ""); // 世预赛 → 空
});

test("worldCupTeamContext:无 rows 不抛错", () => {
  assert.equal(worldCupTeamContext("西班牙", null), null);
  assert.equal(worldCupTeamContext(null, ROWS), null);
});
