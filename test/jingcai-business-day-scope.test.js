import test from "node:test";
import assert from "node:assert/strict";
import { jingcaiWeekdayLabel, sequenceWeekdayPrefix, scopeJingcaiFixtures } from "../src/jingcai-business-day.js";
import { auditRecommendations } from "../src/recommendation-audit.js";

test("jingcaiWeekdayLabel 把 2026-05-30 判为周六(上海时区,不被 UTC 推日)", () => {
  assert.equal(jingcaiWeekdayLabel("2026-05-30"), "周六");
  assert.equal(jingcaiWeekdayLabel("2026-05-31"), "周日");
  assert.equal(jingcaiWeekdayLabel("2026-06-01"), "周一");
  assert.equal(jingcaiWeekdayLabel(""), null);
});

test("sequenceWeekdayPrefix 取竞彩编号 周X 前缀,数字编号返回 null", () => {
  assert.equal(sequenceWeekdayPrefix("周六015"), "周六");
  assert.equal(sequenceWeekdayPrefix("周日001"), "周日");
  assert.equal(sequenceWeekdayPrefix("6001"), null);
  assert.equal(sequenceWeekdayPrefix(undefined), null);
});

// 构造最小 recommendations 桩,验证自检对竞彩三类实质问题报错
function stubPrediction(seq, home, away, marketType = "jingcai") {
  return {
    fixture: { sequence: seq, homeTeam: home, awayTeam: away, marketType },
    pick: { code: "3", label: "主胜" },
    confidence: 50,
    probabilities: { win: 0.4, draw: 0.3, lose: 0.3 },
    scorePicks: { primary: "1-0", secondary: "2-1", source: "poisson-derived-from-lambda", primaryProbability: 0.12, secondaryProbability: 0.09, distribution: [{ score: "1-1", probability: 0.13 }, { score: "1-0", probability: 0.12 }, { score: "2-1", probability: 0.09 }] },
    halfFullPicks: { primary: "胜/胜", secondary: "平/胜", source: "poisson-half-joint", primaryProbability: 0.24, secondaryProbability: 0.14, primaryAlt: { halfFull: "平局-主胜", probability: 0.14 }, distribution: [{ halfFull: "主胜-主胜", probability: 0.24 }] },
    handicapPick: { line: 0, lineSource: "500.com-jczq", direction: "主胜", anchor: "wld", coverProbability: 0.55, expectedGoalDiff: 0.4, modelFairLine: 0, coverBreakdown: { home: 0.55, push: 0.2, away: 0.25 } },
    marketSnapshot: { europeanOdds: {} }
  };
}

test("自检:竞彩混入非业务日(周日)场次 → 报错", () => {
  const recommendations = {
    date: "2026-05-30",
    predictions: [stubPrediction("周六001", "神户", "鹿岛"), stubPrediction("周日001", "冈山", "浦和")],
    fourteen: { available: false, count: 0, selections: [] }
  };
  const audit = auditRecommendations(recommendations);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("非业务日")));
});

test("自检:竞彩跨源重复场次 → 报错", () => {
  const recommendations = {
    date: "2026-05-30",
    predictions: [stubPrediction("周六001", "神户胜利船", "鹿岛鹿角"), stubPrediction("周六001", "神户胜利船", "鹿岛鹿角")],
    fourteen: { available: false, count: 0, selections: [] }
  };
  const audit = auditRecommendations(recommendations);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("重复场次")));
});

test("自检:14 场存在但腿数非 14 → 报错", () => {
  const recommendations = {
    date: "2026-05-30",
    predictions: [stubPrediction("周六001", "神户", "鹿岛")],
    fourteen: { available: true, count: 13, selections: [] }
  };
  const audit = auditRecommendations(recommendations);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("14 场腿数")));
});

test("自检:比分来源是死表(scoreForOutcome)→ 报错", () => {
  const p = stubPrediction("周六001", "神户", "鹿岛");
  p.scorePicks.source = "hardcoded";
  const audit = auditRecommendations({ date: "2026-05-30", predictions: [p], fourteen: { available: false, count: 0, selections: [] } });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("比分非真实来源")));
});

