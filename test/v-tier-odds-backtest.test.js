import assert from "node:assert/strict";
import test from "node:test";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { runWalkForwardWithOdds } from "../src/walkforward-backtest-odds.js";

// 构造一个最小 football-data 风格 CSV(含赔率列),用 mock fetch 注入,避免依赖网络
function makeCsv(rows) {
  const header = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,AvgH,AvgD,AvgA,B365H,B365D,B365A";
  const body = rows.map((r) =>
    `E0,${r.date},20:00,${r.home},${r.away},${r.hg},${r.ag},X,0,0,D,Ref,${r.oh},${r.od},${r.oa},${r.oh},${r.od},${r.oa}`
  );
  return [header, ...body].join("\n");
}

function mockFetch(csv) {
  return async () => ({ ok: true, text: async () => csv });
}

test("footballdata-loader 解析赛果+赔率,日期转 ISO,赔率去 vig 归一", async () => {
  const csv = makeCsv([
    { date: "16/08/2024", home: "Man United", away: "Fulham", hg: 1, ag: 0, oh: 1.6, od: 4.2, oa: 5.25 }
  ]);
  const res = await loadFootballDataMatches({ leagues: ["E0"], seasons: ["2425"], fetch: mockFetch(csv) });
  assert.equal(res.ok, true);
  const m = res.matches[0];
  assert.equal(m.date, "2024-08-16");
  assert.equal(m.homeGoals, 1);
  assert.ok(m.odds, "应解析出赔率隐含概率");
  const sum = m.odds.home + m.odds.draw + m.odds.away;
  assert.ok(Math.abs(sum - 1) < 1e-9, "去 vig 后应归一到 1");
  assert.ok(m.odds.home > m.odds.away, "强主队隐含主胜>客胜");
});

test("runWalkForwardWithOdds 五臂结构完整 + market 臂有数据(mock 数据)", async () => {
  // 造足够多的历史(>minTrain)让 DC 可拟合,测试日在末尾
  const teams = ["A", "B", "C", "D", "E", "F"];
  const rows = [];
  let day = 1;
  for (let r = 0; r < 12; r++) {
    for (let i = 0; i < teams.length; i += 2) {
      const date = `${String(day).padStart(2, "0")}/01/2024`;
      rows.push({ date, home: teams[i], away: teams[i + 1], hg: (r + i) % 3, ag: (r + 1) % 2, oh: 2.0, od: 3.4, oa: 3.6 });
      day++;
      if (day > 28) day = 1;
    }
  }
  const res = await runWalkForwardWithOdds({
    testDates: 5, minTrainMatches: 10, maxTrainMatches: 500,
    leagues: ["E0"], seasons: ["2425"], fetch: mockFetch(makeCsv(rows))
  });
  assert.equal(res.ok, true);
  for (const k of ["market", "dc", "blend", "blendFusion", "blendFusionCal"]) {
    assert.ok(res.arms[k], `缺 ${k} 臂`);
    assert.ok(res.arms[k].accuracy >= 0 && res.arms[k].accuracy <= 1, `${k} 命中率越界`);
  }
});
