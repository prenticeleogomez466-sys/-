// audit-wc-pipeline 守护测试(喂毒用例):世界杯全链路硬闸必须真的拦得住坏数据。
// 三毒一净: ①超算单调性破必拦 ②冻结基线被改必拦 ③坏赔率必拦 ④真实数据S3须能过(防"永远红"废闸)。
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, existsSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE = path.join(ROOT, "scripts", "audit-wc-pipeline.mjs");
const REAL_WC = path.join(process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data", "world-cup", "2026");

function runProbe(args) {
  try {
    const out = execFileSync("node", [PROBE, ...args], { encoding: "utf8", timeout: 120000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

function makeScRows(poisonIdx = -1) {
  // 干净构造: 夺冠和=0.06+47×0.02=1.0,出线和=48×(32/48)=32,链 0.667≥0.5≥0.3≥0.15≥0.08≥champion 单调
  const rows = [];
  for (let i = 0; i < 48; i++) {
    const champion = i === 0 ? 0.06 : 0.02;
    let r = { team: `队${i}`, en: `T${i}`, elo: 1800, advance: 32 / 48, r16: 0.5, qf: 0.3, sf: 0.15, final: 0.08, champion, market: champion, blend: champion };
    if (i === poisonIdx) r = { ...r, qf: 0.9 }; // qf > r16 → 单调链破
    rows.push(r);
  }
  return rows;
}

test("毒①: 超算单调性破必须闸红", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wcgate-"));
  try {
    writeFileSync(path.join(dir, "worldcup-supercomputer.json"), JSON.stringify({
      generatedAt: new Date().toISOString(), n: 1000, seed: 1, alpha: 0.65, rows: makeScRows(5),
    }));
    const r = runProbe([`--wc-dir=${dir}`, "--only=s3", "--no-task-check"]);
    assert.notStrictEqual(r.code, 0, "毒数据未被拦: " + r.out);
    assert.match(r.out, /单调性破/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("毒②: 冻结基线被篡改必须闸红", { skip: !existsSync(REAL_WC) && "真实数据盘缺失" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wcgate-"));
  try {
    writeFileSync(path.join(dir, "worldcup-supercomputer.json"), JSON.stringify({
      generatedAt: new Date().toISOString(), n: 1000, seed: 1, alpha: 0.65, rows: makeScRows(),
    }));
    const freeze = JSON.parse(readFileSync(path.join(ROOT, "scripts", "wc-baseline-freeze.json"), "utf8"));
    for (const f of Object.keys(freeze.files)) {
      copyFileSync(path.join(REAL_WC, f), path.join(dir, f));
      appendFileSync(path.join(dir, f), " "); // 篡改一字节
    }
    const r = runProbe([`--wc-dir=${dir}`, "--only=s3", "--no-task-check"]);
    assert.notStrictEqual(r.code, 0, "基线篡改未被拦: " + r.out);
    assert.match(r.out, /被改/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("毒③: 坏赔率(≤1.01)必须闸红", { skip: !existsSync(REAL_WC) && "真实数据盘缺失" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wcgate-"));
  try {
    for (const f of readdirSync(REAL_WC)) {
      if (f.endsWith(".json") || f.endsWith(".wikitext")) copyFileSync(path.join(REAL_WC, f), path.join(dir, f));
    }
    const odds = JSON.parse(readFileSync(path.join(dir, "match-odds.json"), "utf8"));
    odds.fixtures[0].odds.home = 1.0; // 坏赔率(CubeGoal同类毒)
    writeFileSync(path.join(dir, "match-odds.json"), JSON.stringify(odds));
    const r = runProbe([`--wc-dir=${dir}`, "--only=s1", "--no-task-check"]);
    assert.notStrictEqual(r.code, 0, "坏赔率未被拦: " + r.out);
    assert.match(r.out, /坏赔率/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("净④: 真实数据 S3 分析层须全绿(防永远红废闸)", { skip: !existsSync(path.join(REAL_WC, "worldcup-supercomputer.json")) && "真实数据盘缺失" }, () => {
  const r = runProbe(["--only=s3", "--no-task-check"]);
  assert.strictEqual(r.code, 0, "真实数据闸红,要么数据坏了要么闸误伤: " + r.out);
});

// 复发探针(0614根因): SCHED_S_TASK_RUNNING(267009)/READY(267008) 是"任务状态码"非"程序失败码",
// 撞上 11:10 复盘运行窗时探针曾把"正在运行"误判为失败退出码致 s5-recap-task 假红。豁免集回退即拦。
test("复发探针: s5-recap-task 必须豁免 SCHED_S 状态码(267008/267009/267011)不当失败", () => {
  const src = readFileSync(PROBE, "utf8");
  const m = src.match(/SCHED_S_BENIGN\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "未找到 SCHED_S_BENIGN 豁免集——探针修复被回退,11:10复盘运行窗会假红");
  for (const code of ["0", "267008", "267009", "267011"]) {
    assert.match(m[1], new RegExp(`"${code}"`), `豁免集缺 ${code}(SCHED_S 状态码),运行中任务会被误判失败`);
  }
});
