import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapPredictionWithEvidence, wrapAllWithEvidence, detectEvidenceDisagreement } from "../src/prediction-engine-evidence-bridge.js";
import { picksFromScore, picksFromWld, auditPredictionConsistency, reconcileBatch } from "../src/consistency-guard.js";
import { formatEnrichmentCell, formatEvidenceList, buildEnrichmentRow, evidenceColumnHeaders, enrichmentRowToArray } from "../src/xlsx-evidence-formatter.js";
import { summarizeDailyEvidence } from "../src/daily-evidence-summary.js";

describe("prediction-engine-evidence-bridge", () => {
  it("wraps prediction without evidence when context empty", () => {
    const pred = { pick: { code: "3", outcome: "home" }, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } };
    const r = wrapPredictionWithEvidence(pred, {});
    assert.equal(r.evidenceView.evidenceCount, 0);
  });

  it("blends bayesian posterior into final probabilities", () => {
    const pred = { pick: { code: "3", outcome: "home" }, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } };
    const ctx = {
      fixture: { homeTeam: "Manchester United", awayTeam: "Manchester City" },
      homeRecent: [{ won: "W" }, { won: "W" }, { won: "W" }, { won: "W" }]
    };
    const r = wrapPredictionWithEvidence(pred, ctx);
    assert.ok(r.evidenceView.evidenceCount >= 1);
    assert.ok(r.evidenceView.finalRecommendedProbabilities);
  });

  it("detectEvidenceDisagreement compares argmax", () => {
    const pred = {
      probabilities: { home: 0.5, draw: 0.3, away: 0.2 },
      evidenceView: { bayesianPosterior: { home: 0.3, draw: 0.4, away: 0.3 } }
    };
    const d = detectEvidenceDisagreement(pred);
    assert.equal(d.agree, false);
    assert.equal(d.mainArgmax, "home");
    assert.equal(d.bayesArgmax, "draw");
  });

  it("wrapAllWithEvidence batch processes", () => {
    const preds = [
      { pick: { code: "3", outcome: "home" }, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } },
      { pick: { code: "0", outcome: "away" }, probabilities: { home: 0.2, draw: 0.3, away: 0.5 } }
    ];
    const wrapped = wrapAllWithEvidence(preds, () => ({}));
    assert.equal(wrapped.length, 2);
    assert.ok(wrapped[0].evidenceView);
  });
});

describe("consistency-guard", () => {
  it("picksFromScore 1-0 → wld=主胜, handicap=平", () => {
    const r = picksFromScore("1-0", { handicapLine: -1 });
    assert.equal(r.ok, true);
    assert.equal(r.wld, "主胜");
    assert.equal(r.handicap.direction, "平局");
  });

  it("picksFromScore 0-0 → wld=平局, handicap=客胜(让-1)", () => {
    const r = picksFromScore("0-0", { handicapLine: -1 });
    assert.equal(r.wld, "平局");
    assert.equal(r.handicap.direction, "客胜");
  });

  it("picksFromScore with halfFull odds returns consistent half-full", () => {
    const r = picksFromScore("2-0", {
      handicapLine: -2,
      halfFullOdds: { "胜胜": 1.5, "平胜": 3.7, "胜平": 30 }
    });
    assert.equal(r.halfFull.label, "胜胜");
  });

  it("picksFromScore rejects invalid score", () => {
    const r = picksFromScore("invalid");
    assert.equal(r.ok, false);
  });

  it("picksFromWld picks best score matching wld", () => {
    const r = picksFromWld("主胜", {
      allScoresOdds: { "1-0": 5.5, "2-0": 6.0, "0-0": 11.5, "1-1": 7.0 },
      handicapLine: -1,
      halfFullOdds: { "胜胜": 2.0, "平胜": 3.9 }
    });
    assert.equal(r.ok, true);
    assert.equal(r.score, "1-0");
  });

  it("auditPredictionConsistency catches mismatches", () => {
    const pred = {
      scorePicks: { primary: "1-0" },
      pick: { label: "客胜" },  // 跟比分矛盾
      halfFullPicks: { primary: "胜胜" }
    };
    const a = auditPredictionConsistency(pred);
    assert.equal(a.ok, false);
    assert.ok(a.errors.length >= 1);
  });

  it("reconcileBatch fixes inconsistencies", () => {
    const preds = [
      { scorePicks: { primary: "1-0" }, pick: { label: "客胜" } }
    ];
    const r = reconcileBatch(preds, () => ({ handicapLine: -1 }));
    assert.equal(r[0].consistency.ok, false);
    assert.ok(r[0].reconciled);
    assert.equal(r[0].reconciled.wld, "主胜");
  });
});

