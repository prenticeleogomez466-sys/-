// 回归守护(2026-06-07):红队自检 redTeamCheck 必须在叙述生成 analyzeMatch 之前跑。
// 背景:证伪揪出 bug——叙述里的「信心 X」固化了红队下调「之前」的旧值,与顶层 prediction.confidence
//   不一致(高 10~15pp,显得比真实更自信)。根因=analyzeMatch(拼叙述、读 prediction.confidence)
//   原先排在 redTeamCheck(下调 confidence)之前。修复=把 redTeamCheck 前移。本测试钉死该顺序。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redTeamCheck } from "../src/prediction-engine.js";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/prediction-engine.js"), "utf8");

test("redTeamCheck 必须在叙述生成 analyzeMatch 之前调用(叙述信心才用下调后的终值)", () => {
  const iRed = SRC.indexOf("redTeamCheck(prediction, {");
  const iAna = SRC.indexOf("analyzeMatch(prediction)");
  assert.ok(iRed > 0, "应存在 redTeamCheck(prediction, {…) 调用");
  assert.ok(iAna > 0, "应存在 analyzeMatch(prediction) 调用");
  assert.ok(iRed < iAna, "redTeamCheck 必须在 analyzeMatch 之前——否则叙述固化红队下调前的旧信心");
});

test("redTeamCheck 单一来源无市场印证 → 下调信心 10pp(叙述须反映此终值)", () => {
  const pred = { confidence: 70, pick: { code: "3" }, riskNotes: [] };
  redTeamCheck(pred, { blendSource: "dixon-coles-only", hasMarketPrior: false });
  assert.equal(pred.confidence, 60, "单一来源无市场印证应下调 10pp 到 60");
  assert.equal(pred.redTeam.confidenceDelta, -10);
});

test("redTeamCheck 单一来源 + 类比反向 → 叠加下调 15pp", () => {
  const pred = { confidence: 71.56, pick: { code: "3" }, riskNotes: [] };
  // analog 主推客胜(away 最高)与 pick.code=3(主胜)反向 → 再 -5
  redTeamCheck(pred, {
    blendSource: "dixon-coles-only",
    hasMarketPrior: false,
    analogWld: { home: 0.2, draw: 0.3, away: 0.5 },
  });
  assert.equal(Math.round(pred.confidence * 100) / 100, 56.56, "应下调 15pp 到 56.56");
  assert.equal(pred.redTeam.confidenceDelta, -15);
});
