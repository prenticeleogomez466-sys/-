import assert from "node:assert/strict";
import test from "node:test";
import { computeGroupContext, teamStandingLine, teamProblemLine, matchGroupCell } from "../src/wc-group-context.js";

// 合成A组:已踢4场(各2场)→ A队6分 B队6分 C/D 0分;末轮 A-B、C-D
const groupsZh = { A: ["A队", "B队", "C队", "D队"] };
const results = [
  { home: "A队", away: "C队", ga: 2, gb: 0 },
  { home: "A队", away: "D队", ga: 1, gb: 0 },
  { home: "B队", away: "C队", ga: 1, gb: 0 },
  { home: "B队", away: "D队", ga: 3, gb: 0 },
];
const ctx = computeGroupContext({ groupsZh, results });

test("computeGroupContext 积分榜排序正确(同6分按净胜球)", () => {
  const tbl = ctx.byGroup.A.table;
  assert.equal(tbl[0].pts, 6);
  assert.equal(tbl[0].team, "B队"); // B净胜+4 > A净胜+3 → B第1
  assert.equal(tbl[1].team, "A队");
});

test("teamStandingLine 文字含组/名次/积分", () => {
  const s = teamStandingLine(ctx, "B队");
  assert.match(s, /A组第1/);
  assert.match(s, /6分/);
});

test("末轮:已锁定出线的队三种结果都出线", () => {
  // A、B 各6分,C、D 各0分,末轮A-B、C-D → A/B 必进前2
  const p = teamProblemLine(ctx, "A队");
  assert.match(p, /末轮vsB队/);
  assert.match(p, /胜→✅出线锁定/);
  assert.match(p, /负→✅出线锁定/); // 即便负,6分也压过C/D最多3分
});

test("末轮:0分弱队负则出局", () => {
  const p = teamProblemLine(ctx, "C队");
  assert.match(p, /末轮vsD队/);
  assert.match(p, /负→/);
  assert.ok(/出局|第3名/.test(p), "弱队负应出局或掉第3");
});

test("非末轮(剩2场)给当前位次", () => {
  const ctx2 = computeGroupContext({ groupsZh: { A: ["A队", "B队", "C队", "D队"] }, results: [{ home: "A队", away: "B队", ga: 1, gb: 0 }, { home: "C队", away: "D队", ga: 2, gb: 2 }] });
  const p = teamProblemLine(ctx2, "A队");
  assert.match(p, /还剩2场/);
});

test("matchGroupCell 双队拼一格", () => {
  const cell = matchGroupCell(ctx, "A队", "B队");
  assert.match(cell, /A队:/);
  assert.match(cell, /B队:/);
});