test("自检:让球覆盖概率缺失(未真实跑出)→ 报错", () => {
  const p = stubPrediction("周六001", "神户", "鹿岛");
  p.handicapPick.coverProbability = null;
  const audit = auditRecommendations({ date: "2026-05-30", predictions: [p], fourteen: { available: false, count: 0, selections: [] } });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("让球覆盖概率缺失")));
});

test("自检:比分缺次选 → 报错", () => {
  const p = stubPrediction("周六001", "神户", "鹿岛");
  delete p.scorePicks.secondary;
  const audit = auditRecommendations({ date: "2026-05-30", predictions: [p], fourteen: { available: false, count: 0, selections: [] } });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((e) => e.message.includes("缺少比分次选")));
});

// jingcai-ingest-wc-singles(2026-06-08):scopeJingcaiFixtures 旧逻辑——存在任一周X前缀场时整批丢弃
//   所有数字 matchnum 场。500 静态 XML 的世界杯单场(数字编号如 4001,无周X前缀)在当日同时有
//   Playwright 周X 竞彩时会被静默删掉 → 真钱漏注。修后:数字编号场仅当与某周X场同队名(跨源重复)才丢。
test("scopeJingcaiFixtures 不误删数字编号世界杯单场(当日同时有周X Playwright 场)", () => {
  const fixtures = [
    { sequence: "周五001", homeTeam: "厄格里特", awayTeam: "埃夫斯堡", marketType: "jingcai", source: "500.com /jczq/ (Playwright)" },
    { sequence: "4001", homeTeam: "墨西哥", awayTeam: "南非", marketType: "jingcai", competition: "世界杯", source: "500.com-jczq-fallback" },
    { sequence: "4002", homeTeam: "韩国", awayTeam: "捷克", marketType: "jingcai", competition: "世界杯", source: "500.com-jczq-fallback" },
  ];
  const scoped = scopeJingcaiFixtures("2026-06-12", fixtures); // 2026-06-12=周五
  const teams = scoped.map((f) => `${f.homeTeam}-${f.awayTeam}`);
  assert.ok(teams.includes("墨西哥-南非"), "世界杯单场墨西哥vs南非不应被整批删掉");
  assert.ok(teams.includes("韩国-捷克"), "世界杯单场韩国vs捷克不应被整批删掉");
  assert.ok(teams.includes("厄格里特-埃夫斯堡"), "周X Playwright 场保留");
});

test("scopeJingcaiFixtures 跨源重复(数字编号 vs 周X 同队名)仍偏好周X去重", () => {
  const fixtures = [
    { sequence: "周五001", homeTeam: "尼斯", awayTeam: "圣埃蒂安", marketType: "jingcai", source: "500.com /jczq/ (Playwright)" },
    { sequence: "6001", homeTeam: "尼斯", awayTeam: "圣埃蒂安", marketType: "jingcai", source: "500.com-jczq-fallback" },
  ];
  const scoped = scopeJingcaiFixtures("2026-05-29", fixtures); // 2026-05-29=周五,两条同队名跨源
  const nice = scoped.filter((f) => f.homeTeam === "尼斯");
  assert.equal(nice.length, 1, "同队名跨源重复只留一条");
  assert.ok(sequenceWeekdayPrefix(nice[0].sequence), "去重应偏好周X前缀场(周五001)");
});

test("自检:干净的当日竞彩单(全周六、无重复、14场=14)不触发竞彩实质错误", () => {
  const recommendations = {
    date: "2026-05-30",
    predictions: [stubPrediction("周六001", "神户", "鹿岛"), stubPrediction("周六002", "大阪钢巴", "东京绿茵")],
    fourteen: { available: true, count: 14, selections: [] }
  };
  const audit = auditRecommendations(recommendations);
  // 只断言本档新增的三类竞彩实质检查不报错(与无关的逐场一致性校验解耦)
  const jingcaiErrors = audit.errors.filter((e) => /非业务日|重复场次|14 场腿数/.test(e.message));
  assert.deepEqual(jingcaiErrors, []);
});
