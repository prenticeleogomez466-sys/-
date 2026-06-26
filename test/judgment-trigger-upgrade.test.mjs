import assert from "node:assert/strict";
import test from "node:test";
import {
  hfHotColdToZh, fourWayOverview, extractSynthesisFragment, injectSynthesisFragment,
  buildAnomalyRadar, buildComboTriggerSheet,
} from "../src/today-delivery-lib.js";

// ── B. 半全场"热/冷/平"→直白胜平负(2026-06-25 用户:别用冷热) ──
test("hfHotColdToZh:热门视角与主队视角都翻成胜胜/胜平/负胜/平平", () => {
  // 主队=热门:热→胜、冷→负、平→平
  assert.equal(hfHotColdToZh("热-热(56%)", true), "胜胜(56%)");
  assert.equal(hfHotColdToZh("平-热(20%)", true), "平胜(20%)");
  assert.equal(hfHotColdToZh("冷-冷(8%)", true), "负负(8%)");
  // 客队=热门:热门赢=主队负,故热→负、冷→胜
  assert.equal(hfHotColdToZh("热-热(62%)", false), "负负(62%)");
  assert.equal(hfHotColdToZh("平-热(14%)", false), "平负(14%)");
  // 跨场(无 favHome)按热门视角:被看好方赢=胜
  assert.equal(hfHotColdToZh("热-热", null), "胜胜");
  assert.equal(hfHotColdToZh("负-胜", null), "负-胜"); // 非热冷格式→原样返回
  assert.equal(hfHotColdToZh("主胜-主胜", true), "主胜-主胜");
});

// ── C. 研判呈现优先级:胜负平→让球→比分→半全场 ──
test("fourWayOverview 按 ①胜负平 ②让球 ③比分 ④半全场 顺序输出", () => {
  const r = { wld: "主胜", hv: { verdict: "让1球后主胜" }, score: "2-1(15%) / 1-0(12%)", mhv: { fromMarket: true, top: [{ halfFull: "主胜-主胜" }] } };
  const o = fourWayOverview(r);
  assert.match(o, /①胜负平:主胜/);
  assert.match(o, /②让球:让1球后主胜/);
  assert.match(o, /③比分:2-1/);
  assert.match(o, /④半全场:主胜-主胜/);
  // 顺序严格:胜负平 在 让球 在 比分 在 半全场 之前
  assert.ok(o.indexOf("①胜负平") < o.indexOf("②让球"));
  assert.ok(o.indexOf("②让球") < o.indexOf("③比分"));
  assert.ok(o.indexOf("③比分") < o.indexOf("④半全场"));
});

test("fourWayOverview 缺数据标—不编", () => {
  const o = fourWayOverview({});
  assert.match(o, /①胜负平:—/);
  assert.match(o, /④半全场:—/);
});

// ── D. 近期状态(近5)进研判·7维齐 ──
test("buildAnomalyRadar 含近期状态因子且 short 单独展示近5", () => {
  const r = { wld: "主胜", tier: "二档", conf: 60,
    strengthInputs: { homeForm: { n: 5, w: 3, d: 1, gf: 1.8, ga: 0.8 }, awayForm: { n: 5, w: 1, d: 2, gf: 1.0, ga: 1.4 } } };
  const rad = buildAnomalyRadar(r);
  const form = rad.factors.find((f) => f.cat === "近期状态");
  assert.ok(form, "须有近期状态因子");
  assert.match(form.text, /主队近5场 3胜1平1负/);
  assert.match(rad.short, /📈近期状态:/);
});

test("buildAnomalyRadar 近5缺→诚实标缺不编", () => {
  const rad = buildAnomalyRadar({ wld: "主胜" });
  const form = rad.factors.find((f) => f.cat === "近期状态");
  assert.ok(form);
  assert.match(form.text, /近5战绩未取到/);
});

// ── A. 多条件触发共振 + 半全场直白(组合触发表) ──
test("buildComboTriggerSheet:多条件共振标注 + 半全场无冷热字", () => {
  const rows = [
    { match: "强队 vs 弱旅", wld: "主胜", msv: { wld: "3" },
      sanityOdds: { euro: { home: 1.22, draw: 6.5, away: 12 }, euroInit: { home: 1.22, draw: 6.5, away: 12 }, ahLine: -2.25 } },
  ];
  const sheet = buildComboTriggerSheet({ date: "2026-06-25", rows });
  const joined = sheet.rows.map((r) => r.join("｜")).join("\n");
  // 超大热门(欧赔档)+ 实力悬殊让2+(让球线档)同推主胜/大球 → ≥2维共振
  assert.match(joined, /条件共振/);
  // 半全场已去冷热,改直白胜平负(不得再出现"热-热"/"冷-冷")
  assert.ok(!/热-热|冷-冷|平-热|热-平/.test(joined), "半全场不得保留冷热表达");
});

// ── E. 全维度综合判读 FRAGMENT 提取与注入 ──
test("extractSynthesisFragment 取出 <FRAGMENT> 段", () => {
  const stdout = `已生成配套表: x.xlsx\n<FRAGMENT>\n<section id="full-synthesis">综合判读</section>\n</FRAGMENT>\n尾部`;
  assert.equal(extractSynthesisFragment(stdout), `<section id="full-synthesis">综合判读</section>`);
  assert.equal(extractSynthesisFragment("无片段"), null);
});

test("injectSynthesisFragment 插入 </body> 前且重跑不累积", () => {
  const html = `<html><body><p>推荐</p></body></html>`;
  const frag = `<section id="full-synthesis">综合判读V1</section>`;
  const once = injectSynthesisFragment(html, frag);
  assert.match(once, /<section id="full-synthesis">综合判读V1<\/section>\s*<\/body>/);
  // 二次注入新版本:旧段被替换,不累积
  const frag2 = `<section id="full-synthesis">综合判读V2</section>`;
  const twice = injectSynthesisFragment(once, frag2);
  assert.equal((twice.match(/id="full-synthesis"/g) || []).length, 1, "综合判读段只能有一份");
  assert.match(twice, /综合判读V2/);
  assert.ok(!twice.includes("综合判读V1"));
  // 无 body 时追加末尾
  assert.match(injectSynthesisFragment("<div>x</div>", frag), /综合判读V1/);
  // 空片段不改原文
  assert.equal(injectSynthesisFragment(html, null), html);
});
