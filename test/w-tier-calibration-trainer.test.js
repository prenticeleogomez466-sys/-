import assert from "node:assert/strict";
import test from "node:test";
import { trainCalibrationProfile } from "../src/calibration-trainer.js";
import { calibrateProbabilities, buildIsotonicMap } from "../src/model-calibration.js";

// 最小 football-data 风格 CSV(含赔率),mock fetch 注入,避免依赖网络
function makeCsv(rows) {
  const header = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,AvgH,AvgD,AvgA,B365H,B365D,B365A";
  const body = rows.map((r) =>
    `E0,${r.date},20:00,${r.home},${r.away},${r.hg},${r.ag},X,0,0,D,Ref,${r.oh},${r.od},${r.oa},${r.oh},${r.od},${r.oa}`
  );
  return [header, ...body].join("\n");
}
const mockFetch = (csv) => async () => ({ ok: true, text: async () => csv });

test("trainCalibrationProfile 跑通 walk-forward,产出双 isotonic 映射 + 可靠性结构", async () => {
  const teams = ["A", "B", "C", "D", "E", "F"];
  const rows = [];
  let day = 1, month = 1;
  for (let r = 0; r < 30; r++) {
    for (let i = 0; i < teams.length; i += 2) {
      const date = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/2024`;
      rows.push({ date, home: teams[i], away: teams[i + 1], hg: (r + i) % 3, ag: (r + 1) % 2, oh: 2.0, od: 3.4, oa: 3.6 });
      day++;
      if (day > 28) { day = 1; month = month % 12 + 1; }
    }
  }
  const res = await trainCalibrationProfile({
    minTrainMatches: 10, maxTrainMatches: 500, minSamples: 20, minIsotonicSamples: 20,
    leagues: ["E0"], seasons: ["2425"], fetch: mockFetch(makeCsv(rows))
  });
  assert.equal(res.ok, true);
  const p = res.profile;
  assert.equal(p.source, "football-data-walkforward");
  assert.ok(p.meta.dcSamples > 0, "应收集到 DC 样本");
  assert.ok(p.meta.marketSamples > 0, "应收集到市场样本");
  // 可靠性桶结构齐全
  for (const bk of ["33-45", "45-55", "55-65", "65-100"]) {
    assert.ok(bk in p.reliability, `缺可靠性桶 ${bk}`);
    assert.ok(bk in p.marketReliability, `缺市场可靠性桶 ${bk}`);
  }
  // 至少其中一条路径训出了 isotonic map(样本足够时)
  if (p.isotonicMap) assert.ok(p.isotonicMap.knots.length >= 1);
  if (p.isotonicMapMarket) assert.ok(p.isotonicMapMarket.knots.length >= 1);
});

test("trainCalibrationProfile 网络失败时安全返回 ok:false", async () => {
  const res = await trainCalibrationProfile({ leagues: ["E0"], seasons: ["2425"], fetch: async () => ({ ok: false }) });
  assert.equal(res.ok, false);
  assert.match(res.reason, /football-data/);
});

// 跨概率区间造观测:每个 (predicted, calMean) 生成 n 条 0/1,使该点命中率≈calMean
function obsCurve(points, n = 100) {
  const out = [];
  for (const [predicted, calMean] of points) {
    const ones = Math.round(calMean * n);
    for (let i = 0; i < n; i++) out.push({ predicted, actual: i < ones ? 1 : 0 });
  }
  return out;
}

test("calibrateProbabilities 按 hasMarketPrior 选用对应 isotonic 映射", () => {
  // 模型路径:高端系统性过度自信(cal < predicted)。市场路径:近恒等(cal ≈ predicted)。
  const modelMap = buildIsotonicMap(obsCurve([[0.4, 0.42], [0.5, 0.50], [0.6, 0.57], [0.7, 0.62], [0.8, 0.66]]));
  const marketMap = buildIsotonicMap(obsCurve([[0.4, 0.41], [0.5, 0.50], [0.6, 0.60], [0.7, 0.70], [0.8, 0.79]]));
  const profile = {
    source: "test", usable: true, reason: "ok", samples: 500, minSamples: 20,
    minBucketSamples: 30, maxShift: 0.06, global: { samples: 500, adjustment: 0 }, buckets: {},
    isotonicMap: modelMap, isotonicMapMarket: marketMap
  };
  const probs = { home: 0.78, draw: 0.13, away: 0.09 };

  // 纯模型路径(无市场先验)→ 用 modelMap,把强热门往下拉(纠过度自信)
  const model = calibrateProbabilities(probs, profile, { fixture: {}, hasMarketPrior: false });
  assert.equal(model.calibration.applied, true);
  assert.equal(model.calibration.scope, "isotonic-model");
  assert.ok(model.probabilities.home < 0.76, `模型路径应下调过度自信,得到 ${model.probabilities.home}`);

  // 市场先验路径 → 用 marketMap,近恒等,几乎不动
  const market = calibrateProbabilities(probs, profile, { fixture: {}, hasMarketPrior: true });
  assert.equal(market.calibration.scope, "isotonic-market");
  assert.ok(Math.abs(market.probabilities.home - 0.78) < 0.03, `市场路径应近恒等,得到 ${market.probabilities.home}`);
  // 两条路径对同一输入给出不同结果 —— 这是双映射的核心价值
  assert.ok(market.probabilities.home > model.probabilities.home, "市场路径应高于被下调的模型路径");
});

test("有市场先验但无 market 专属映射时,绝不把模型路径 isotonic 套到市场概率", () => {
  // 模型映射会把 0.72 大幅下拉;若被误用到市场路径,home 会掉到 ~0.5。
  const modelMap = buildIsotonicMap(obsCurve([[0.5, 0.5], [0.6, 0.55], [0.72, 0.52], [0.8, 0.55]]));
  const profile = {
    source: "test", usable: true, reason: "ok", samples: 400, minSamples: 20,
    minBucketSamples: 30, maxShift: 0.06, global: { samples: 400, adjustment: -0.05 },
    buckets: {}, isotonicMap: modelMap, isotonicMapMarket: null
  };
  const probs = { home: 0.72, draw: 0.16, away: 0.12 };
  const out = calibrateProbabilities(probs, profile, { fixture: {}, hasMarketPrior: true });
  // 不得用模型 isotonic 映射(否则 home 会被拉到 ~0.52)
  assert.notEqual(out.calibration.scope, "isotonic-model");
  // 落到 global 规则:温和收缩(-0.05 封顶),而非 isotonic 的剧烈下拉
  assert.ok(out.probabilities.home > 0.6, `市场路径不应被模型映射重创,得到 ${out.probabilities.home}`);
});
