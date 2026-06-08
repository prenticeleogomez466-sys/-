import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFiveHundredRows, cleanTeamName } from "../src/jingcai-fivehundred-stage.js";

const ROWS = [
  ["周五001", "瑞超", "05-30 01:00", "[16]厄格里特 VS 埃夫斯堡[4]", "0 +1", "3.86 3.50 1.71 1.87 3.50 3.25"],
  ["周五009", "法甲", "05-30 02:45", "尼斯 VS 圣埃蒂安", "单关 0 -1", "1.85 3.10 3.75 3.92 3.30 1.75"],
];

test("cleanTeamName 去掉排名标记", () => {
  assert.equal(cleanTeamName("[16]厄格里特"), "厄格里特");
  assert.equal(cleanTeamName("埃夫斯堡[4]"), "埃夫斯堡");
  assert.equal(cleanTeamName("尼斯"), "尼斯");
});

// jingcai-ingest-wc-singles(2026-06-08):已开售世界杯单场(matchnum 4001+,如墨西哥vs南非)装配后
//   须 marketType=jingcai、competition 保留"世界杯"(供海拔/天气/出线%上下文)、欧赔/让球不喂反、
//   无 DOM 让球线时 jingcaiHandicap=null 不兜底(守绝不兜底铁律)。
test("世界杯单场装配:marketType=jingcai、competition=世界杯、欧赔/让球不喂反、让球线缺失=null", () => {
  // 行格式:[seq, league, kickoff, teamCell, handicapCell, oddsCell]
  //   oddsCell 前三=让0欧赔(胜平负),后三=让球胜平负;handicapCell="0"=纯让0无整数线 → 让球线 null
  const rows = [
    ["4001", "世界杯", "06-12 03:00", "墨西哥 VS 南非", "0", "1.34 3.92 7.85 2.20 3.28 2.70"],
  ];
  const { fixtures, snapshots } = parseFiveHundredRows(rows, "2026-06-08", "2026-06-08T00:00:00.000Z");
  assert.equal(fixtures.length, 1);
  const f = fixtures[0];
  assert.equal(f.marketType, "jingcai");
  assert.equal(f.competition, "世界杯", "league=世界杯 须原样保留供赛会上下文");
  assert.equal(f.homeTeam, "墨西哥");
  assert.equal(f.awayTeam, "南非");

  const s = snapshots[0];
  assert.equal(s.marketType, "jingcai");
  assert.equal(s.competition, "世界杯");
  // 欧赔(让0胜平负)= 前三;让球胜平负 = 后三;两者来源不互换
  assert.equal(s.europeanOdds.current.home, 1.34);
  assert.equal(s.europeanOdds.current.away, 7.85);
  assert.equal(s.handicapOdds.current.home, 2.20);
  assert.equal(s.handicapOdds.current.away, 2.70);
  // 一致性:胜平负热门方(主队1.34)赔率 ≤ 让球同方(2.20),证明没喂反
  assert.ok(s.europeanOdds.current.home <= s.handicapOdds.current.home, "胜平负热门赔率应≤让球同方(未喂反)");
  // 无整数让球线("0"无符号)→ null 不兜底
  assert.equal(s.jingcaiHandicap, null, "让球线缺失须 null,不强行填 0");
});

test("世界杯单场带真实让球线(handicapCell 含符号整数)→ jingcaiHandicap.line 解析正确", () => {
  const rows = [
    ["4002", "世界杯", "06-12 10:00", "韩国 VS 捷克", "0 -1", "2.43 2.84 2.74 5.80 4.05 1.41"],
  ];
  const { snapshots } = parseFiveHundredRows(rows, "2026-06-08", "2026-06-08T00:00:00.000Z");
  assert.equal(snapshots[0].jingcaiHandicap.line, -1);
});

test("parseFiveHundredRows 解析对阵、让0欧赔、让球赔率", () => {
  const { fixtures, snapshots } = parseFiveHundredRows(ROWS, "2026-05-29", "2026-05-29T00:00:00.000Z");
  assert.equal(fixtures.length, 2);
  assert.equal(snapshots.length, 2);

  const f0 = fixtures[0];
  assert.equal(f0.homeTeam, "厄格里特");
  assert.equal(f0.awayTeam, "埃夫斯堡");
  assert.equal(f0.marketType, "jingcai");
  assert.equal(f0.competition, "瑞超");
  assert.equal(f0.kickoff, "2026-05-30 01:00");
  assert.ok(f0.id.startsWith("jc-2026-05-29-"));

  // 让0档欧赔 = 前三个;让N档让球 = 后三个
  const s0 = snapshots[0];
  assert.deepEqual(s0.europeanOdds.current, { home: 3.86, draw: 3.5, away: 1.71 });
  assert.deepEqual(s0.handicapOdds.current, { home: 1.87, draw: 3.5, away: 3.25 });
  assert.equal(s0.europeanOdds.initial.home, s0.europeanOdds.current.home); // 单次抓取 initial=current
  assert.equal(s0.collectedAt, "2026-05-29T00:00:00.000Z");
});

test("缺主客队的行被跳过,不抛错", () => {
  const { fixtures } = parseFiveHundredRows([["X", "联赛", "05-30 01:00", "只有一个队", "0", "2.0 3.0 4.0"]], "2026-05-29");
  assert.equal(fixtures.length, 0);
});

test("赔率 ≤1 视为无效(过滤庄家占位)", () => {
  const { snapshots } = parseFiveHundredRows([["X", "联赛", "05-30 01:00", "甲 VS 乙", "0", "1.00 0 0 2.0 3.0 4.0"]], "2026-05-29");
  assert.equal(snapshots[0].europeanOdds, null); // 让0 无效
  assert.deepEqual(snapshots[0].handicapOdds.current, { home: 2.0, draw: 3.0, away: 4.0 });
});
