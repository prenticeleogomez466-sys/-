import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTodayMobileHtml, __test } from "../src/today-mobile-view.js";

const SAMPLE = {
  predictions: [
    {
      fixture: { sequence: "1", homeTeam: "瑞士", awayTeam: "约旦", competition: "国际赛", notes: "官方期号=第26083期; 停售=2026-05-31T11:30:00.000Z; 比赛日期=2026-05-31", officialFixtureId: "第26083期-1" },
      pick: { label: "主胜", probability: 0.807 }, probabilities: { home: 0.807, draw: 0.135, away: 0.057 },
      confidence: 100, risk: "中", scorePicks: { primary: "2-0" }, halfFullPicks: { primary: "主胜-主胜" },
      handicapPick: { direction: "主胜", line: -1, coverProbability: 0.62, skellamCheck: { note: "✓ 让球一致" } },
      experienceContext: { overUnderHint: "📊 大球51%", drawAlert: null }
    }
  ],
  fourteen: {
    available: true, count: 14,
    selections: [
      { index: 1, match: "瑞士 对 约旦", type: "胆", single: "主胜", compound: "主胜", competitionType: "🌍 国家队赛", confidence: 100, probabilities: { home: "80.7%", draw: "13.5%", away: "5.7%" } },
      { index: 2, match: "美国 对 塞内加尔", type: "双选", single: "主胜", compound: "主胜/平局", competitionType: "🌍 国家队赛", confidence: 14, probabilities: { home: "35.3%", draw: "29.6%", away: "35.1%" } }
    ],
    renxuan9: { ok: true, needCorrect: 9, picks: [{ rank: 1, match: "巴西 对 巴拿马", pick: "主胜", competitionType: "🌍 国家队赛", confidence: 100, probabilities: { home: "85%", draw: "11%", away: "4%" } }] }
  }
};

test("renderTodayMobileHtml 含三段 + 官方期号 + 停售北京时间", () => {
  const html = renderTodayMobileHtml(SAMPLE, "2026-05-31");
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("第26083期"), "应展示官方期号");
  assert.ok(html.includes("竞彩明细"), "应有竞彩明细段");
  assert.ok(html.includes("14场胜负彩"), "应有14场段");
  assert.ok(html.includes("任选9"), "应有任选9段");
  assert.ok(html.includes("瑞士") && html.includes("约旦"), "应含对阵");
  // 停售 2026-05-31T11:30Z → 北京 19:30
  assert.ok(/19:30/.test(html), "停售应换算为北京时间 19:30");
  // 胆/双拆分来自 selections,不重判
  assert.ok(/胆 1/.test(html) && /双选 1/.test(html), "胆双数应来自 selections");
});

test("空 predictions 优雅降级、不造数据", () => {
  const html = renderTodayMobileHtml({ predictions: [], fourteen: {} }, "2026-05-31");
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("暂无可预测场次"), "空数据应明示无场次");
  assert.ok(!html.includes("第26083期"), "空数据不应出现任何具体期号/对阵");
});

test("esc 转义 HTML 危险字符", () => {
  assert.equal(__test.esc('<a>&"'), "&lt;a&gt;&amp;&quot;");
});
