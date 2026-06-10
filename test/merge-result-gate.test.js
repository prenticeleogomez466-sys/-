import assert from "node:assert/strict";
import test from "node:test";
import { mergeAuthorizedFixtures } from "../src/authorized-fixtures.js";

// merge 路径开赛闸守护(2026-06-10 对抗审计确认缺陷):
// store"开赛前无赛果"不变量此前只由 backfill/detox 单方面保证,mergeAuthorizedFixtures
// 的 result 合并无 hasKickedOff 闸 → detox 清完 1-2 分钟即被授权源 sync 重写复活
// (实测 06-09 #2203 阿根廷vs冰岛 kickoff="2026-06-10" date-only 未到 23:59,
//  api-football:1540357 officialStatus=FT 的 result=3-0 旁路写回)。
// 本组测试锁死:① 未开赛场 merge 绝不写 result(detox 不再被旁路);
//             ② 开赛后下一轮 sync 正常回填;
//             ③ sameFixture 日期约束收紧为 ≤1 天(恰差 2 天的同对阵热身赛不再错配)。

const STORE_2203 = {
  id: "jc-2026-06-09-2203-阿根廷-冰岛",
  date: "2026-06-09",
  kickoff: "2026-06-10", // date-only → 闸口径=06-10 23:59:59+08:00
  competition: "国际赛",
  homeTeam: "阿根廷",
  awayTeam: "冰岛",
  round: "Friendly International",
  marketType: "jingcai",
  sequence: "2203",
  source: "500.com /jczq/ (Playwright)",
  officialStatus: "scraped-fallback",
  officialFixtureId: null,
  result: null, // detox 刚清洗过
};

const AUTHORIZED_FT = {
  id: "api-football-1540357",
  date: "2026-06-09",
  kickoff: "23:00",
  competition: "Friendlies",
  homeTeam: "阿根廷",
  awayTeam: "冰岛",
  round: "",
  sequence: 1,
  source: "api-football:1540357",
  officialStatus: "FT",
  officialFixtureId: 1540357,
  result: { home: 3, away: 0, halfHome: 1, halfAway: 0 },
};

test("merge 开赛闸:未开赛场即便授权源带 FT result 也绝不写入(detox 不再被旁路复活)", () => {
  // 复现实测时刻:2026-06-10 18:09 北京时间,< kickoff 闸口径 23:59:59
  const now = new Date("2026-06-10T18:09:48+08:00").getTime();
  const { fixtures, matched } = mergeAuthorizedFixtures([STORE_2203], [AUTHORIZED_FT], { now });
  assert.equal(matched, 1, "应匹配上同一场(闸是不写 result,不是拒绝匹配)");
  assert.equal(fixtures[0].result, null, "未开赛场 result 必须保持 null");
  // 元数据(锚定/状态/source)照常合并,开赛后下一轮 sync 凭锚定直接回填
  assert.equal(fixtures[0].officialFixtureId, 1540357);
  assert.match(fixtures[0].source, /api-football:1540357/);
});

test("merge 开赛闸:开赛后(过 23:59 宁晚判口径)下一轮 sync 正常回填 result", () => {
  const now = new Date("2026-06-11T00:30:00+08:00").getTime();
  const { fixtures } = mergeAuthorizedFixtures([STORE_2203], [AUTHORIZED_FT], { now });
  assert.deepEqual(fixtures[0].result, { home: 3, away: 0, halfHome: 1, halfAway: 0 });
});

test("merge 开赛闸:有显式 HH:mm 的场按真实开球时刻判,开赛前不写、开赛后写", () => {
  const store = { ...STORE_2203, kickoff: "2026-06-10 20:00" };
  const before = mergeAuthorizedFixtures([store], [AUTHORIZED_FT], { now: new Date("2026-06-10T19:59:00+08:00").getTime() });
  assert.equal(before.fixtures[0].result, null);
  const after = mergeAuthorizedFixtures([store], [AUTHORIZED_FT], { now: new Date("2026-06-10T20:01:00+08:00").getTime() });
  assert.deepEqual(after.fixtures[0].result, { home: 3, away: 0, halfHome: 1, halfAway: 0 });
});

test("merge 开赛闸:kickoff 完全缺失/不可解析 → hasKickedOff=false → 绝不写 result(不兜底)", () => {
  const store = { ...STORE_2203, kickoff: "", date: "" };
  const authorized = { ...AUTHORIZED_FT, kickoff: "", date: "" };
  const { fixtures, matched } = mergeAuthorizedFixtures([store], [authorized], { now: Date.now() });
  assert.equal(matched, 1);
  assert.equal(fixtures[0].result, null);
});

test("sameFixture 日期约束收紧 ≤1 天:恰差 2 天的同对阵(热身赛 vs 正赛)不再错配", () => {
  const store = { ...STORE_2203, kickoff: "2026-06-12", officialFixtureId: null }; // 正赛 06-12
  const friendly = { ...AUTHORIZED_FT, date: "2026-06-10", officialFixtureId: 999 }; // 热身赛 06-10,差 2 天
  const { matched, fixtures } = mergeAuthorizedFixtures([store], [friendly], { now: new Date("2026-06-13T00:00:00+08:00").getTime() });
  assert.equal(matched, 0, "差 2 天的同对阵必须判为不同场");
  assert.equal(fixtures[0].result, null);
});

test("sameFixture 日期约束:差 1 天(跨源时区漂移合法上限)仍正常匹配", () => {
  // store 真实比赛日 06-10(kickoff 内嵌),authorized 业务日 06-09 → 差 1 天,须匹配
  const now = new Date("2026-06-11T00:30:00+08:00").getTime();
  const { matched, fixtures } = mergeAuthorizedFixtures([STORE_2203], [{ ...AUTHORIZED_FT, officialFixtureId: null, source: "espn:x" }], { now });
  assert.equal(matched, 1);
  assert.deepEqual(fixtures[0].result, { home: 3, away: 0, halfHome: 1, halfAway: 0 });
});

test("officialFixtureId 双边一致时仍直接判同场(锚定优先于日期约束)", () => {
  const store = { ...STORE_2203, officialFixtureId: 1540357, kickoff: "2026-06-12" };
  const now = new Date("2026-06-13T00:00:00+08:00").getTime();
  const { matched } = mergeAuthorizedFixtures([store], [AUTHORIZED_FT], { now });
  assert.equal(matched, 1);
});
