import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

const PRIOR = { home: 0.45, draw: 0.27, away: 0.28 };

describe("EE 档 P2 — 余下 5 个孤儿接入 signal-fusion-layer", () => {
  it("SIGNAL_NAMES 包含 referee/opponent-strength-form/xg-chains/padj-xg/set-piece", () => {
    for (const n of ["referee", "opponent-strength-form", "xg-chains", "padj-xg", "set-piece"]) {
      assert.ok(SIGNAL_NAMES.includes(n), `SIGNAL_NAMES 缺 ${n}`);
    }
  });

  it("referee: 缺 profile 或 baseline → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "referee" && d.dormant === "no-referee-or-baseline"));
  });

  it("referee: profile + baseline 偏主胜 → fired", () => {
    const ctx = {
      refereeProfile: { homeWinRate: 0.55, drawRate: 0.25, awayWinRate: 0.20, matches: 30 },
      leagueBaseline: { homeWinRate: 0.45, drawRate: 0.27, awayWinRate: 0.28 }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "referee");
    assert.ok(ev, "referee 应 fire");
  });

  it("opponent-strength-form: 缺 Elo-tagged 近期赛 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "opponent-strength-form"));
  });

  it("opponent-strength-form: 主队赢强敌 vs 客队赢弱队 → fired 利主胜", () => {
    const ctx = {
      homeRecentMatchesWithElo: [
        { result: "W", goalDiff: 1, opponentElo: 1900 },
        { result: "W", goalDiff: 2, opponentElo: 1850 },
        { result: "D", goalDiff: 0, opponentElo: 1800 }
      ],
      awayRecentMatchesWithElo: [
        { result: "W", goalDiff: 3, opponentElo: 1100 },
        { result: "W", goalDiff: 2, opponentElo: 1150 },
        { result: "W", goalDiff: 4, opponentElo: 1000 }
      ]
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "opponent-strength-form");
    assert.ok(ev, "opponent-strength-form 应 fire");
    assert.ok(ev.ratio.home > 1, "主队 adjusted form 更高 → LR home > 1");
  });

  it("xg-chains: 缺 event 数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "xg-chains"));
  });

  it("xg-chains: 主队 chain xG 显著高 → fired 利主胜", () => {
    const buildMatches = (xg) => [
      { events: [{ isShot: true, xg, chainLength: 4, completedPasses: 3 }] },
      { events: [{ isShot: true, xg, chainLength: 4, completedPasses: 3 }] },
      { events: [{ isShot: true, xg, chainLength: 4, completedPasses: 3 }] }
    ];
    const ctx = {
      homeChainEvents: buildMatches(2.0),
      awayChainEvents: buildMatches(0.5)
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "xg-chains");
    assert.ok(ev, "xg-chains 应 fire");
    assert.ok(ev.ratio.home > 1);
  });

  it("padj-xg: 缺 possession 数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "padj-xg"));
  });

  it("padj-xg: 主队 PADJ-xG 净优势 → fired 利主胜", () => {
    const ctx = {
      homePossMatches: [
        { xgFor: 2.0, xgAgainst: 0.5, possession: 60 },
        { xgFor: 1.8, xgAgainst: 0.7, possession: 58 },
        { xgFor: 2.2, xgAgainst: 0.5, possession: 62 }
      ],
      awayPossMatches: [
        { xgFor: 0.5, xgAgainst: 1.8, possession: 45 },
        { xgFor: 0.4, xgAgainst: 2.0, possession: 42 },
        { xgFor: 0.6, xgAgainst: 1.5, possession: 48 }
      ]
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "padj-xg");
    assert.ok(ev, "padj-xg 应 fire");
    assert.ok(ev.ratio.home > 1);
  });

  it("set-piece: 缺进球分类数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "set-piece"));
  });

  it("set-piece: 双方定位球专家 → fired 平局率下降", () => {
    const buildGoals = (n, sp) => {
      const list = [];
      for (let i = 0; i < Math.floor(n * sp); i++) list.push({ team: "A", type: "corner" });
      for (let i = 0; i < Math.floor(n * (1 - sp)); i++) list.push({ team: "A", type: "open" });
      return list;
    };
    const buildGoalsB = (n, sp) => {
      const list = [];
      for (let i = 0; i < Math.floor(n * sp); i++) list.push({ team: "B", type: "corner" });
      for (let i = 0; i < Math.floor(n * (1 - sp)); i++) list.push({ team: "B", type: "open" });
      return list;
    };
    const ctx = {
      homeGoalsByType: buildGoals(20, 0.4),
      awayGoalsByType: buildGoalsB(20, 0.4)
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "set-piece");
    assert.ok(ev, "set-piece 应 fire");
    assert.ok(ev.ratio.draw < 1, "高 set-piece 比例 → draw LR < 1");
  });
});
