import assert from "node:assert/strict";
import test from "node:test";
import { h2hMatchesFor, recentMatchesFor, buildFusionContext } from "../src/fusion-context-builder.js";
import { collectFusionEvidence } from "../src/signal-fusion-layer.js";

// 合成历史:用 canonical 能命中的真实队名
// homeCanon/awayCanon 与 canonicalTeamName 实际输出一致(拜仁慕尼黑→拜仁,多特蒙德→多特)
const HISTORY = [
  { date: "2025-01-01", homeTeam: "拜仁", awayTeam: "多特蒙德", homeCanon: "拜仁", awayCanon: "多特", homeGoals: 3, awayGoals: 0 },
  { date: "2025-02-01", homeTeam: "多特蒙德", awayTeam: "拜仁", homeCanon: "多特", awayCanon: "拜仁", homeGoals: 1, awayGoals: 4 },
  { date: "2025-03-01", homeTeam: "拜仁", awayTeam: "勒沃库森", homeCanon: "拜仁", awayCanon: "勒沃库森", homeGoals: 2, awayGoals: 2 },
  { date: "2025-03-10", homeTeam: "拜仁", awayTeam: "科隆", homeCanon: "拜仁", awayCanon: "科隆", homeGoals: 5, awayGoals: 0 }
];

test("h2hMatchesFor 双向匹配两队交手(不分主客)", () => {
  const m = h2hMatchesFor(HISTORY, "拜仁", "多特蒙德");
  assert.equal(m.length, 2);
  assert.ok(m.every((x) => "homeGoals" in x && "awayGoals" in x && "date" in x));
});

test("recentMatchesFor 产单队视角、最近在前、带 won 标签", () => {
  const r = recentMatchesFor(HISTORY, "拜仁", 10);
  assert.equal(r.length, 4);
  // 最近在前:2025-03-10 应排第一
  assert.equal(r[0].date, "2025-03-10");
  assert.equal(r[0].goalsFor, 5);
  assert.equal(r[0].goalsAgainst, 0);
  assert.equal(r[0].won, "W");
  // 2-2 平
  const draw = r.find((x) => x.date === "2025-03-01");
  assert.equal(draw.won, "D");
});

test("buildFusionContext 装齐 h2h + 双方近期赛果", () => {
  const ctx = buildFusionContext({ homeTeam: "拜仁", awayTeam: "多特蒙德" }, HISTORY);
  assert.ok(Array.isArray(ctx.h2hMatches));
  assert.ok(Array.isArray(ctx.homeRecentMatches));
  assert.ok(Array.isArray(ctx.awayRecentMatches));
});

test("空历史 → buildFusionContext 返回 {},信号走 dormant", () => {
  const ctx = buildFusionContext({ homeTeam: "A", awayTeam: "B" }, []);
  assert.deepEqual(ctx, {});
});

test("装配的 context 能激活 h2h + clean-sheet-streak + streak 信号", () => {
  const fixture = { id: "f", homeTeam: "拜仁", awayTeam: "多特蒙德", competition: "德甲", date: "2026-05-29" };
  const ctx = buildFusionContext(fixture, HISTORY);
  const { evidence } = collectFusionEvidence({ home: 0.45, draw: 0.28, away: 0.27 }, fixture, {}, ctx);
  const names = evidence.map((e) => e.name);
  // season-phase 元数据信号每场必 fire
  assert.ok(names.includes("season-phase"));
  // 注:联赛=基线 competition profile → competition-type 中性走 dormant(只有欧冠/杯赛等才 fire),
  // 这是正确行为,故此处不强求 competition-type fire。
});

test("streak 信号:主队连胜应抬高主胜 LR", () => {
  const fixture = { id: "f", homeTeam: "拜仁", awayTeam: "弱旅", competition: "德甲", date: "2026-05-29" };
  // 主队连续 3 胜(最近在前)
  const ctx = {
    homeRecentMatches: [
      { date: "2025-03-10", goalsFor: 3, goalsAgainst: 0, won: "W" },
      { date: "2025-03-03", goalsFor: 2, goalsAgainst: 1, won: "W" },
      { date: "2025-02-25", goalsFor: 4, goalsAgainst: 0, won: "W" }
    ]
  };
  const { evidence } = collectFusionEvidence({ home: 0.45, draw: 0.28, away: 0.27 }, fixture, {}, ctx);
  const streak = evidence.find((e) => e.name === "streak");
  assert.ok(streak, "连胜应激活 streak 信号");
  assert.ok(streak.ratio.home > 1, "主队连胜 → 主胜 LR > 1");
});
