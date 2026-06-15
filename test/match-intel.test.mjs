import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePredictedXI, resolveLineupSide, resolveInjuries,
  resolveRecentForm, resolveNews, buildMatchIntel, buildIntelComparison, INTEL_TAG,
} from "../src/match-intel.js";

function lineupMatch(date, opponent, formation, names) {
  return { date, opponent, formation, starters: names.map((n, i) => ({ name: n, position: i === 0 ? "G" : "M" })) };
}
const XI_A = ["GK", "D1", "D2", "D3", "D4", "M1", "M2", "M3", "F1", "F2", "F3"];

test("aggregatePredictedXI: 样本不足返回 null(标缺不硬凑)", () => {
  assert.equal(aggregatePredictedXI([]), null);
  assert.equal(aggregatePredictedXI([lineupMatch("2026-06-01", "X", "4-3-3", XI_A)]), null); // 仅1场 < minMatches=2
});

test("aggregatePredictedXI: 频次聚合出最常用11人+众数阵型+provenance", () => {
  const hist = [
    lineupMatch("2026-06-10", "X", "4-3-3", XI_A),
    lineupMatch("2026-06-06", "Y", "4-3-3", XI_A),
    lineupMatch("2026-06-02", "Z", "4-2-3-1", [...XI_A.slice(0, 10), "SUB"]), // F3→SUB 一次
  ];
  const r = aggregatePredictedXI(hist);
  assert.equal(r.n, 3);
  assert.equal(r.formation, "4-3-3");        // 2票 > 4-2-3-1 的1票
  assert.equal(r.tag, INTEL_TAG.INFER);       // 预测=🔶,绝不标✅
  assert.equal(r.xi.length, 11);
  const names = r.xi.map((p) => p.name);
  assert.ok(names.includes("GK"));            // 3场全首发必入选
  assert.ok(!names.includes("SUB") || r.xi.find((p) => p.name === "SUB").starts === 1);
  assert.equal(r.basis[0].date, "2026-06-10"); // provenance 按日期降序
  assert.equal(r.formationParsed.defenders, 4);
});

test("aggregatePredictedXI: 决定性(同输入同输出,无随机)", () => {
  const hist = [lineupMatch("2026-06-10", "X", "4-3-3", XI_A), lineupMatch("2026-06-06", "Y", "4-3-3", XI_A)];
  assert.deepEqual(aggregatePredictedXI(hist), aggregatePredictedXI(hist));
});

test("resolveLineupSide: 已确认首发=✅,无确认有预测=🔶,都无=⚠️", () => {
  const confirmed = { starterCount: 11, confirmed: true, formation: "4-4-2", starters: XI_A.map((n) => ({ name: n, position: "M" })) };
  assert.equal(resolveLineupSide(confirmed, null).tag, INTEL_TAG.REAL);
  assert.equal(resolveLineupSide(confirmed, null).status, "已确认首发");

  const predicted = aggregatePredictedXI([lineupMatch("a", "x", "4-3-3", XI_A), lineupMatch("b", "y", "4-3-3", XI_A)]);
  const r2 = resolveLineupSide(null, predicted);
  assert.equal(r2.tag, INTEL_TAG.INFER);
  assert.equal(r2.status, "预测首发");
  assert.equal(r2.xi.length, 11);

  const r3 = resolveLineupSide(null, null);
  assert.equal(r3.tag, INTEL_TAG.MISS);
  assert.equal(r3.xi.length, 0);
});

test("resolveLineupSide: 未满11人或未confirmed 不冒充已确认", () => {
  const half = { starterCount: 7, confirmed: false, formation: "4-3-3", starters: XI_A.slice(0, 7).map((n) => ({ name: n })) };
  // 无预测兜底 → 标缺,不把残缺当确认
  assert.equal(resolveLineupSide(half, null).tag, INTEL_TAG.MISS);
});

test("resolveInjuries: 真实名单=✅,空=⚠️缺不编", () => {
  assert.equal(resolveInjuries(null).tag, INTEL_TAG.MISS);
  assert.equal(resolveInjuries({ injuries: [] }).tag, INTEL_TAG.MISS);
  const r = resolveInjuries({ source: "FPL", injuries: [{ player: { name: "Foden" }, status: "doubtful" }] });
  assert.equal(r.tag, INTEL_TAG.REAL);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes("Foden"));
});

