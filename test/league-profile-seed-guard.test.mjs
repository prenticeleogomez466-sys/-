/**
 * 守护测试(finding: learning-isolation-1, 2026-06-11):
 * 国际赛 ESPN 六年先验 seed(n=600, drawRate=0.308)绝不允许被短窗偏样本顶掉。
 * 实锤缺陷:fixture store 12 天窗口攒出 124 条国际赛带果行(drawRate 0.129/homeAdv 2.314),
 * build-league-profiles.mjs 的 `a.length >= 120` 闸静默顶掉 seed →
 * scenario-synthesizer drawDim(histDraw>=0.30)永不触发、deep-fusion 反向输出"平局率偏低/偏大球",
 * 把平局盲区(复盘头号失败根因)的缓解措施在国际赛场反向。
 * 修复语义:seed 联赛只有 store 样本 n>=500 且时间跨度 >=365 天才允许用 store 拟合顶掉先验。
 * 端到端跑真实脚本(子进程+沙箱 store),不 mock 内部函数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(repoRoot, "scripts", "build-league-profiles.mjs");

/** 在沙箱 data 目录写一批 fixture 日文件。rowsByDate = { 'YYYY-MM-DD': [[h,a],...] } */
function writeStore(dataDir, rowsByDate) {
  const fixDir = join(dataDir, "fixtures");
  mkdirSync(fixDir, { recursive: true });
  for (const [date, rows] of Object.entries(rowsByDate)) {
    const fixtures = rows.map(([h, a], i) => ({
      homeTeam: `主队${i}`, awayTeam: `客队${i}`, competition: "国际赛",
      date, result: { home: h, away: a },
    }));
    writeFileSync(join(fixDir, `${date}.json`), JSON.stringify({ date, source: "test", fixtures }), "utf8");
  }
}

function runBuild(dataDir, exportDir) {
  mkdirSync(exportDir, { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, FOOTBALL_DATA_DIR: dataDir, FOOTBALL_EXPORT_DIR: exportDir },
    encoding: "utf8", timeout: 60000,
  });
  assert.equal(r.status, 0, `build-league-profiles 退出码非0: ${r.stderr}`);
  return JSON.parse(readFileSync(join(exportDir, "league-profiles.json"), "utf8")).leagues;
}

/** 生成 n 条偏样本比分(主大胜为主,平局极少)——复刻实锤污染分布 */
function biasedRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(i % 10 === 0 ? [1, 1] : i % 3 === 0 ? [3, 0] : [2, 1]);
  return rows;
}

test("learning-isolation-1:12天窗口124条偏样本绝不顶掉国际赛六年seed", () => {
  const base = mkdtempSync(join(tmpdir(), "lp-seed-guard-"));
  try {
    // 复刻实锤:2026-05-29..06-09 共 12 天 124 条(逐日 1,12,10,16,14,16,18,14,13,4,3,3)
    const counts = [1, 12, 10, 16, 14, 16, 18, 14, 13, 4, 3, 3];
    const rowsByDate = {};
    const start = Date.parse("2026-05-29");
    counts.forEach((c, di) => {
      const d = new Date(start + di * 86400000).toISOString().slice(0, 10);
      rowsByDate[d] = biasedRows(c);
    });
    writeStore(join(base, "data"), rowsByDate);
    const leagues = runBuild(join(base, "data"), join(base, "exports"));
    const p = leagues["国际赛"];
    assert.ok(p, "国际赛画像必须存在");
    assert.equal(p.source, "espn-friendly-6yr-seed", `12天偏样本顶掉了seed: ${JSON.stringify(p)}`);
    assert.equal(p.drawRate, 0.308, "seed 平局率 0.308 必须保留(drawDim>=0.30 提示线)");
    assert.equal(p.n, 600, "seed n=600 必须保留");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("learning-isolation-1:store样本 n>=500 且跨度>=1年 才允许真数据顶掉seed", () => {
  const base = mkdtempSync(join(tmpdir(), "lp-seed-guard2-"));
  try {
    // 520 条横跨 2025-01-01..2026-06-01(>1年):合格的长窗真数据,store 拟合应生效
    const rowsByDate = {};
    const start = Date.parse("2025-01-01");
    for (let f = 0; f < 26; f++) {
      const d = new Date(start + f * 20 * 86400000).toISOString().slice(0, 10);
      rowsByDate[d] = biasedRows(20);
    }
    writeStore(join(base, "data"), rowsByDate);
    const leagues = runBuild(join(base, "data"), join(base, "exports"));
    const p = leagues["国际赛"];
    assert.ok(p, "国际赛画像必须存在");
    assert.notEqual(p.source, "espn-friendly-6yr-seed", "长窗大样本应允许 store 拟合顶掉 seed");
    assert.ok(p.n >= 500, `store 拟合 n 应 >=500,实际 ${p.n}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("learning-isolation-1:非seed联赛 n>=120 拟合行为不回归", () => {
  const base = mkdtempSync(join(tmpdir(), "lp-seed-guard3-"));
  try {
    const fixDir = join(base, "data", "fixtures");
    mkdirSync(fixDir, { recursive: true });
    const fixtures = biasedRows(130).map(([h, a], i) => ({
      homeTeam: `主${i}`, awayTeam: `客${i}`, competition: "测试联赛X",
      date: "2026-06-01", result: { home: h, away: a },
    }));
    writeFileSync(join(fixDir, "2026-06-01.json"), JSON.stringify({ date: "2026-06-01", source: "test", fixtures }), "utf8");
    const leagues = runBuild(join(base, "data"), join(base, "exports"));
    assert.ok(leagues["测试联赛X"], "非seed联赛 >=120 应照常拟出画像");
    assert.equal(leagues["测试联赛X"].n, 130);
    // 国际赛在 store 无样本时仍须有 seed 兜底画像
    assert.equal(leagues["国际赛"]?.source, "espn-friendly-6yr-seed");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
