import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuseSignals, collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

const PRIOR = { home: 0.45, draw: 0.27, away: 0.28 };

describe("EE 档 — P0 五件套接入 signal-fusion-layer", () => {
  it("SIGNAL_NAMES 包含全部 P0 五件套", () => {
    for (const name of ["weather", "manager", "derby", "standings-pressure", "big-game-form"]) {
      assert.ok(SIGNAL_NAMES.includes(name), `SIGNAL_NAMES 缺 ${name}`);
    }
  });

  it("weather: 无数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "weather" && d.dormant === "no-weather-data"));
  });

  it("weather: 暴雨大风 → fired,平局率上升", () => {
    const context = { weather: { precipitation: 10, windSpeed10m: { avg: 40 }, temperature: 12 } };
    const { evidence, dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    const ev = evidence.find((e) => e.name === "weather");
    assert.ok(ev, "weather 应 fire");
    assert.ok(ev.ratio.draw > 1, "平局 LR 应 > 1");
  });

  it("manager: 双 null → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "manager"));
  });

  it("manager: 主队 elite + 客队 below-average → fired,利主胜", () => {
    const context = {
      homeManagerProfile: { tier: "elite" },
      awayManagerProfile: { tier: "below-average" },
      homeTenureMatches: 30,
      awayTenureMatches: 30
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    const ev = evidence.find((e) => e.name === "manager");
    assert.ok(ev, "manager 应 fire");
    assert.ok(ev.ratio.home > 1, "主胜 LR 应 > 1");
    assert.ok(ev.ratio.away < 1, "客胜 LR 应 < 1");
  });

  it("derby: 普通对阵 → dormant(not-a-derby)", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "Some Team", awayTeam: "Another" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "derby" && d.dormant === "not-a-derby"));
  });

  it("derby: 同城 distanceKm=10 → fired,平局率上升", () => {
    const { evidence } = collectFusionEvidence(
      PRIOR,
      { homeTeam: "City A", awayTeam: "City B" },
      {},
      { distanceKm: 10 }
    );
    const ev = evidence.find((e) => e.name === "derby");
    assert.ok(ev, "derby 应 fire");
    assert.ok(ev.ratio.draw > 1, "derby 平局 LR 应 > 1");
  });

  it("standings-pressure: 无数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "standings-pressure"));
  });

  it("standings-pressure: 主保级 vs 客已锁定 → 利主胜", () => {
    const context = {
      homeStandings: { position: 18, totalTeams: 20, points: 28, relegationLine: 30, remainingMatches: 4 },
      awayStandings: { position: 1, totalTeams: 20, points: 85, leaderPoints: 60, remainingMatches: 4 }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    const ev = evidence.find((e) => e.name === "standings-pressure");
    assert.ok(ev, "standings-pressure 应 fire");
    assert.ok(ev.ratio.home > 1, "保级主队拼命 LR 应 > 1");
  });

  it("big-game-form: 缺 bigGameDataAvailable → dormant", () => {
    const context = {
      homeFormProfile: { allPpm: 1.5 },  // 无 bigGameDataAvailable
      awayFormProfile: { allPpm: 1.6 }
    };
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    assert.ok(dormant.find((d) => d.name === "big-game-form" && d.dormant === "no-big-game-data"));
  });

  it("big-game-form: 主队 strong + 客队 choker → fired,利主胜", () => {
    const context = {
      homeFormProfile: { bigGameDataAvailable: true, readinessFactor: 0.5, bigGamePpm: 2.0, bigGameSamples: 6 },
      awayFormProfile: { bigGameDataAvailable: true, readinessFactor: -0.5, bigGamePpm: 0.8, bigGameSamples: 6 }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    const ev = evidence.find((e) => e.name === "big-game-form");
    assert.ok(ev, "big-game-form 应 fire");
    assert.ok(ev.ratio.home > 1, "主队 strong 应 LR home > 1");
  });

  it("fuseSignals 端到端:多信号同 fire,概率被融合且和=1", () => {
    const context = {
      weather: { precipitation: 8, windSpeed10m: { avg: 35 } },
      homeManagerProfile: { tier: "elite" },
      awayManagerProfile: { tier: "neutral" },
      homeTenureMatches: 50,
      awayTenureMatches: 50,
      homeStandings: { position: 1, totalTeams: 20, points: 70, leaderPoints: 68, remainingMatches: 4 },
      awayStandings: { position: 19, totalTeams: 20, points: 25, relegationLine: 28, remainingMatches: 4 }
    };
    const res = fuseSignals(PRIOR, { homeTeam: "X", awayTeam: "Y", date: "2026-05-29" }, {}, context);
    assert.equal(res.applied, true, "应该有信号 fire");
    const sum = res.probabilities.home + res.probabilities.draw + res.probabilities.away;
    assert.ok(Math.abs(sum - 1) < 0.01, `归一和应 ≈ 1,得到 ${sum}`);
    assert.ok(res.evidence.length >= 2, "至少 2 条 evidence");
  });
});