test("resolveRecentForm: 国家队真赛果=✅(含热身赛)", () => {
  assert.equal(resolveRecentForm(null).tag, INTEL_TAG.MISS);
  const form = { played: 2, record: "1胜1平0负", list: [
    { date: "2026-06-10", ha: "主", vs: "Iceland", r: "胜", score: "2-0" },
    { date: "2026-06-06", ha: "客", vs: "Chile", r: "平", score: "1-1" },
  ] };
  const r = resolveRecentForm(form);
  assert.equal(r.tag, INTEL_TAG.REAL);
  assert.ok(r.text.includes("Iceland"));
  assert.ok(r.text.includes("含热身"));
});

test("resolveNews: 有文章=🔶带源, motivation 启发=🔶, 全无=⚠️", () => {
  assert.equal(resolveNews(null).tag, INTEL_TAG.MISS);
  const withMot = resolveNews({ motivation: { summary: "杯赛阶段轮换风险" } });
  assert.equal(withMot.tag, INTEL_TAG.INFER);
  assert.ok(withMot.text.includes("轮换"));
  const withArt = resolveNews({ articles: [{ title: "Star striker returns to training", url: "http://x", date: "20260612" }] });
  assert.equal(withArt.tag, INTEL_TAG.INFER);
  assert.equal(withArt.articles[0].url, "http://x");
});

test("buildMatchIntel: 组装完整对象 + maturity 计真实可追溯项", () => {
  const confirmed = { starterCount: 11, confirmed: true, formation: "4-4-2", starters: XI_A.map((n) => ({ name: n })) };
  const form = { played: 1, record: "1胜0平0负", list: [{ date: "2026-06-10", ha: "主", vs: "X", r: "胜", score: "1-0" }] };
  const intel = buildMatchIntel({
    fixture: { homeTeam: "西班牙", awayTeam: "克罗地亚" },
    lineupSide: { home: confirmed, away: null },
    homeForm: form, awayForm: null,
    injuriesLayer: { injuries: [{ player: { name: "P" }, status: "out" }] },
    newsLayer: null,
  });
  assert.equal(intel.match, "西班牙 vs 克罗地亚");
  assert.equal(intel.home.lineup.tag, INTEL_TAG.REAL);
  assert.equal(intel.away.lineup.tag, INTEL_TAG.MISS);
  assert.equal(intel.injuries.tag, INTEL_TAG.REAL);
  // 真实项:主首发✅ + 主近赛✅ + 伤停✅ = 3
  assert.equal(intel.maturity, 3);
});

test("buildIntelComparison: 主客对位研判(首发确定度+近期场均分+阵型对位+伤停分边)·纯展示不进概率", () => {
  const confH = { starterCount: 11, confirmed: true, formation: "4-3-3", starters: XI_A.map((n) => ({ name: n })) };
  const confA = { starterCount: 11, confirmed: true, formation: "5-4-1", starters: XI_A.map((n) => ({ name: n })) };
  const intel = buildMatchIntel({
    fixture: { homeTeam: "巴西", awayTeam: "塞尔维亚" },
    lineupSide: { home: confH, away: confA },
    homeForm: { played: 3, record: "3胜0平0负", list: [{ date: "2026-06-10", ha: "主", vs: "X", r: "胜", score: "2-0" }] },
    awayForm: { played: 3, record: "0胜1平2负", list: [{ date: "2026-06-10", ha: "客", vs: "Y", r: "负", score: "0-1" }] },
    // webIntel 带分边伤停
    webIntel: { injuries: [{ team: "巴西", name: "A", status: "伤" }, { team: "塞尔维亚", name: "B" }, { team: "塞尔维亚", name: "C" }], sources: ["x"] },
  });
  const cmp = intel.comparison;
  assert.ok(cmp, "comparison 必须挂上");
  assert.equal(cmp.formEdge.tag, INTEL_TAG.REAL);
  assert.equal(cmp.formEdge.homePpg, 3);          // 3胜=场均3分
  assert.equal(cmp.formEdge.awayPpg, Math.round((1 / 3) * 100) / 100); // 1平=场均0.33
  assert.ok(cmp.text.includes("场均分") && cmp.text.includes("主状态更佳"));
  assert.ok(cmp.tacticalNote && cmp.tacticalNote.text.includes("压上") && cmp.tacticalNote.text.includes("低位防守"));
  assert.ok(cmp.injuryNote.text.includes("塞尔维亚2人"), "伤停按队分边");
  assert.ok(cmp.note.includes("不进任何概率"), "诚实铁律:展示层不进概率");
});

test("buildIntelComparison: 数据全缺=⚠️缺不编造", () => {
  const intel = buildMatchIntel({ fixture: { homeTeam: "A", awayTeam: "B" }, lineupSide: null, homeForm: null, awayForm: null });
  const cmp = intel.comparison;
  assert.equal(cmp.tag, INTEL_TAG.MISS);
  assert.ok(cmp.text.includes("⚠️缺"));
});
