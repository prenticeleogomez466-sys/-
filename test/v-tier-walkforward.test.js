import assert from "node:assert/strict";
import test from "node:test";
import { runWalkForwardBacktest } from "../src/walkforward-backtest.js";

test("runWalkForwardBacktest 返回良构、指标在合理域内", () => {
  const res = runWalkForwardBacktest({ testDates: 3, minTrainMatches: 100, maxDates: 200 });
  // 结构
  for (const k of ["tested", "accuracy", "brier", "rps", "logLoss", "reliability", "testDatesUsed"]) {
    assert.ok(k in res, `缺字段 ${k}`);
  }
  // 命中率与概率指标在数学有效域内
  assert.ok(res.accuracy >= 0 && res.accuracy <= 1, "accuracy 越界");
  assert.ok(res.brier >= 0 && res.brier <= 2, "Brier 越界(3 类上限 2)");
  assert.ok(res.rps >= 0 && res.rps <= 1, "RPS 越界");
  assert.ok(res.logLoss >= 0, "LogLoss 不应为负");
});

test("三臂对比结构完整,calibrated 不劣于纯 DC 的 Brier", () => {
  const res = runWalkForwardBacktest({ testDates: 10, minTrainMatches: 150, maxDates: 220 });
  assert.ok(res.arms?.dc && res.arms?.fusion && res.arms?.calibrated, "缺三臂");
  if (res.tested >= 50) {
    // 校准是为了改善概率质量:Brier 不应明显变差
    assert.ok(res.arms.calibrated.brier <= res.arms.dc.brier + 0.01, "校准后 Brier 明显恶化,收缩过头");
  }
});

test("有训练数据时:命中率显著高于随机基线 0.33", () => {
  const res = runWalkForwardBacktest({ testDates: 20, minTrainMatches: 200, maxDates: 240 });
  if (res.tested < 50) {
    // 数据不足(如别人清了 D 盘历史)→ 不强断言,只确保不崩
    assert.ok(res.tested >= 0);
    return;
  }
  // 一个真模型至少要明显赢随机基线
  assert.ok(res.accuracy > 0.4, `命中率 ${res.accuracy} 未明显超随机基线,模型可能退化`);
  // 防泄漏 sanity:不可能 100% 命中(那是泄漏信号)
  assert.ok(res.accuracy < 0.85, `命中率 ${res.accuracy} 高得反常,疑似数据泄漏`);
});
