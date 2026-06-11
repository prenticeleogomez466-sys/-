import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ledger-settlement-1 / ledger-settlement-2 守护(2026-06-11):
//   ①学习域隔离落到 DC 拟合层:fitFromFixtureStore 绝不吃 国际赛/世界杯/友谊 等软赛事
//     (0610 审计裁决 club-only 的延伸)。否则俱乐部 DC 把国家队按 1-4 场薄样本学成
//     垃圾系数(伊拉克 1 场=西班牙级 attack 0.966),且在 prediction-engine:434 短路掉
//     正确的国家队 Elo 先验 → 伊拉克 67% 胜挪威、🟢建议下注 方向整体颠倒。
//   ②同场跨业务日副本去重:同一场物理比赛(真实赛日|主|客)在 store 多个文件各有一份
//     已结算副本,拟合必须只计 1 次(假赛果事故里"摩洛哥4-0挪威"被 4 倍灌入,
//     挪威 attack 被压到 0.351);保留最新业务日副本(后到的 jc500 真值优先)。
//
// 全程 FOOTBALL_DATA_DIR 指向临时目录,绝不碰真实 D:\football-model-data。

const base = mkdtempSync(join(tmpdir(), "dc-isolation-"));
const dataDir = join(base, "data");
mkdirSync(join(dataDir, "fixtures"), { recursive: true });
process.env.FOOTBALL_DATA_DIR = dataDir;

const CLUB_TEAMS = ["测甲", "测乙", "测丙", "测丁", "测戊", "测己"];
let seq = 0;
const club = (home, away, h, a, day) => ({
  id: `club-${++seq}`, date: day, kickoff: `${day} 20:00`, competition: "英超",
  homeTeam: home, awayTeam: away, marketType: "daily",
  result: { home: h, away: a, halfHome: null, halfAway: null },
});
const intl = (storeDay, h, a) => ({
  id: `intl-${++seq}`, date: storeDay, kickoff: "2026-05-24", competition: "国际赛",
  homeTeam: "摩洛哥", awayTeam: "挪威", marketType: "shengfucai",
  result: { home: h, away: a, halfHome: null, halfAway: null },
});

// 12 场俱乐部常规赛(真实赛日=各自业务日,无重复)
const files = {
  "2026-05-01": [club("测甲", "测乙", 2, 0, "2026-05-01"), club("测丙", "测丁", 1, 1, "2026-05-01"), club("测戊", "测己", 0, 2, "2026-05-01")],
  "2026-05-08": [club("测乙", "测丙", 3, 1, "2026-05-08"), club("测丁", "测戊", 2, 2, "2026-05-08"), club("测己", "测甲", 0, 1, "2026-05-08")],
  "2026-05-15": [club("测甲", "测丙", 1, 0, "2026-05-15"), club("测乙", "测戊", 2, 1, "2026-05-15"), club("测丁", "测己", 3, 0, "2026-05-15")],
  "2026-05-22": [club("测丙", "测戊", 2, 0, "2026-05-22"), club("测己", "测乙", 1, 2, "2026-05-22"), club("测丁", "测甲", 0, 0, "2026-05-22")],
};
// 同一场俱乐部比赛(真实赛日 2026-05-23)在两个业务日文件各留一份已结算副本 → 必须只计 1 次
const dupClub = (storeDay) => ({
  id: `dup-${++seq}`, date: storeDay, kickoff: "2026-05-23 20:00", competition: "英超",
  homeTeam: "测甲", awayTeam: "测戊", marketType: "daily",
  result: { home: 4, away: 0, halfHome: null, halfAway: null },
});
files["2026-05-23"] = [dupClub("2026-05-23")];
files["2026-05-24"] = [dupClub("2026-05-24"), intl("2026-05-24", 4, 0)];
// 国际赛同场再留 3 份假比分副本(模拟 06-10 事故残留:跨文件互斥也好、一致也好,都不得进拟合)
files["2026-05-25"] = [intl("2026-05-25", 4, 0)];
files["2026-05-26"] = [intl("2026-05-26", 4, 0)];
files["2026-05-27"] = [intl("2026-05-27", 1, 1)];

for (const [day, fixtures] of Object.entries(files)) {
  writeFileSync(join(dataDir, "fixtures", `${day}.json`), JSON.stringify({ date: day, fixtures }, null, 1), "utf8");
}

const { fitFromFixtureStore } = await import("../src/dixon-coles-engine.js");
const fitted = fitFromFixtureStore({ minMatches: 10, beforeDate: "2026-05-28" });

test("学习域隔离:国际赛/国家队绝不进俱乐部 DC 拟合(伊拉克67%胜挪威方向颠倒的根因)", () => {
  assert.equal(fitted.usable, true, `拟合应可用(13 场俱乐部样本),实得 ${fitted.reason ?? ""}`);
  assert.ok(!("摩洛哥" in fitted.teams), "国家队 摩洛哥 不得出现在俱乐部 DC 训练集");
  assert.ok(!("挪威" in fitted.teams), "国家队 挪威 不得出现在俱乐部 DC 训练集");
  for (const t of CLUB_TEAMS) assert.ok(t in fitted.teams, `俱乐部 ${t} 应保留在训练集`);
});

test("同场跨文件副本去重:同一场物理比赛只计 1 次(假赛果 4 倍灌入不复现)", () => {
  // 12 场常规 + 1 场重复副本(2份只计1) = 13;国际赛 5 份副本全部隔离不计。
  assert.equal(fitted.matches, 13, `拟合样本应=13(12常规+重复场1),实得 ${fitted.matches}`);
});
