import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

const PRIOR = { home: 0.45, draw: 0.27, away: 0.28 };

describe("EE 档 P1 — travel + tactical 接入 signal-fusion-layer", () => {
  it("SIGNAL_NAMES 包含 travel-distance 和 tactical-matchup", () => {
    assert.ok(SIGNAL_NAMES.includes("travel-distance"));
    assert.ok(SIGNAL_NAMES.includes("tactical-matchup"));
  });

  it("travel-distance: 缺城市 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "travel-distance" && d.dormant === "no-city-coordinates"));
  });

  it("travel-distance: 同城(距离<100km)→ dormant 短途", () => {
    const context = {
      homeCity: { lat: 40, lon: -3, timezone: 1 },
      awayCity: { lat: 40.1, lon: -3.1, timezone: 1 }
    };
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    assert.ok(dormant.find((d) => d.name === "travel-distance" && d.dormant.startsWith("short-travel")));
  });

  it("travel-distance: 跨洋长途 → fired 利主胜", () => {
    const context = {
      homeCity: { lat: 51.5, lon: -0.1, timezone: 0 },   // London
      awayCity: { lat: -33.9, lon: 151.2, timezone: 11 } // Sydney
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "L", awayTeam: "S" }, {}, context);
    const ev = evidence.find((e) => e.name === "travel-distance");
    assert.ok(ev, "travel-distance 应 fire");
    assert.ok(ev.ratio.home > 1, "主胜 LR 应 > 1");
    assert.ok(ev.ratio.away < 1, "客胜 LR 应 < 1");
  });

  it("tactical-matchup: 缺阵型 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "tactical-matchup" && d.dormant === "no-formations"));
  });

  it("tactical-matchup: 有阵型缺 matchup 表 → dormant", () => {
    const context = { homeFormation: "4-3-3", awayFormation: "5-4-1" };
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    assert.ok(dormant.find((d) => d.name === "tactical-matchup" && d.dormant === "no-matchup-table"));
  });

  it("tactical-matchup: 阵型+matchup 表齐全 → fired", () => {
    const context = {
      homeFormation: "4-3-3",
      awayFormation: "5-4-1",
      formationMatchups: {
        "4-3-3::5-4-1": { total: 30, homeWinRate: 0.60, drawRate: 0.20, awayWinRate: 0.20 }
      },
      leagueBaseline: { homeWinRate: 0.45, drawRate: 0.27, awayWinRate: 0.28 }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, context);
    const ev = evidence.find((e) => e.name === "tactical-matchup");
    assert.ok(ev, "tactical-matchup 应 fire");
    assert.ok(ev.ratio.home > 1, "homeLift>1 应推高主胜 LR");
  });
});
