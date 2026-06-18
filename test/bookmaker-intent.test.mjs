import { test } from "node:test";
import assert from "node:assert/strict";
import { bookmakerIntent } from "../src/bookmaker-intent.js";

test("亚盘跨源:sharp更深→竞彩受让方相对有值(核心意图信号)", () => {
  const r = bookmakerIntent({
    euroCur: { home: 1.5, draw: 4, away: 6 },   // 主=热门
    jcAhLine: -0.75, dkAsianLine: -1.25, dkSrc: "DraftKings",
  });
  const ah = r.signals.find((s) => s.type === "亚盘跨源");
  assert.equal(ah.dir, "sharp更看好热门");
  assert.ok(r.valueHint.includes("客队"), "受让方=客队相对有值");
  assert.ok(r.dataStrength.includes("中"));
});

test("亚盘跨源:sharp更浅→谨慎追热门", () => {
  const r = bookmakerIntent({
    euroCur: { home: 1.5, draw: 4, away: 6 },
    jcAhLine: -1.5, dkAsianLine: -1.0, dkSrc: "DraftKings",
  });
  const ah = r.signals.find((s) => s.type === "亚盘跨源");
  assert.equal(ah.dir, "sharp更看淡热门");
});

test("1X2 加注→公众side=热门", () => {
  const r = bookmakerIntent({
    euroInit: { home: 1.7, draw: 3.8, away: 5 },
    euroCur: { home: 1.45, draw: 4.2, away: 6.5 },   // 主队隐含上升
  });
  const mv = r.signals.find((s) => s.type === "1X2移动");
  assert.equal(mv.dir, "热门被加注");
  assert.ok(r.publicSide && r.publicSide.includes("主队"));
});

test("大小球跨源:sharp更看大球", () => {
  const r = bookmakerIntent({
    euroCur: { home: 2.0, draw: 3.3, away: 3.5 },
    jcOver: 0.50, intlOver: 0.58, intlBooks: 13,
  });
  const ou = r.signals.find((s) => s.type === "大小球跨源");
  assert.equal(ou.dir, "sharp更看大球");
});

test("双跨源→数据强度=强", () => {
  const r = bookmakerIntent({
    euroCur: { home: 1.6, draw: 3.8, away: 5 },
    jcAhLine: -0.5, dkAsianLine: -1.0,
    jcOver: 0.48, intlOver: 0.56, intlBooks: 13,
  });
  assert.ok(r.dataStrength.includes("强"));
});

test("无跨源+无移动→诚实标无·不编意图", () => {
  const r = bookmakerIntent({ euroCur: { home: 1.5, draw: 4, away: 6 } });
  assert.equal(r.signals.length, 0);
  assert.ok(r.dataStrength.includes("无"));
  assert.ok(r.intent.includes("无明显偏离"));
});

test("一致盘口→标一致非分歧", () => {
  const r = bookmakerIntent({
    euroCur: { home: 1.8, draw: 3.5, away: 4 },
    jcAhLine: -0.75, dkAsianLine: -0.75,
    jcOver: 0.52, intlOver: 0.53, intlBooks: 10,
  });
  assert.ok(r.intent.includes("基本一致"));
});

test("大小球 intlOver=0/缺 不得当真值(防0冒充·铁律)", () => {
  const zero = bookmakerIntent({ euroCur: { home: 1.26, draw: 4.65, away: 8.25 }, jcOver: 0.58, intlOver: 0 });
  assert.equal(zero.signals.find((s) => s.type === "大小球跨源"), undefined, "intlOver=0 不出大小球信号");
  const nul = bookmakerIntent({ euroCur: { home: 1.26, draw: 4.65, away: 8.25 }, jcOver: 0.58, intlOver: null });
  assert.equal(nul.signals.find((s) => s.type === "大小球跨源"), undefined);
  const over1 = bookmakerIntent({ euroCur: { home: 1.26, draw: 4.65, away: 8.25 }, jcOver: 1.2, intlOver: 0.5 });
  assert.equal(over1.signals.find((s) => s.type === "大小球跨源"), undefined, "jcOver>1 非法不出");
});

test("空输入→null", () => {
  assert.equal(bookmakerIntent(null), null);
});
