import test from "node:test";
import assert from "node:assert/strict";
import { STAGE, computeWcRecap, collectWcPlayed } from "../scripts/wc-recap.mjs";

test("STAGE 按 FIFA2026 真实赛程日期分阶段", () => {
  assert.equal(STAGE("2026-06-11"), "group");
  assert.equal(STAGE("2026-06-27"), "group");
  assert.equal(STAGE("2026-06-30"), "r32");
  assert.equal(STAGE("2026-07-05"), "r16");
  assert.equal(STAGE("2026-07-10"), "qf");
  assert.equal(STAGE("2026-07-15"), "sf");
  assert.equal(STAGE("2026-07-19"), "final");
});

test("computeWcRecap:出线/冠军/爆冷打分(合成数据)", () => {
  const id = (x) => String(x);
  const base = [
    { team: "A", en: "A", advance: 0.95, champion: 0.30 },
    { team: "B", en: "B", advance: 0.90, champion: 0.20 },
    { team: "C", en: "C", advance: 0.70, champion: 0.10 }, // 高预测却出局 → bust
    { team: "D", en: "D", advance: 0.40, champion: 0.05 }, // 低预测却出线 → hit
  ];
  // 合成:72场小组(用A/B/C/D凑齐72场计数)+ 淘汰赛 A、B、D 进 r32,决赛 A 胜 B
  const played = [];
  for (let i = 0; i < 72; i++) played.push({ stage: "group", home: "A", away: "B", hg: 1, ag: 0 });
  played.push({ stage: "r32", home: "A", away: "X", hg: 2, ag: 0 });
  played.push({ stage: "r32", home: "B", away: "Y", hg: 1, ag: 0 });
  played.push({ stage: "r32", home: "D", away: "Z", hg: 1, ag: 0 }); // D 爆冷出线
  played.push({ stage: "final", home: "A", away: "B", hg: 1, ag: 0 }); // A 夺冠
  const r = computeWcRecap(base, played, id);
  assert.equal(r.groupDone, true);
  assert.equal(r.champion, "A");
  assert.equal(r.champRow.team, "A");
  // A,B,D 出线(advanced=1),C 出局(0)。Brier=mean[(.95-1)²+(.90-1)²+(.70-0)²+(.40-1)²]
  const expected = ((0.95-1)**2 + (0.90-1)**2 + (0.70-0)**2 + (0.40-1)**2) / 4;
  assert.ok(Math.abs(r.advanceBrier - expected) < 1e-9, `Brier ${r.advanceBrier} vs ${expected}`);
  assert.ok(r.busts.some((s) => s.startsWith("C")), "C 应为爆冷出局");
  assert.ok(r.hits.some((s) => s.startsWith("D")), "D 应为黑马命中");
});

test("computeWcRecap:小组赛未完时不算 Brier", () => {
  const base = [{ team: "A", en: "A", advance: 0.9, champion: 0.3 }];
  const r = computeWcRecap(base, [{ stage: "group", home: "A", away: "B", hg: 1, ag: 0 }], (x) => String(x));
  assert.equal(r.groupDone, false);
  assert.equal(r.advanceBrier, null);
});

// ── 2026-06-10 体检:窗口按比赛日过滤+对阵去重(collectWcPlayed)──
test("collectWcPlayed: 06-10店内kickoff=6/12的WC场不漏", () => {
  const store = { "2026-06-10": { fixtures: [
    { homeTeam: "墨西哥", awayTeam: "南非", competition: "世界杯", kickoff: "2026-06-12", result: { home: 2, away: 0 } },
  ] } };
  const played = collectWcPlayed(Object.keys(store), (d) => store[d]);
  assert.equal(played.length, 1);
  assert.equal(played[0].date, "2026-06-12");
  assert.equal(played[0].stage, "group");
});
test("collectWcPlayed: 同对阵跨store去重+比赛日窗口外剔除", () => {
  const store = {
    "2026-06-10": { fixtures: [
      { homeTeam: "墨西哥", awayTeam: "南非", competition: "世界杯", kickoff: "2026-06-12", result: { home: 2, away: 0 } },
      { homeTeam: "葡萄牙", awayTeam: "尼日利亚", competition: "国际赛", kickoff: "2026-06-11", result: { home: 3, away: 0 } },
    ] },
    "2026-06-11": { fixtures: [
      { homeTeam: "南非", awayTeam: "墨西哥", competition: "World Cup", kickoff: "2026-06-12", result: { home: 0, away: 2 } },
      { homeTeam: "巴西", awayTeam: "摩洛哥", competition: "世界杯", kickoff: "2026-06-09", result: { home: 1, away: 0 } },
    ] },
  };
  const played = collectWcPlayed(Object.keys(store), (d) => store[d]);
  assert.equal(played.length, 1, "墨南去重为1场;国际赛非WC剔除;6/09窗口外剔除");
});
