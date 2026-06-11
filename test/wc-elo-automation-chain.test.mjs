import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fetch-wc-sources-2 守护(2026-06-11):sync:wc-elo(世界杯48队Elo保鲜)必须挂在自动化链
// (run-football-automation.ps1 的 Run-Daily)里。开赛后(6/12起)每天有比赛,Elo 不刷会逐日
// 静默陈化且 team-priors 消费路径无任何陈旧告警 → 超算/先验吃旧 Elo 无人察觉。
// 本测试钉死:Run-Daily 函数体内含 sync:wc-elo 步骤(AllowFailure,源挂不阻塞主线)。

test("run-football-automation.ps1 Run-Daily 含 sync:wc-elo 保鲜步骤", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "..", "scripts", "run-football-automation.ps1"), "utf8");
  const m = text.match(/function Run-Daily \{([\s\S]*?)\r?\n\}/);
  assert.ok(m, "应能定位 Run-Daily 函数体");
  assert.match(m[1], /sync:wc-elo/, "Run-Daily 必须包含 npm run sync:wc-elo(世界杯Elo每日保鲜,fetch-wc-sources-2)");
});
