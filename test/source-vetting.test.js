import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSourceVettingReport } from "../src/source-vetting.js";

test("source vetting keeps only lawful production sources accepted", () => {
  const report = buildSourceVettingReport("2099-01-01");
  assert.equal(report.ok, true);
  assert.ok(report.sources.some((source) => source.name.includes("500") && source.decision === "accepted"));
  assert.ok(report.sources.some((source) => source.decision === "rejected-by-default"));
  assert.ok(report.sources.every((source) => source.modelValue && source.caveat));
});
