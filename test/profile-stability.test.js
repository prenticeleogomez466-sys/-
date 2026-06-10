// 缺陷#6#14(2026-06-10):fusion profile 稳定化 + 4 害信号硬禁 + 弱联赛护栏复活。
// 背景:fusion-signal-weights.json / league-reliability.json 原写在 exports 根,被 16:01
// 清空计划任务删除 → 加载静默 null → 无赔率场 26 信号(含 4 个已证伪害信号)全权重裸跑、
// isWeakLeague 恒 false 真钱护栏失效。本测试钉死:
//   ① profile 缺失必须 fail-loud(显著错误日志)且 4 害信号代码级硬禁兜底,绝不静默裸跑;
//   ② profile 迁到持久 data\profiles\ 后正常加载(以 profile 为准),旧 exports 根回退兼容;
//   ③ league-reliability 缺失 fail-loud + 不臆断(false);恢复后 isWeakLeague 能真返回 true。
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadFusionWeightProfile, _resetFusionWeightCache, HARD_DISABLED_SIGNALS, collectFusionEvidence
} from "../src/signal-fusion-layer.js";
import { loadLeagueReliability, _resetLeagueReliabilityCache, isWeakLeague } from "../src/league-reliability.js";

const HURTS4 = ["home-away-split", "time-decay-form", "h2h", "derby"];

// 每个用例把 FOOTBALL_DATA_DIR / FOOTBALL_EXPORT_DIR 指到全新临时目录,跑完恢复原 env。
function withTempDirs(fn) {
  const origData = process.env.FOOTBALL_DATA_DIR;
  const origExport = process.env.FOOTBALL_EXPORT_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "fm-data-"));
  const exportDir = mkdtempSync(join(tmpdir(), "fm-export-"));
  process.env.FOOTBALL_DATA_DIR = dataDir;
  process.env.FOOTBALL_EXPORT_DIR = exportDir;
  _resetFusionWeightCache();
  _resetLeagueReliabilityCache();
  try {
    return fn({ dataDir, exportDir, profilesDir: join(dataDir, "profiles") });
  } finally {
    if (origData === undefined) delete process.env.FOOTBALL_DATA_DIR; else process.env.FOOTBALL_DATA_DIR = origData;
    if (origExport === undefined) delete process.env.FOOTBALL_EXPORT_DIR; else process.env.FOOTBALL_EXPORT_DIR = origExport;
    _resetFusionWeightCache();
    _resetLeagueReliabilityCache();
  }
}

function captureConsoleErrors(fn) {
  const orig = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    const result = fn();
    return { result, logs };
  } finally {
    console.error = orig;
  }
}

// 与 aa-tier-orphan-integration.test.js 同款近期赛构造:让 time-decay-form / home-away-split 必 fire。
function recentForm(results, refDate = "2026-05-20") {
  const base = Date.parse(refDate);
  return results.map((won, i) => ({
    date: new Date(base - (i + 1) * 5 * 86400000).toISOString().slice(0, 10),
    venue: i % 2 ? "away" : "home",
    goalsFor: won === "W" ? 2 : won === "D" ? 1 : 0,
    goalsAgainst: won === "L" ? 2 : won === "D" ? 1 : 0,
    won
  }));
}
function strongHomeCtx() {
  return {
    homeRecentMatches: recentForm(["W", "W", "W", "W", "W", "W"]),
    awayRecentMatches: recentForm(["L", "L", "L", "L", "L", "L"])
  };
}

test("HARD_DISABLED_SIGNALS 与每周重训害信号清单一致(单一事实源镜像)", () => {
  assert.deepEqual([...HARD_DISABLED_SIGNALS].sort(), [...HURTS4].sort());
});

test("缺陷#6:profile 缺失 → fail-loud 降级(显著错误日志+degraded 标注),绝不静默 null", () => {
  withTempDirs(() => {
    const { result: p, logs } = captureConsoleErrors(() => loadFusionWeightProfile());
    assert.ok(p, "缺失时不再返回静默 null,返回 degraded 兜底 profile");
    assert.equal(p.degraded, true);
    assert.ok(typeof p.degradedReason === "string" && p.degradedReason.length > 0, "降级原因可追溯");
    assert.ok(Array.isArray(p.disabledSignals) && p.signalWeights, "形状兼容现有消费方");
    assert.ok(logs.some((l) => l.includes("fusion-signal-weights")), "必须打显著错误日志(fail-loud)");
    // 进程内缓存:第二次同引用,且不再重复刷错误日志
    const { result: again, logs: logs2 } = captureConsoleErrors(() => loadFusionWeightProfile());
    assert.equal(again, p);
    assert.equal(logs2.length, 0, "缓存命中不重复刷屏");
  });
});

