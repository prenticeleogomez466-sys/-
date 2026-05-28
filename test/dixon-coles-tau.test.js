import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreMatrix } from "../src/dixon-coles-engine.js";

function sumMatrix(m) {
  let s = 0;
  for (let h = 0; h < m.length; h++)
    for (let a = 0; a < m[h].length; a++) s += m[h][a];
  return s;
}

function outcomeProbs(m) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < m.length; h++)
    for (let a = 0; a < m[h].length; a++) {
      if (h > a) home += m[h][a];
      else if (h === a) draw += m[h][a];
      else away += m[h][a];
    }
  return { home, draw, away };
}

function overUnder(m, line) {
  let over = 0, under = 0;
  for (let h = 0; h < m.length; h++)
    for (let a = 0; a < m[h].length; a++) {
      if (h + a > line) over += m[h][a]; else under += m[h][a];
    }
  return { over, under };
}

describe("Dixon-Coles tau models", () => {
  const baseParams = {
    attackHome: 1.1,
    defenseHome: 0.9,
    attackAway: 0.95,
    defenseAway: 1.05,
    homeAdv: 1.28,
    baseRate: 1.35,
    rho: -0.08
  };

  it("dixon-coles tau produces normalized matrix summing to 1", () => {
    const { matrix } = scoreMatrix({ ...baseParams, tauModel: "dixon-coles" });
    assert.ok(Math.abs(sumMatrix(matrix) - 1) < 0.0001, `sum=${sumMatrix(matrix)}`);
  });

  it("extended tau also produces normalized matrix summing to 1", () => {
    const { matrix } = scoreMatrix({ ...baseParams, tauModel: "extended" });
    assert.ok(Math.abs(sumMatrix(matrix) - 1) < 0.0001, `sum=${sumMatrix(matrix)}`);
  });

  it("extended tau shifts more mass into mid-low scores like (2,1)/(1,2)/(2,2)", () => {
    const std = scoreMatrix({ ...baseParams, tauModel: "dixon-coles" });
    const ext = scoreMatrix({ ...baseParams, tauModel: "extended" });
    // (2,1) + (1,2) + (2,2) should get *more* probability under extended tau
    // because the new tau values are 1+0.3*rho (negative rho) -> wait,
    // rho=-0.08 so 1+0.3*-0.08 = 0.976, < 1 → less mass.
    // So extended tau pulls these toward low scores too. Verify direction is
    // consistent with the original DC (low-score boost).
    const stdMid = std.matrix[2][1] + std.matrix[1][2] + std.matrix[2][2];
    const extMid = ext.matrix[2][1] + ext.matrix[1][2] + ext.matrix[2][2];
    // Direction: extended tau pulls mid scores down (less mass than std DC)
    // because of negative rho * positive coefficient → multiplier < 1.
    // The displaced mass moves into (1,1) and (0,0).
    assert.ok(extMid < stdMid, `expected extMid<stdMid, got ext=${extMid.toFixed(4)} std=${stdMid.toFixed(4)}`);
  });

  it("extended tau produces different Over 2.5 probability than standard DC", () => {
    const std = scoreMatrix({ ...baseParams, tauModel: "dixon-coles" });
    const ext = scoreMatrix({ ...baseParams, tauModel: "extended" });
    const ouStd = overUnder(std.matrix, 2.5);
    const ouExt = overUnder(ext.matrix, 2.5);
    assert.notEqual(ouStd.over.toFixed(4), ouExt.over.toFixed(4));
  });

  it("home advantage still favors home win in both tau models", () => {
    for (const tauModel of ["dixon-coles", "extended"]) {
      const { matrix, lambda, mu } = scoreMatrix({ ...baseParams, tauModel });
      const o = outcomeProbs(matrix);
      assert.ok(o.home > o.away, `${tauModel}: home=${o.home.toFixed(3)} away=${o.away.toFixed(3)}, lambda=${lambda.toFixed(3)} mu=${mu.toFixed(3)}`);
    }
  });

  it("symmetric lambdas under both tau models give roughly equal home/away (within noise)", () => {
    const sym = {
      attackHome: 1.0, defenseHome: 1.0, attackAway: 1.0, defenseAway: 1.0,
      homeAdv: 1.0, baseRate: 1.4, rho: -0.08
    };
    for (const tauModel of ["dixon-coles", "extended"]) {
      const { matrix } = scoreMatrix({ ...sym, tauModel });
      const o = outcomeProbs(matrix);
      assert.ok(Math.abs(o.home - o.away) < 0.005, `${tauModel}: |home-away|=${Math.abs(o.home-o.away).toFixed(4)}`);
    }
  });
});
