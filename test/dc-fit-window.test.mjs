import assert from "node:assert/strict";
import test from "node:test";
import { fitFromFixtureStore } from "../src/dixon-coles-engine.js";

// 2026-06-01 回测调优:fitFromFixtureStore 默认 maxDates 120→700(120 比宽窗命中低 3.5pp)。
// 本测试钉住"默认窗口显著宽于 120",防默认被悄悄改回窄窗拖低裸调路径(render-html 等)。
test("fitFromFixtureStore 默认窗口显著宽于 120(防窄窗回归)", () => {
  const ref = "2026-05-20";
  const narrow = fitFromFixtureStore({ maxDates: 120, beforeDate: ref });
  const dflt = fitFromFixtureStore({ beforeDate: ref });
  // 数据被清(D 盘历史不在)→ 不强断言,只确保不崩。
  if (!narrow.usable || (narrow.matches ?? 0) < 1000) {
    assert.ok(dflt.matches >= 0);
    return;
  }
  // 默认窗口拟合到的比赛数必须明显多于 120 窗口(即默认不再是 120)。
  assert.ok(dflt.matches > narrow.matches, `默认窗口(${dflt.matches})应宽于 120 窗口(${narrow.matches})`);
  assert.ok(dflt.usable && !dflt.coldStart, "默认拟合应可用且非冷启动");
});
