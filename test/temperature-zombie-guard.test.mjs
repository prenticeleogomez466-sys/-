// 缺陷#19 守护(2026-06-10):温度软化层 2026-05-31 按删兜底铁律从 prediction-engine
// 有意删除,是【有意删除的僵尸】——绝不接回消费点、绝不重新调度。
// 此前的在线假象链:auto:weekly → optimize:loop step④ → run-temperature-fit --apply
// 每周把 temperature 写进 fusion-signal-weights profile 并打"✅已写",但生产没人读它。
// 本守护拦三处:①optimize:loop 不得再调度温度拟合;②package.json 不得保留调度入口;
// ③生产推理链(prediction-engine / signal-weight-tuner)不得出现温度消费点。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(rootDir, ...parts), "utf8");

describe("temperature 僵尸调度链已摘除(缺陷#19,禁止回接)", () => {
  it("optimize:loop 不得调度 run-temperature-fit(原 step④)", () => {
    const source = read("scripts", "run-optimize-loop.mjs");
    assert.ok(!source.includes("run-temperature-fit"), "optimize:loop 禁止再调度温度拟合(僵尸,缺陷#19)");
    assert.ok(!/results\.push\(step\("④/.test(source), "step④ 已删,不得回加");
  });
  it("package.json 不得保留 calibration:temperature 调度入口", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.scripts["calibration:temperature"], undefined, "调度入口已删,不得回加");
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      assert.ok(!String(cmd).includes("run-temperature-fit"), `scripts.${name} 不得引用 run-temperature-fit`);
    }
  });
  it("生产推理链不得消费 profile.temperature(prediction-engine / signal-weight-tuner)", () => {
    for (const file of [["src", "prediction-engine.js"], ["src", "signal-weight-tuner.js"]]) {
      const source = read(...file);
      // 允许说明性注释提到"温度";禁止的是真实消费点(applyTemperature 调用 / profile.temperature 读取)。
      assert.ok(!source.includes("applyTemperature("), `${file.join("/")} 不得调用 applyTemperature(温度是有意删除的僵尸)`);
      assert.ok(!/profile\.temperature|weightProfile\.temperature/.test(source), `${file.join("/")} 不得读取 profile.temperature`);
    }
  });
  it("run-temperature-fit 自身必须带僵尸警告头(防误判在线)", () => {
    const source = read("scripts", "run-temperature-fit.mjs");
    assert.match(source, /僵尸警告/);
    assert.match(source, /绝不.*接回消费点|绝不把 temperature 接回消费点/);
  });
});
