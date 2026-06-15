// 守护:让球方向裁决(handicapVerdictParts)的【模型 vs 市场分歧旗标】。
// 复发根因(2026-06-14 用户审计抓出):同向场(sameDir=true)即便模型过盘% 与市场 de-vig% 差很大(如
//   科特迪瓦vs厄瓜多尔 模型51% vs 市场16%=35pp,模型高估押冷门),旧逻辑不显示任何⚠️。
//   回测铁律「分歧越大市场越准」→ ≥15pp 必须强制标"以市场为准·勿当胆",不分同向/不同向。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handicapVerdictParts } from "../src/today-delivery-lib.js";

const hw = (home, push, away, pickCode) => ({
  pick: pickCode === "0" ? "让球客胜" : pickCode === "3" ? "让球主胜" : "走盘",
  pickCode, probability: { home, push, away }[{ "3": "home", "1": "push", "0": "away" }[pickCode]],
  probabilities: { home, push, away },
});

test("同向但模型vs市场≥15pp → 必标分歧·以市场为准(科特迪瓦vs厄瓜多尔型)", () => {
  // line=+1, wld=客胜(0), 模型让客胜51%,市场让客胜16% → 35pp
  const r = handicapVerdictParts({
    line: 1, wldCode: "0", wldLabel: "客胜", hw: hw(0.25, 0.24, 0.51, "0"),
    marketDist: { home: 0.60, push: 0.24, away: 0.16 }, lineReal: true,
  });
  assert.equal(r.sameDir, true);
  assert.ok(r.divergePp >= 15, `divergePp 应≥15,实际 ${r.divergePp}`);
  assert.match(r.text, /模型与市场让球分歧/);
  assert.match(r.text, /以市场为准/);
});

test("同向且模型≈市场(<15pp) → 不误标分歧", () => {
  const r = handicapVerdictParts({
    line: -1, wldCode: "0", wldLabel: "客胜", hw: hw(0.30, 0.24, 0.46, "0"),
    marketDist: { home: 0.26, push: 0.28, away: 0.46 }, lineReal: true,
  });
  assert.ok(r.divergePp < 15);
  assert.doesNotMatch(r.text, /模型与市场让球分歧/);
});

test("官方让球线未抓到 → 不出过盘数字(不冒充)", () => {
  const r = handicapVerdictParts({ line: -1, wldCode: "3", hw: hw(0.4, 0.2, 0.4, "3"), lineReal: false });
  assert.match(r.text, /未抓到/);
  assert.equal(r.divergePp ?? null, null);
});
