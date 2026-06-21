// WC 专属校准反哺守护(2026-06-15):去重/gate/漂移闸/应用一致性。
//   2026-06-21 追加:loadWcCalibrationProfile 加载器契约 + 生产接线守护(防回退成 no-op)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dedupeSettledWc, buildWcCalibrationProfile, applyWcCalibration, loadWcCalibrationProfile } from "../src/wc-calibration-feedback.js";

function wcRow(match, score, settledAt, ph = 0.6, pd = 0.25, pa = 0.15) {
  return { match, competition: "世界杯", actual: "主胜", actualScore: score, settledAt,
    probabilityHome: ph, probabilityDraw: pd, probabilityAway: pa };
}

test("去重:同场多条重复推荐只留 settledAt 最新", () => {
  const rows = [
    wcRow("A 对 B", "2-0", "2026-06-10T00:00:00Z"),
    wcRow("A 对 B", "2-0", "2026-06-12T00:00:00Z"),
    wcRow("C 对 D", "1-1", "2026-06-11T00:00:00Z"),
  ];
  const out = dedupeSettledWc(rows);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.match === "A 对 B").settledAt, "2026-06-12T00:00:00Z");
});

test("去重:非WC/无概率/未结算行被排除", () => {
  const rows = [
    { match: "E 对 F", competition: "英超", actual: "主胜", actualScore: "1-0", probabilityHome: 0.6, probabilityDraw: 0.2, probabilityAway: 0.2 },
    { match: "G 对 H", competition: "世界杯", actualScore: "1-0", probabilityHome: 0.6, probabilityDraw: 0.2, probabilityAway: 0.2 }, // 无 actual
    wcRow("I 对 J", "2-1", "2026-06-10T00:00:00Z"),
  ];
  assert.equal(dedupeSettledWc(rows).length, 1);
});

test("gate:样本不足 → usable:false,且 applyWcCalibration bypass 不改概率", () => {
  const rows = Array.from({ length: 23 }, (_, i) => wcRow(`H${i} 对 A${i}`, "2-0", `2026-06-${10 + (i % 5)}T0${i % 9}:00:00Z`));
  const profile = buildWcCalibrationProfile(rows, { minSamples: 50 });
  assert.equal(profile.usable, false);
  assert.match(profile.reason, /样本不足/);
  const raw = { home: 0.6, draw: 0.25, away: 0.15 };
  const out = applyWcCalibration(raw, profile);
  assert.equal(out.applied, false);
  assert.equal(out.probabilities.home, 0.6); // 完全不变
});

test("样本充足 → usable:true + isotonicMap 建立", () => {
  // 构造 60 场:强热门(0.75)实际只中 ~60%(过度自信),供 isotonic 学习
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const hit = i % 5 < 3; // 60% 命中
    rows.push({ match: `T${i} 对 O${i}`, competition: "世界杯", actual: "主胜",
      actualScore: hit ? "2-0" : "0-1", settledAt: `2026-06-${10 + (i % 18)}T0${i % 9}:00:00Z`,
      probabilityHome: 0.75, probabilityDraw: 0.15, probabilityAway: 0.10 });
  }
  const profile = buildWcCalibrationProfile(rows, { minSamples: 50, minIsotonicSamples: 50 });
  assert.equal(profile.usable, true);
  assert.ok(profile.isotonicMap?.knots?.length >= 1);
  assert.equal(profile.samples, 60);
});

test("漂移闸:校准改动超 maxDriftBlock → 拒绝该场(bypass)", () => {
  // 人造 profile:把任何概率都映射到 0.99(极端漂移)
  const profile = { usable: true, samples: 99, isotonicMap: { knots: [{ predictedMin: 0, predictedMax: 1, calibrated: 0.99 }], samples: 99 } };
  const out = applyWcCalibration({ home: 0.6, draw: 0.25, away: 0.15 }, profile, { maxDriftBlock: 0.15 });
  assert.equal(out.applied, false);
  assert.equal(out.reason, "drift-block");
  assert.equal(out.probabilities.home, 0.6); // 原值
});

test("正常应用:小幅校准生效且归一", () => {
  const profile = { usable: true, samples: 99, isotonicMap: { knots: [{ predictedMin: 0, predictedMax: 1, calibrated: 0.66 }], samples: 99 } };
  const out = applyWcCalibration({ home: 0.6, draw: 0.25, away: 0.15 }, profile, { maxDriftBlock: 0.15 });
  assert.equal(out.applied, true);
  assert.ok(Math.abs(out.probabilities.home - 0.66) < 1e-9);
  const sum = out.probabilities.home + out.probabilities.draw + out.probabilities.away;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ── 2026-06-21 加载器契约:从 ledger 文件读已结算行构建档(对象/数组两种结构) ──
test("loadWcCalibrationProfile:从 ledger(对象结构)读够样本 → usable:true", () => {
  const dir = mkdtempSync(join(tmpdir(), "wccal-"));
  try {
    // ledger 真实结构=对象({0:row,1:row,...});造 55 场过门槛
    const obj = {};
    for (let i = 0; i < 55; i++) {
      obj[i] = { match: `T${i} 对 O${i}`, competition: "世界杯", actual: "主胜",
        actualScore: i % 5 < 3 ? "2-0" : "0-1", settledAt: `2026-06-${10 + (i % 18)}T0${i % 9}:00:00Z`,
        probabilityHome: 0.7, probabilityDraw: 0.18, probabilityAway: 0.12 };
    }
    const p = join(dir, "recommendation-ledger.json");
    writeFileSync(p, JSON.stringify(obj));
    const prof = loadWcCalibrationProfile({ path: p, minSamples: 50, minIsotonicSamples: 50 });
    assert.equal(prof.usable, true);
    assert.equal(prof.samples, 55);
    assert.ok(prof.isotonicMap?.knots?.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadWcCalibrationProfile:缺文件 → unusable(bypass·绝不兜底假数据)", () => {
  const prof = loadWcCalibrationProfile({ path: join(tmpdir(), "no-such-ledger-xyz.json"), minSamples: 50 });
  assert.equal(prof.usable, false);
  // 不抛、返回可被 applyWcCalibration 安全 bypass 的档
  const out = applyWcCalibration({ home: 0.6, draw: 0.25, away: 0.15 }, prof);
  assert.equal(out.applied, false);
  assert.equal(out.probabilities.home, 0.6);
});

// ── 接线守护(防回退):prediction-engine 必须把 wcCalibrationProfile 装配进 predictFixture options ──
//   背景:模块建于 2026-06-15 但 buildWcCalibrationProfile 从未被生产调用→恒 bypass;2026-06-21 接线。
//   若有人删掉接线,WC 反哺会静默变回 no-op——本守护直接抓住。
test("接线守护:recommendFixtures 经 loadWcCalibrationProfile 装配 wcCalibrationProfile 入 options", () => {
  const enginePath = fileURLToPath(new URL("../src/prediction-engine.js", import.meta.url));
  const src = readFileSync(enginePath, "utf8");
  assert.match(src, /loadWcCalibrationProfile/, "须 import+调用 loadWcCalibrationProfile");
  assert.match(src, /const\s+wcCalibrationProfile\s*=\s*loadWcCalibrationProfile\(/, "须在 recommendFixtures 构建 wcCalibrationProfile");
  // predictFixture options 字面量里须带 wcCalibrationProfile(否则恒 undefined→bypass)
  assert.match(src, /predictFixture\([^;]*\bwcCalibrationProfile\b/s, "predictFixture options 须传 wcCalibrationProfile");
});
