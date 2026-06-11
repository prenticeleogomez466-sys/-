// 启动自检守护(2026-06-11 用户裁决:所有生成入口启动时都加一遍自检,红=拒跑)。
// 拦两处:①五个生成入口必须接 preflightOrDie(被摘=红);②自检模块本身的窗口判定/返回形状不回归。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inWorldCupWindow, runPreflight } from "../src/preflight-selfcheck.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(join(rootDir, ...p), "utf8");

describe("启动自检接线(生成入口必检,不得摘除)", () => {
  const ENTRIES = [
    ["scripts", "today-full-coverage.mjs"],
    ["scripts", "wc-match-predict.mjs"],
    ["scripts", "build-wc-betting-slip.mjs"],
    ["scripts", "wc-match-recap.mjs"],
    ["src", "daily-evolution.js"],
  ];
  for (const entry of ENTRIES) {
    it(`${entry.join("/")} 启动必跑 preflightOrDie`, () => {
      assert.ok(read(...entry).includes("preflightOrDie"), `${entry.join("/")} 的启动自检被摘除(2026-06-11 用户裁决:生成入口必检)`);
    });
  }
});

describe("自检模块行为", () => {
  it("世界杯窗口判定:6/11~7/19 内 true,窗外 false(窗外世界杯域检查休眠)", () => {
    assert.equal(inWorldCupWindow("2026-06-11"), true);
    assert.equal(inWorldCupWindow("2026-07-19"), true);
    assert.equal(inWorldCupWindow("2026-07-20"), false);
    assert.equal(inWorldCupWindow("2026-06-10"), false);
  });

  it("runPreflight 返回 {ok, date, checks[]} 且红/警级齐备", async () => {
    const r = await runPreflight({ requireFixtures: false });
    assert.equal(typeof r.ok, "boolean");
    assert.ok(Array.isArray(r.checks) && r.checks.length > 0);
    for (const c of r.checks) {
      assert.ok(["red", "warn"].includes(c.level), `非法级别 ${c.level}`);
      assert.ok(typeof c.ok === "boolean" && typeof c.msg === "string");
    }
  });

  it("窗口外日期:世界杯域检查自动休眠(无 elo/odds/weather 红项)", async () => {
    const r = await runPreflight({ date: "2026-08-01", now: "2026-08-01T12:00:00Z", requireFixtures: false });
    const ids = r.checks.map((c) => c.id);
    assert.ok(!ids.includes("elo-fresh") && !ids.includes("odds-fresh"), "窗口外不应查世界杯源新鲜度");
    assert.ok(ids.includes("wc-window"), "窗口外应有休眠标注");
  });
});
