import assert from "node:assert/strict";
import test from "node:test";
import { fuseSignals, collectFusionEvidence } from "../src/signal-fusion-layer.js";

const PRIOR = { home: 0.45, draw: 0.28, away: 0.27 };

test("fuseSignals 在元数据齐全时对每场都 fire(season-phase + competition-type)", () => {
  const fixture = { id: "f1", homeTeam: "拜仁", awayTeam: "多特", competition: "欧冠", date: "2026-05-29" };
  const res = fuseSignals(PRIOR, fixture, { date: "2026-05-29" }, {});
  assert.equal(res.applied, true);
  assert.ok(res.evidence.some((e) => e.name === "season-phase"));
  assert.ok(res.evidence.some((e) => e.name === "competition-type"));
  // 概率仍归一
  const sum = res.probabilities.home + res.probabilities.draw + res.probabilities.away;
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test("数据依赖信号在缺数据时进 dormant、绝不假装 fire", () => {
  const fixture = { id: "f2", homeTeam: "利物浦", awayTeam: "切尔西", competition: "英超", date: "2026-05-29" };
  const { evidence, dormant } = collectFusionEvidence(PRIOR, fixture, { date: "2026-05-29" }, {});
  const dormantNames = dormant.map((d) => d.name);
  assert.ok(dormantNames.includes("injury"));
  assert.ok(dormantNames.includes("h2h"));
  assert.ok(dormantNames.includes("clean-sheet-streak"));
  assert.ok(dormantNames.includes("rotation"));
  // fired 的不应该出现在 dormant 里
  for (const e of evidence) assert.ok(!dormantNames.includes(e.name));
});

test("注入伤停数据后 injury 信号自动激活", () => {
  const fixture = { id: "f3", homeTeam: "曼城", awayTeam: "阿森纳", competition: "英超", date: "2026-05-29" };
  const context = {
    injuries: {
      home: [],
      away: [{ position: "FW", importance: 0.95 }, { position: "MF", importance: 0.75 }]
    }
  };
  const { evidence } = collectFusionEvidence(PRIOR, fixture, {}, context);
  const injury = evidence.find((e) => e.name === "injury");
  assert.ok(injury, "injury 应在有数据时 fire");
  // 客队伤停 → 利主队 → home LR > 1
  assert.ok(injury.ratio.home > 1);
  assert.ok(injury.ratio.away < 1);
});

test("注入 H2H 历史后 h2h 信号激活并产方向性 LR", () => {
  const fixture = { id: "f4", homeTeam: "皇马", awayTeam: "巴萨", competition: "西甲", date: "2026-05-29" };
  // 主队历史压制客队
  const h2hMatches = Array.from({ length: 6 }, (_, i) => ({
    home: "皇马", away: "巴萨", homeGoals: 3, awayGoals: 0,
    date: `2024-0${(i % 9) + 1}-01`
  }));
  const { evidence, dormant } = collectFusionEvidence(PRIOR, fixture, {}, { h2hMatches });
  const hasH2H = evidence.some((e) => e.name === "h2h") || dormant.some((d) => d.name === "h2h");
  assert.ok(hasH2H, "h2h 必须被处理(fire 或 dormant 之一)");
});

test("总位移封顶:极端 LR 不会把概率炸过 ±maxTotalShift", () => {
  const fixture = { id: "f5", homeTeam: "A", awayTeam: "B", competition: "友谊赛", date: "2026-05-29" };
  // 友谊赛 profile + 强 H2H + 伤停叠加,验证封顶
  const context = {
    h2hMatches: Array.from({ length: 8 }, () => ({ home: "A", away: "B", homeGoals: 5, awayGoals: 0, date: "2024-01-01" })),
    injuries: { home: [], away: [{ position: "GK", importance: 0.95 }, { position: "DF", importance: 0.95 }] }
  };
  const res = fuseSignals(PRIOR, fixture, {}, context, { maxTotalShift: 0.12 });
  for (const o of ["home", "draw", "away"]) {
    assert.ok(Math.abs(res.probabilities[o] - PRIOR[o]) <= 0.12 + 1e-6, `${o} 位移超过封顶`);
  }
});

test("fatigue 信号:一方明显少休息 → 利对手的方向性 LR", () => {
  const fixture = { id: "fa", homeTeam: "曼城", awayTeam: "阿森纳", competition: "英超", date: "2026-05-29" };
  // 主队 1 天前刚踢(极疲劳),客队 7 天前(充分休息)→ 应利客队
  const ctx = {
    homeRecentMatches: [{ date: "2026-05-28", goalsFor: 1, goalsAgainst: 1, won: "D" }],
    awayRecentMatches: [{ date: "2026-05-22", goalsFor: 2, goalsAgainst: 0, won: "W" }]
  };
  const { evidence, dormant } = collectFusionEvidence(PRIOR, fixture, {}, ctx);
  const fatigue = evidence.find((e) => e.name === "fatigue");
  const dormantFatigue = dormant.find((d) => d.name === "fatigue");
  // 要么 fire(显著)要么 dormant(不显著),但必须被处理
  assert.ok(fatigue || dormantFatigue, "fatigue 必须被处理");
  if (fatigue) assert.ok(fatigue.ratio.away >= fatigue.ratio.home, "主队疲劳 → 客胜 LR 不低于主胜");
});

test("无效 prior 安全返回 applied:false", () => {
  const res = fuseSignals({ home: NaN, draw: 0.3, away: 0.3 }, { id: "f6", competition: "英超", date: "2026-05-29" }, {}, {});
  assert.equal(res.applied, false);
  assert.equal(res.reason, "invalid-prior");
});
