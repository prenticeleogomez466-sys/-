import { test } from "node:test";
import assert from "node:assert/strict";
import { h2hLens, recentFormLens, buildHistoricalLenses } from "../src/historical-lens.js";
import { canonicalTeamName } from "../src/team-aliases.js";

// 合成历史记录(形状对齐 loadHistoricalResults:带 homeCanon/awayCanon)。
function rec(date, home, away, hg, ag) {
  return { date, homeTeam: home, awayTeam: away, homeCanon: canonicalTeamName(home), awayCanon: canonicalTeamName(away), homeGoals: hg, awayGoals: ag };
}
// 用生僻名(别名表外→canonical=自身),避免与真实别名碰撞。
const A = "测试甲队FC", B = "测试乙队FC", C = "测试丙队FC";

test("h2hLens:交手<3 → available:false 不编造", () => {
  const hist = [rec("2025-01-01", A, B, 1, 0), rec("2025-02-01", B, A, 0, 0)];
  const r = h2hLens({ homeTeam: A, awayTeam: B }, hist);
  assert.equal(r.available, false);
  assert.ok(/不足/.test(r.note));
});

test("h2hLens:≥3 交手 → 当前主队视角 wld 归一 + 常见比分 + 场均进球", () => {
  // A 视角:主2-0胜、客(B主)1-2胜(A客胜)、主1-1平、主0-2负 → 2胜1平1负
  const hist = [
    rec("2025-01-01", A, B, 2, 0),  // A 主胜
    rec("2025-02-01", B, A, 1, 2),  // A 客胜
    rec("2025-03-01", A, B, 1, 1),  // 平
    rec("2025-04-01", A, B, 0, 2),  // A 主负(B 胜)
  ];
  const r = h2hLens({ homeTeam: A, awayTeam: B }, hist);
  assert.equal(r.available, true);
  assert.equal(r.n, 4);
  const s = r.wld.home + r.wld.draw + r.wld.away;
  assert.ok(Math.abs(s - 1) < 0.02, `wld 应归一, got ${s}`);
  assert.ok(r.wld.home > r.wld.away, "A 2胜1负应主胜率>客胜率(时间加权下仍成立)");
  assert.ok(Array.isArray(r.topScores) && r.topScores.length >= 1);
  assert.ok(Number.isFinite(r.avgGoals));
});

test("recentFormLens:双方近期 W/D/L → PPG 与倾向;一方缺则 available:false", () => {
  const hist = [
    rec("2025-05-01", A, C, 2, 0), rec("2025-05-08", A, C, 1, 0), rec("2025-05-15", C, A, 0, 3), // A 三连胜
    rec("2025-05-02", B, C, 0, 1), rec("2025-05-09", C, B, 1, 1), rec("2025-05-16", B, C, 0, 2), // B 两负一平
  ];
  const r = recentFormLens({ homeTeam: A, awayTeam: B }, hist);
  assert.equal(r.available, true);
  assert.ok(r.home.ppg > r.away.ppg, "A 状态应优于 B");
  assert.equal(r.lean, "home");
  // 客队无任何近期 → available:false(不编造倾向)
  const r2 = recentFormLens({ homeTeam: A, awayTeam: "无历史队X" }, hist);
  assert.equal(r2.available, false);
  assert.equal(r2.lean ?? null, null);
});

test("buildHistoricalLenses:空库 → available:false 不编造", () => {
  const r = buildHistoricalLenses({ homeTeam: A, awayTeam: B }, []);
  assert.equal(r.available, false);
  assert.equal(r.h2h.available, false);
  assert.equal(r.recentForm.available, false);
});

test("buildHistoricalLenses:有数据 → 聚合 h2h + 近期", () => {
  const hist = [
    rec("2025-01-01", A, B, 2, 0), rec("2025-02-01", B, A, 1, 2), rec("2025-03-01", A, B, 1, 1),
    rec("2025-05-01", A, C, 2, 0), rec("2025-05-08", A, C, 1, 0), rec("2025-05-15", C, A, 0, 3),
    rec("2025-05-02", B, C, 0, 1), rec("2025-05-09", C, B, 1, 1), rec("2025-05-16", B, C, 0, 2),
  ];
  const r = buildHistoricalLenses({ homeTeam: A, awayTeam: B }, hist);
  assert.equal(r.available, true);
  assert.equal(r.h2h.available, true);
  assert.equal(r.recentForm.available, true);
});
