// F2 推荐输出层修复(2026-06-10,审计rank2+13)守护测试:
//   ① coverage 抓取目标动态生成(废硬编码 MATCHES):世界杯 shengfucai 场必须进目标、对阵去重、
//      无英文映射 → re=null 诚实标缺不编;
//   ② simpleWldCell 双选可见:doubleChance.recommended=true 时前缀"双选X/Y",且主推方向排首
//      (保极简表四列同向不变量:方向判定取最左方向词)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverageTargets } from "../src/coverage-targets.js";
import { simpleWldCell } from "../src/daily-report.js";

const fx = (homeTeam, awayTeam, marketType, competition) => ({ homeTeam, awayTeam, marketType, competition });
const ZH_EN = { "韩国": "Korea Republic", "捷克": "Czechia", "墨西哥": "Mexico", "南非": "South Africa", "葡萄牙": "Portugal" };

test("buildCoverageTargets:世界杯 shengfucai 场进目标(旧 isJc/硬名单全漏的根因)", () => {
  const out = buildCoverageTargets([fx("韩国", "捷克", "shengfucai", "世界杯")], ZH_EN);
  assert.equal(out.length, 1);
  assert.equal(out[0].wc, true);
  assert.match("South Korea", new RegExp(out[0].home.re, "i")); // ESPN 变体名也要能对上
  assert.match("Czech Republic", new RegExp(out[0].away.re, "i"));
});

test("buildCoverageTargets:同对阵 jingcai+shengfucai 去重为 1 条", () => {
  const out = buildCoverageTargets([
    fx("墨西哥", "南非", "shengfucai", "世界杯"),
    fx("墨西哥", "南非", "jingcai", "世界杯"),
  ], ZH_EN);
  assert.equal(out.length, 1);
});

test("buildCoverageTargets:非世界杯 shengfucai(普通14场)不收;非世界杯 jingcai 收", () => {
  const out = buildCoverageTargets([
    fx("拜仁", "多特", "shengfucai", "德甲"),
    fx("葡萄牙", "尼日利亚", "jingcai", "国际赛"),
  ], ZH_EN);
  assert.equal(out.length, 1);
  assert.equal(out[0].zh, "葡萄牙 vs 尼日利亚");
  assert.equal(out[0].wc, false);
});

test("buildCoverageTargets:无英文映射 → re=null 诚实标缺,不模糊猜队", () => {
  const out = buildCoverageTargets([fx("某不知名队", "南非", "jingcai", "世界杯")], ZH_EN);
  assert.equal(out[0].home.re, null);
  assert.equal(out[0].home.en, null);
  assert.ok(out[0].away.re); // 有映射的一侧照常
});

const predBase = (code, probs, dc) => ({
  pick: { code },
  probabilities: probs,
  doubleChance: dc,
  jingcaiLetqiu: null,
  handicapPick: { line: 0 },
  confidence: 50,
});

test("simpleWldCell:doubleChance.recommended → 前缀'双选X/Y'且主推方向排首", () => {
  const p = predBase("3", { home: 0.45, draw: 0.30, away: 0.25 },
    { recommended: true, codes: ["3", "1"], pick: "主胜/平局", shortCode: "1X" });
  const cell = simpleWldCell(p);
  assert.match(cell, /^双选主胜\/平局\(1X\) 主选 主胜/);
});

test("simpleWldCell:客胜主推的双选,客胜排首(保四列同向:最左方向词=主推)", () => {
  const p = predBase("0", { home: 0.22, draw: 0.30, away: 0.48 },
    { recommended: true, codes: ["1", "0"], pick: "平局/客胜", shortCode: "X2" });
  const cell = simpleWldCell(p);
  assert.match(cell, /^双选客胜\/平局\(2X\) /);
  const first = cell.match(/(主胜|平局|客胜)/)[1];
  assert.equal(first, "客胜");
});

test("simpleWldCell:recommended=false 不加双选前缀(强档仍单关)", () => {
  const p = predBase("3", { home: 0.72, draw: 0.18, away: 0.10 },
    { recommended: false, codes: ["3", "1"], pick: "主胜/平局", shortCode: "1X" });
  assert.doesNotMatch(simpleWldCell(p), /^双选/);
});

test("simpleWldCell:⛔未开售真实性闸不被双选前缀顶掉", () => {
  const p = predBase("3", { home: 0.45, draw: 0.30, away: 0.25 },
    { recommended: true, codes: ["3", "1"], pick: "主胜/平局", shortCode: "1X" });
  p.jingcaiLetqiu = { sfcSold: false };
  assert.match(simpleWldCell(p), /未开售/);
});