describe("xlsx-evidence-formatter", () => {
  it("formatEnrichmentCell returns emoji + factors", () => {
    const e = { confidence: "strong-signal", supportingFactors: ["a", "b"], riskFactors: [] };
    const cell = formatEnrichmentCell(e);
    assert.ok(cell.includes("✅"));
    assert.ok(cell.includes("strong-signal"));
  });

  it("formatEvidenceList truncates to max", () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push({ name: `ev${i}`, source: "streak-home" });
    const text = formatEvidenceList(list, { max: 3 });
    const lines = text.split("\n");
    assert.equal(lines.length, 3);
  });

  it("buildEnrichmentRow extracts evidenceView fields", () => {
    const pred = {
      evidenceView: {
        evidenceCount: 5,
        enrichment: { confidence: "moderate-signal", supportingFactors: ["a"], riskFactors: ["b"] },
        bayesianPosterior: { home: 0.5, draw: 0.3, away: 0.2 },
        finalRecommendedProbabilities: { home: 0.45, draw: 0.32, away: 0.23 },
        evidenceList: []
      }
    };
    const r = buildEnrichmentRow(pred);
    assert.equal(r.evidenceCount, 5);
    assert.equal(r.confidence, "moderate-signal");
    assert.equal(r.bayesianPosteriorHome, 0.5);
  });

  it("enrichmentRowToArray matches headers length", () => {
    const headers = evidenceColumnHeaders();
    const arr = enrichmentRowToArray(null);
    assert.equal(arr.length, headers.length);
  });
});

describe("daily-evidence-summary", () => {
  it("rejects empty predictions", () => {
    const r = summarizeDailyEvidence([]);
    assert.equal(r.ok, false);
  });

  it("aggregates confidence distribution + top sources", () => {
    const preds = [
      {
        probabilities: { home: 0.5, draw: 0.3, away: 0.2 },
        evidenceView: {
          enrichment: { confidence: "strong-signal", supportingFactors: ["a"], riskFactors: [] },
          evidenceList: [{ source: "streak-home", name: "a" }, { source: "derby", name: "b" }]
        }
      },
      {
        probabilities: { home: 0.4, draw: 0.3, away: 0.3 },
        evidenceView: {
          enrichment: { confidence: "moderate-signal", supportingFactors: [], riskFactors: [] },
          evidenceList: [{ source: "streak-home", name: "c" }]
        }
      }
    ];
    const r = summarizeDailyEvidence(preds);
    assert.equal(r.ok, true);
    assert.equal(r.totalPredictions, 2);
    assert.equal(r.strongSignalCount, 1);
    // streak-home 出现 2 次 → 第一
    const top = r.topEvidenceSources[0];
    assert.equal(top.source, "streak-home");
  });

  it("detects main vs bayes disagreements", () => {
    const preds = [
      {
        fixture: { id: "f1" },
        probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
        evidenceView: {
          enrichment: { confidence: "weak-signal", supportingFactors: [], riskFactors: [] },
          bayesianPosterior: { home: 0.25, draw: 0.30, away: 0.45 },
          evidenceList: []
        }
      }
    ];
    const r = summarizeDailyEvidence(preds);
    assert.equal(r.mainVsBayesDisagreements.length, 1);
  });
});
