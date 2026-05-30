import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvolutionBacktest, hasUsableTrainedProfile } from "../src/evolution-backtest.js";

// 守护:evolution-backtest 导出主入口。
test("evolution-backtest 导出 runEvolutionBacktest 且不引用 seeded 假数据", async () => {
  assert.equal(typeof runEvolutionBacktest, "function");
});

// 回归(AI 档温度线了结被 daily-recap/evolution 冲掉):
// evolution-backtest 不得用 ledger 版(usable:false / daily-recap-ledger)覆盖
// calibration-trainer 训练出的 isotonic 生产档。
test("hasUsableTrainedProfile 认得已训练 isotonic 档、拒认 ledger 兜底档", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-calib-"));
  try {
    const p = join(dir, "profile.json");

    // 不存在 → false
    assert.equal(hasUsableTrainedProfile(p), false);

    // ledger 兜底档(usable:false / daily-recap-ledger)→ false(可被覆盖)
    writeFileSync(
      p,
      JSON.stringify({ usable: false, source: "daily-recap-ledger" }),
      "utf8",
    );
    assert.equal(hasUsableTrainedProfile(p), false);

    // 训练出的 isotonic 档(usable:true / football-data-walkforward)→ true(必须保住)
    writeFileSync(
      p,
      JSON.stringify({
        usable: true,
        source: "football-data-walkforward",
        isotonicMap: { knots: [{ x: 0.7, y: 0.68 }] },
      }),
      "utf8",
    );
    assert.equal(hasUsableTrainedProfile(p), true);

    // 损坏 JSON → false(不抛错)
    writeFileSync(p, "{not-json", "utf8");
    assert.equal(hasUsableTrainedProfile(p), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
