import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync, utimesSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nationalEloFor, eloToLambdas, loadNationalElo } from "../src/national-elo-source.js";

describe("国家队 Elo 源", () => {
  const mem = { elo: { "挪威": 1912, "瑞典": 1719, "保加利亚": 1475, "黑山": 1439 } };

  it("nationalEloFor 命中中文名 + 无记忆/无队返回 null", () => {
    assert.equal(nationalEloFor(mem, "挪威"), 1912);
    assert.equal(nationalEloFor(mem, "火星队"), null);
    assert.equal(nationalEloFor(null, "挪威"), null);
  });

  it("eloToLambdas:强队 λ 更高、净胜球为正、双 λ 在物理域", () => {
    const lam = eloToLambdas(1912, 1719, { totalGoals: 2.5 });
    assert.ok(lam.home > lam.away, "强队期望进球更高");
    assert.ok(lam.supremacy > 0, "净胜球为正");
    assert.ok(lam.home <= 3.2 && lam.away >= 0.2, "λ 夹在物理域");
    assert.equal(lam.eloDiff, 193);
  });

  it("eloToLambdas:Elo 差越大净胜球越大(单调)", () => {
    const small = eloToLambdas(1500, 1480);
    const big = eloToLambdas(2000, 1400);
    assert.ok(big.supremacy > small.supremacy);
  });

  it("eloToLambdas:非数字 Elo 返回 null,不编造", () => {
    assert.equal(eloToLambdas(1500, null), null);
    assert.equal(eloToLambdas(undefined, 1500), null);
  });

  it("总进球线驱动 λ 总量:O/U 高→双 λ 总和高", () => {
    const lo = eloToLambdas(1700, 1700, { totalGoals: 2.0 });
    const hi = eloToLambdas(1700, 1700, { totalGoals: 3.4 });
    assert.ok((hi.home + hi.away) > (lo.home + lo.away));
  });
});

describe("national-elo 保鲜检查(2026-06-10 审计rank8:ageH 恒 null 死代码→真实 mtime)", () => {
  const withWarnCapture = (fn) => {
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    try { return { result: fn(), warns }; } finally { console.warn = orig; }
  };

  it(">7 天未刷新:console ⚠️ 提醒,但仍返回数据(提示不替用户弃数据)", () => {
    const dir = mkdtempSync(join(tmpdir(), "elo-stale-"));
    const p = join(dir, "national-elo.json");
    writeFileSync(p, JSON.stringify({ builtAt: "2026-05-01T00:00:00Z", count: 1, elo: { "西班牙": 2100 } }), "utf8");
    const oldSec = (Date.now() - 8 * 86400e3) / 1000; // mtime 拨回 8 天前
    utimesSync(p, oldSec, oldSec);
    const { result, warns } = withWarnCapture(() => loadNationalElo(p));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(result?.elo?.["西班牙"], 2100, "过期数据仍可用,不阻断");
    assert.ok(warns.some((w) => w.includes("未刷新")), "发出 ⚠️ 陈旧提醒");
  });

  it("7 天内新鲜文件:不发提醒", () => {
    const dir = mkdtempSync(join(tmpdir(), "elo-fresh-"));
    const p = join(dir, "national-elo.json");
    writeFileSync(p, JSON.stringify({ builtAt: new Date().toISOString(), count: 1, elo: { "西班牙": 2100 } }), "utf8");
    const { result, warns } = withWarnCapture(() => loadNationalElo(p));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(result?.elo?.["西班牙"], 2100);
    assert.equal(warns.length, 0, "新鲜文件不应告警");
  });
});
