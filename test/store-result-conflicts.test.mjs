import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findCrossFileResultConflicts } from "../src/result-sanity.js";

// ledger-settlement-2 / store-hygiene-2 守护(2026-06-11):
//   同一场物理比赛(真实赛日|主|客)跨业务日 store 文件的已结算副本,比分必须一致。
//   06-10 事故同源残留:sporttery 公告页错配把"摩洛哥4-0挪威"等假赛果写进 4 份副本,
//   真值 1-1 只在最新份 → 比分互斥共存、kickoff 已过 → premature 闸免检、backfill 不自愈,
//   假赛果 4 倍灌入 DC 拟合(挪威 attack 0.351)+ 球队画像(克罗地亚被记"负负负负胜")。
//   守护三点:①findCrossFileResultConflicts 抓互斥 ②一致副本/无赛果不误报
//   ③探针脚本喂毒必须 exit 1、干净 store exit 0。

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE = join(rootDir, "scripts", "audit-store-result-conflicts.mjs");

const fx = (over = {}) => ({
  homeTeam: "摩洛哥", awayTeam: "挪威", kickoff: "2026-06-08",
  date: "2026-06-02", competition: "国际赛",
  result: { home: 4, away: 0, halfHome: null, halfAway: null },
  ...over,
});

test("findCrossFileResultConflicts:同场跨文件比分互斥必须被抓出(假4-0 vs 真1-1)", () => {
  const entries = [
    { storeDate: "2026-06-02", fixture: fx() },
    { storeDate: "2026-06-03", fixture: fx({ date: "2026-06-03" }) },
    { storeDate: "2026-06-07", fixture: fx({ date: "2026-06-07", result: { home: 1, away: 1, halfHome: 0, halfAway: 1 } }) },
  ];
  const conflicts = findCrossFileResultConflicts(entries);
  assert.equal(conflicts.length, 1, "必须报出 1 组冲突");
  assert.equal(conflicts[0].key, "2026-06-08|摩洛哥|挪威");
  assert.deepEqual([...conflicts[0].scores].sort(), ["1-1", "4-0"]);
  assert.equal(conflicts[0].copies.length, 3);
});

test("findCrossFileResultConflicts:一致副本/未结算行/不同场次不误报", () => {
  const entries = [
    // 同场两份一致副本 → 不算冲突
    { storeDate: "2026-06-06", fixture: fx({ result: { home: 1, away: 1, halfHome: null, halfAway: null } }) },
    { storeDate: "2026-06-07", fixture: fx({ result: { home: 1, away: 1, halfHome: 0, halfAway: 1 } }) },
    // 未结算行 → 忽略
    { storeDate: "2026-06-08", fixture: fx({ result: null }) },
    // 不同真实赛日的同名对阵 → 不同键,不混
    { storeDate: "2026-06-09", fixture: fx({ kickoff: "2026-06-20", result: { home: 2, away: 0, halfHome: null, halfAway: null } }) },
  ];
  assert.deepEqual(findCrossFileResultConflicts(entries), []);
});

function runProbe(files) {
  const base = mkdtempSync(join(tmpdir(), "store-conflict-"));
  const dataDir = join(base, "data");
  mkdirSync(join(dataDir, "fixtures"), { recursive: true });
  for (const [name, fixtures] of Object.entries(files)) {
    writeFileSync(join(dataDir, "fixtures", `${name}.json`), JSON.stringify({ date: name, fixtures }, null, 1), "utf8");
  }
  const r = spawnSync(process.execPath, [PROBE], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, FOOTBALL_DATA_DIR: dataDir },
    timeout: 60000,
  });
  const cleanup = () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ } };
  return { r, cleanup };
}

test("探针:喂毒(同场两文件比分互斥)必须 exit 1 并点名冲突键", () => {
  const { r, cleanup } = runProbe({
    "2026-06-02": [fx()],
    "2026-06-07": [fx({ date: "2026-06-07", result: { home: 1, away: 1, halfHome: null, halfAway: null } })],
  });
  try {
    assert.equal(r.status, 1, `毒 store 必须 exit 1,stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /2026-06-08\|摩洛哥\|挪威/);
  } finally { cleanup(); }
});

test("探针:干净 store(一致副本)exit 0", () => {
  const { r, cleanup } = runProbe({
    "2026-06-02": [fx({ result: { home: 1, away: 1, halfHome: null, halfAway: null } })],
    "2026-06-07": [fx({ date: "2026-06-07", result: { home: 1, away: 1, halfHome: 0, halfAway: 1 } })],
  });
  try {
    assert.equal(r.status, 0, `干净 store 必须 exit 0,stderr=${r.stderr}`);
    assert.match(r.stdout, /无矛盾/);
  } finally { cleanup(); }
});
