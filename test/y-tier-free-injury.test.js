import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFplInjuries, fetchFplInjuries, injuriesForFixture } from "../src/free-injury-source.js";
import { fuseSignals } from "../src/signal-fusion-layer.js";

// 最小 FPL bootstrap mock
function bootstrap() {
  return {
    teams: [{ id: 1, name: "Liverpool" }, { id: 2, name: "Man Utd" }, { id: 3, name: "Chelsea" }],
    elements: [
      { web_name: "Salah", team: 1, element_type: 4, status: "i", chance_of_playing_next_round: 0, now_cost: 130, news: "Knock" }, // 身价高 star 全缺
      { web_name: "Doubtful", team: 1, element_type: 3, status: "d", chance_of_playing_next_round: 50, now_cost: 80, news: "50%" }, // 半缺
      { web_name: "Available", team: 1, element_type: 2, status: "a", chance_of_playing_next_round: null, now_cost: 60, news: "" }, // 可用,排除
      { web_name: "Transferred", team: 2, element_type: 4, status: "u", chance_of_playing_next_round: 0, now_cost: 70, news: "joined Barca" }, // 转会 u,排除
      { web_name: "Keeper", team: 3, element_type: 1, status: "s", chance_of_playing_next_round: 0, now_cost: 55, news: "Red card" } // 停赛 GK
    ]
  };
}

test("normalizeFplInjuries:只取 i/d/s,排除 a 与转会 u,位置/重要性/chance 折算正确", () => {
  const res = normalizeFplInjuries(bootstrap());
  // Liverpool 应有 Salah(全缺)+ Doubtful(半缺),Available 被排除
  const liv = res.byTeam["利物浦"];
  assert.ok(liv, "利物浦应有伤停");
  assert.equal(liv.length, 2);
  const salah = liv.find((p) => p.name === "Salah");
  assert.equal(salah.position, "ST", "FWD→ST");
  assert.equal(salah.role, "star", "身价 130 + 全缺 → star");
  assert.ok(salah.importance >= 0.85);
  const doubt = liv.find((p) => p.name === "Doubtful");
  assert.ok(doubt.importance < salah.importance, "50% 疑似应折算后重要性更低");

  // Man Utd 的转会 u 被排除 → 无键
  assert.equal(res.byTeam["曼联"], undefined, "转会 u 不计入伤停");
  // Chelsea 停赛 GK 计入
  assert.equal(res.byTeam["切尔西"][0].position, "GK");
});

test("injuriesForFixture:按 canonical 队名装出 {home,away}", () => {
  const { byTeam } = normalizeFplInjuries(bootstrap());
  const layer = injuriesForFixture({ homeTeam: "利物浦", awayTeam: "切尔西" }, byTeam);
  assert.ok(layer);
  assert.equal(layer.home.length, 2);
  assert.equal(layer.away.length, 1);
  // 双方都无伤停 → null
  assert.equal(injuriesForFixture({ homeTeam: "阿森纳", awayTeam: "埃弗顿" }, byTeam), null);
});

test("fuseSignals:注入 FPL 伤停后 injury 信号激活并产方向性 LR", () => {
  const { byTeam } = normalizeFplInjuries(bootstrap());
  const fixture = { id: "y1", homeTeam: "利物浦", awayTeam: "切尔西", competition: "英超", date: "2026-05-30" };
  const layer = injuriesForFixture(fixture, byTeam);
  const prior = { home: 0.45, draw: 0.28, away: 0.27 };
  const res = fuseSignals(prior, fixture, {}, { injuries: layer });
  const fired = res.evidence.find((e) => e.name === "injury");
  assert.ok(fired, "注入伤停后 injury 信号应 fire");
  // 主队(利物浦)伤停净损失更大(Salah star)→ 利客队 → away LR > home LR
  assert.ok(fired.ratio.away >= fired.ratio.home, "主队损失更重应利客队");
});

test("fetchFplInjuries:网络失败安全返回 ok:false", async () => {
  const res = await fetchFplInjuries({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal(res.ok, false);
  assert.match(res.reason, /FPL/);
});
