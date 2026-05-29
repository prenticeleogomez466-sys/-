import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLineMovement, lineMovementToLR } from "../src/line-movement-signal.js";
import { fuseSignals } from "../src/signal-fusion-layer.js";
import { runLineMovementBacktest } from "../src/line-movement-backtest.js";
import { predictFixture } from "../src/prediction-engine.js";

test("analyzeLineMovement 识别漂移方向、幅度与分类", () => {
  const opening = { home: 0.50, draw: 0.27, away: 0.23 };
  const later = { home: 0.57, draw: 0.24, away: 0.19 }; // 钱进主队
  const a = analyzeLineMovement(opening, later);
  assert.ok(a, "应返回分析");
  assert.equal(a.steamOutcome, "home");
  assert.ok(a.steamMagnitude > 0);
  assert.ok(a.totalMovement > 0.05);
  assert.equal(a.classification, "strong-steam");
  // 非法输入安全返回 null
  assert.equal(analyzeLineMovement({ home: 0.5 }, later), null);
  assert.equal(analyzeLineMovement(null, later), null);
});

test("lineMovementToLR 朝 later 线方向产 LR,微小移动休眠", () => {
  const opening = { home: 0.50, draw: 0.27, away: 0.23 };
  const later = { home: 0.58, draw: 0.23, away: 0.19 };
  const lr = lineMovementToLR(opening, later);
  assert.ok(lr, "显著移动应产 LR");
  assert.ok(lr.home > 1, "钱进主队 → 主胜 LR > 1");
  assert.ok(lr.away < 1, "客胜 LR < 1");

  // 噪声级移动 → null(休眠)
  const flat = lineMovementToLR(opening, { home: 0.501, draw: 0.2695, away: 0.2295 });
  assert.equal(flat, null);
  // 非法输入
  assert.equal(lineMovementToLR(null, later), null);
});

test("fuseSignals:无赔率快照时 line-movement 休眠,齐全时 fire", () => {
  const prior = { home: 0.45, draw: 0.28, away: 0.27 };
  const fixture = { id: "x1", homeTeam: "A", awayTeam: "B", competition: "英超", date: "2024-10-01" };

  const dormantRes = fuseSignals(prior, fixture, {}, {});
  const lm1 = dormantRes.dormant.find((d) => d.name === "line-movement");
  assert.ok(lm1, "缺快照时应在 dormant 列表");
  assert.equal(lm1.dormant, "no-odds-snapshots");

  const ctx = { openingOdds: { home: 0.45, draw: 0.28, away: 0.27 }, currentOdds: { home: 0.53, draw: 0.26, away: 0.21 } };
  const firedRes = fuseSignals(prior, fixture, {}, ctx);
  const fired = firedRes.evidence.find((e) => e.name === "line-movement");
  assert.ok(fired, "齐全快照且显著移动时应 fire");
  assert.ok(fired.ratio.home > 1);
});

test("predictFixture 生产钩子:快照含开盘≠当前时 line-movement fire,仅当前则休眠", () => {
  const fixture = {
    id: "fx-lm", date: "2026-05-15", kickoff: "2026-05-15 20:00",
    competition: "测试联赛", homeTeam: "主队", awayTeam: "客队", marketType: "jingcai", sequence: "001", tags: []
  };
  // 开盘主胜偏冷 → 当前钱进主队(显著移动)。
  // 注:默认策略「有市场 prior 时关闭融合层」(backtest:odds 实证融合害命中),
  // 故显式 fuseWithMarketPrior:true 验证 line-movement 信号机制本身仍工作。
  const withMove = predictFixture(fixture, [{
    fixtureId: fixture.id, date: fixture.date,
    europeanOdds: { initial: { home: 2.2, draw: 3.3, away: 3.2 }, current: { home: 1.7, draw: 3.6, away: 5.2 } }
  }], 0, { fuseWithMarketPrior: true });
  const fired = withMove.probabilityAdjustment.fusion.evidence.find((e) => e.name === "line-movement");
  assert.ok(fired, "开盘≠当前且显著移动时(融合启用),line-movement 应进 evidence");

  // 默认策略:有市场 prior(赔率快照)时融合层被门控关闭 → 命中率不被融合拖累
  const gated = predictFixture(fixture, [{
    fixtureId: fixture.id, date: fixture.date,
    europeanOdds: { initial: { home: 2.2, draw: 3.3, away: 3.2 }, current: { home: 1.7, draw: 3.6, away: 5.2 } }
  }]);
  assert.equal(gated.probabilityAdjustment.fusionGatedOff, true, "有市场 prior 时默认关闭融合");
  assert.equal(gated.probabilityAdjustment.fusion.applied, false, "门控下融合不应用");

  // 只有 current(无 initial)→ 装不出 openingOdds,信号休眠(显式启用融合下验证)
  const onlyCurrent = predictFixture(fixture, [{
    fixtureId: fixture.id, date: fixture.date, europeanOdds: { current: { home: 1.7, draw: 3.6, away: 5.2 } }
  }], 0, { fuseWithMarketPrior: true });
  const dorm = onlyCurrent.probabilityAdjustment.fusion.dormant.find((d) => d.name === "line-movement");
  assert.ok(dorm, "无开盘快照时 line-movement 应休眠");
});

// 含收盘 + Pinnacle 列的 mock CSV
function makeCsv(rows) {
  const header = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,AvgH,AvgD,AvgA,PSH,PSD,PSA,AvgCH,AvgCD,AvgCA,PSCH,PSCD,PSCA";
  const body = rows.map((r) =>
    `E0,${r.date},20:00,${r.home},${r.away},${r.hg},${r.ag},X,0,0,D,Ref,${r.oh},${r.od},${r.oa},${r.oh},${r.od},${r.oa},${r.ch},${r.cd},${r.ca},${r.ch},${r.cd},${r.ca}`
  );
  return [header, ...body].join("\n");
}
const mockFetch = (csv) => async () => ({ ok: true, text: async () => csv });

test("runLineMovementBacktest 结构完整,开/收两臂均有数据", async () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      date: `${String((i % 28) + 1).padStart(2, "0")}/09/2024`,
      home: `H${i}`, away: `A${i}`, hg: i % 3, ag: (i + 1) % 2,
      oh: 1.9, od: 3.5, oa: 4.0, ch: 1.8, cd: 3.6, ca: 4.4 // 收盘钱进主队
    });
  }
  const res = await runLineMovementBacktest({ leagues: ["E0"], seasons: ["2425"], fetch: mockFetch(makeCsv(rows)) });
  assert.equal(res.ok, true);
  assert.equal(res.bothOpenClose, 20);
  for (const k of ["open", "close", "pinnacleOpen", "pinnacleClose"]) {
    assert.ok(res.arms[k].tested > 0, `${k} 臂应有数据`);
    assert.ok(res.arms[k].accuracy >= 0 && res.arms[k].accuracy <= 1);
  }
  assert.ok(res.steam.matches >= 0);
});