test("缺陷#6:profile 缺失时 4 害信号代码级硬禁——即使数据让它们必 fire 也进 dormant:disabled", () => {
  withTempDirs(() => {
    const { result: p } = captureConsoleErrors(() => loadFusionWeightProfile());
    for (const s of HURTS4) assert.ok(p.disabledSignals.includes(s), `${s} 必须在硬禁清单`);
    const prior = { home: 0.4, draw: 0.3, away: 0.3 };
    const fixture = { homeTeam: "甲", awayTeam: "乙", date: "2026-05-22" };
    const ctx = strongHomeCtx();
    // 对照:不带 profile opts 时这些害信号确实会 fire(证明数据足以触发,硬禁不是空测)
    const bare = collectFusionEvidence(prior, fixture, {}, ctx);
    assert.ok(bare.evidence.some((e) => e.name === "time-decay-form"), "对照组:time-decay-form 应 fire");
    assert.ok(bare.evidence.some((e) => e.name === "home-away-split"), "对照组:home-away-split 应 fire");
    // 生产装配(prediction-engine 同款):degraded profile 的 disabledSignals 必须挡住 4 害
    const prod = collectFusionEvidence(prior, fixture, {}, ctx, {
      signalWeights: p.signalWeights, disabledSignals: p.disabledSignals
    });
    for (const s of HURTS4) {
      assert.ok(!prod.evidence.some((e) => e.name === s), `${s} 在 profile 缺失时绝不允许 fire`);
    }
    assert.ok(prod.dormant.some((d) => d.name === "time-decay-form" && d.dormant === "disabled"));
    assert.ok(prod.dormant.some((d) => d.name === "home-away-split" && d.dormant === "disabled"));
  });
});

test("缺陷#6:profile 在新持久路径 data\\profiles\\ 时正常加载,以 profile 为准(非 degraded)", () => {
  withTempDirs(({ profilesDir }) => {
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "fusion-signal-weights.json"), JSON.stringify({
      usable: true, chosen: "弃4害(disable)", signalWeights: {}, disabledSignals: HURTS4
    }), "utf8");
    const { result: p, logs } = captureConsoleErrors(() => loadFusionWeightProfile());
    assert.ok(!p.degraded, "profile 存在 → 非降级");
    assert.equal(p.chosen, "弃4害(disable)");
    assert.deepEqual([...p.disabledSignals].sort(), [...HURTS4].sort());
    assert.equal(logs.length, 0, "正常加载不报错");
  });
});

test("缺陷#6:旧 exports 根路径仍有 profile 时回退可读(迁移兼容),新路径优先", () => {
  withTempDirs(({ exportDir, profilesDir }) => {
    // 只有旧路径 → 回退读到
    writeFileSync(join(exportDir, "fusion-signal-weights.json"), JSON.stringify({
      usable: true, chosen: "legacy", signalWeights: {}, disabledSignals: HURTS4
    }), "utf8");
    let { result: p } = captureConsoleErrors(() => loadFusionWeightProfile());
    assert.ok(!p.degraded);
    assert.equal(p.chosen, "legacy");
    // 新旧都有 → 新路径权威
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "fusion-signal-weights.json"), JSON.stringify({
      usable: true, chosen: "new-authority", signalWeights: {}, disabledSignals: HURTS4
    }), "utf8");
    _resetFusionWeightCache();
    ({ result: p } = captureConsoleErrors(() => loadFusionWeightProfile()));
    assert.equal(p.chosen, "new-authority");
  });
});

test("缺陷#6:profile 存在但 usable=false → 同样 fail-loud 降级 + 4 害硬禁(不信垃圾数据)", () => {
  withTempDirs(({ profilesDir }) => {
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "fusion-signal-weights.json"), JSON.stringify({ usable: false }), "utf8");
    const { result: p, logs } = captureConsoleErrors(() => loadFusionWeightProfile());
    assert.equal(p.degraded, true);
    for (const s of HURTS4) assert.ok(p.disabledSignals.includes(s));
    assert.ok(logs.length > 0, "不可用 profile 也要 fail-loud");
  });
});

test("缺陷#14:league-reliability 缺失 → fail-loud 错误日志,isWeakLeague 恒 false(不臆断)", () => {
  withTempDirs(() => {
    const { result: prof, logs } = captureConsoleErrors(() => loadLeagueReliability());
    assert.equal(prof, null, "缺失 → null(无数据不臆断弱联赛)");
    assert.ok(logs.some((l) => l.includes("league-reliability")), "必须打显著错误日志(fail-loud)");
    const { result: weak } = captureConsoleErrors(() => isWeakLeague("阿甲"));
    assert.equal(weak, false);
  });
});

test("缺陷#14:profile 恢复到新持久路径后 isWeakLeague 真返回 true(弱联赛『不当胆』护栏复活)", () => {
  withTempDirs(({ profilesDir }) => {
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "league-reliability.json"), JSON.stringify({
      usable: true, weakThreshold: 0.42,
      leagues: {
        "阿甲": { accuracy: 0.37, total: 30, hit: 11, reliable: true },
        "英超": { accuracy: 0.55, total: 40, hit: 22, reliable: true },
        "挪超": { accuracy: 0.30, total: 8, hit: 2, reliable: false }
      }
    }), "utf8");
    const { result: prof, logs } = captureConsoleErrors(() => loadLeagueReliability());
    assert.ok(prof?.leagues, "恢复后能读到 profile");
    assert.equal(logs.length, 0, "正常加载不报错");
    assert.equal(isWeakLeague("阿甲"), true, "可靠且命中<阈值 → 弱联赛护栏生效");
    assert.equal(isWeakLeague("英超"), false, "强联赛不降级");
    assert.equal(isWeakLeague("挪超"), false, "样本不足(reliable:false)不臆断");
  });
});
