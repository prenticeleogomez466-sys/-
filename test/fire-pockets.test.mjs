import assert from "node:assert/strict";
import test from "node:test";
import { firePockets, FIRE_POCKETS } from "../src/fire-pockets.js";
import { synthesize } from "../src/cross-market-synthesizer.js";

test("深让球盘(让2+)+平稳→胜负平出手·热门赢(命中84%)", () => {
  // 主队大热,让2球,资金平稳(初≈收盘)
  const m = { euClose: { home: 1.25, draw: 6.5, away: 11 }, euOpen: { home: 1.26, draw: 6.4, away: 10.5 }, ahLineClose: "-2" };
  const r = firePockets(m);
  assert.ok(r.wld, "让2+平稳应触发胜负平口袋");
  assert.equal(r.wld.dir, "主胜");
  assert.ok(r.wld.hitTe >= 0.8);
});

test("让0.25+平赔3.7-4→大小球出手·大球(71%)", () => {
  const m = { euClose: { home: 2.1, draw: 3.85, away: 3.3 }, ahLineClose: "-0.25" };
  const r = firePockets(m);
  assert.ok(r.ou, "让0.25+平3.85应触发大球口袋");
  assert.equal(r.ou.dir, "大球");
});

test("让0.5+平赔<3.2→大小球出手·小球", () => {
  const m = { euClose: { home: 1.9, draw: 3.1, away: 3.9 }, ahLineClose: "-0.5" };
  const r = firePockets(m);
  assert.ok(r.ou);
  assert.equal(r.ou.dir, "小球");
});

test("让球过盘恒为无高命中点(诚实·证伪过)", () => {
  const m = { euClose: { home: 1.25, draw: 6.5, away: 11 }, euOpen: { home: 1.26, draw: 6.4, away: 10.5 }, ahLineClose: "-2" };
  const r = firePockets(m);
  assert.ok(/无高命中点/.test(r.handicap), "让球过盘必须诚实标无高命中点");
  // 深盘给替代建议=让球后胜平负的胜
  assert.ok(/让球后胜平负的胜|热门|主胜|客胜/.test(r.handicap));
});

test("非口袋场→三市场沉默(不硬凑)", () => {
  // 平手盘均势中庸,平赔3.4(过渡区),无口袋
  const m = { euClose: { home: 2.5, draw: 3.4, away: 2.7 }, ahLineClose: "0" };
  const r = firePockets(m);
  assert.equal(r.wld, null, "无胜负平口袋应沉默");
  assert.equal(r.ou, null, "无大小球口袋应沉默");
});

test("合成器markets三问完整(每场都能回答看胜负平/大小球/让球)", () => {
  const m = { euClose: { home: 1.25, draw: 6.5, away: 11 }, euOpen: { home: 1.26, draw: 6.4, away: 10.5 }, ahLineClose: "-2" };
  const s = synthesize(m);
  assert.ok(s.markets.胜负平, "必有胜负平结论");
  assert.ok(s.markets.大小球, "必有大小球结论");
  assert.ok(s.markets.让球, "必有让球结论");
  assert.equal(s.markets.胜负平.出手, true);
  assert.equal(s.markets.让球.出手, false);
});

test("交叉验证按真实数据维度并集算·≥2独立维度才通过(2026-06-22铁律)", () => {
  // 超大热门(欧赔档)+ 让2+(让球线档)→ favDims≥2 独立维度 → 交叉验证通过
  const strong = synthesize({ euClose: { home: 1.25, draw: 6.5, away: 11 }, euOpen: { home: 1.26, draw: 6.4, away: 10.5 }, ahLineClose: "-2" });
  assert.equal(strong.oneXtwo.crossValidated, true, "热门方向≥2维度应交叉验证通过");
  assert.ok(strong.oneXtwo.crossDims.length >= 2, "crossDims 应含≥2个真实数据维度");
  // 中庸均势盘:无胜负平触发 + 平赔中性 → 无共识维度 → 交叉验证不通过(不硬凑)
  const neutral = synthesize({ euClose: { home: 2.5, draw: 3.4, away: 2.7 }, ahLineClose: "0" });
  assert.equal(neutral.oneXtwo.crossValidated, false, "无共识维度不得伪称交叉验证通过");
});

test("FIRE_POCKETS全部te命中达阈值(防止误录低命中口袋)", () => {
  for (const p of FIRE_POCKETS) {
    const thr = p.market === "大小球" ? 0.57 : 0.64;
    assert.ok(p.te >= thr, `${p.line}+${p.sub}→${p.dir} te=${p.te} 应达阈值`);
    assert.ok(p.n >= 60, `${p.line}+${p.sub} 样本应≥60`);
  }
});
