import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPrematureResults, listStoreDates } from "../src/result-sanity.js";

// T1 去毒范围漏洞守护(2026-06-10 对抗审计):
// ① findPrematureResults 锁死"开赛前无赛果"不变量判据(date-only kickoff 23:59:59 边界、
//    kickoff 不可解析的 result 同样不可信);
// ② listStoreDates 锁死扫描域=store 全部日期文件——绝不能用"ledger 出现过的日期"
//    (ledger 06-06 0 行 → 2026-06-06.json 12 条假赛果 0 清洗且 backfill 永不自愈的根因);
// ③ 源码守护:detox 第二步/全量自检脚本必须走上述扫描域与判据,防回退。

const NOW = Date.parse("2026-06-10T20:00:00+08:00"); // 案发时点:06-10 晚

test("findPrematureResults: 未开赛(kickoff 内嵌未来日期)却有 result → 矛盾", () => {
  const fake = { sequence: 1, homeTeam: "墨西哥", awayTeam: "南非", kickoff: "2026-06-12", result: { home: 5, away: 1 } };
  assert.deepEqual(findPrematureResults([fake], NOW), [fake]);
});

test("findPrematureResults: 已开赛的真 result 不动", () => {
  const real = { sequence: 2, homeTeam: "德国", awayTeam: "芬兰", date: "2026-06-08", kickoff: "2026-06-08 02:45", result: { home: 2, away: 0 } };
  assert.deepEqual(findPrematureResults([real], NOW), []);
});

test("findPrematureResults: 未开赛但无 result → 不矛盾(正常 pending)", () => {
  const pending = { sequence: 3, homeTeam: "比利时", awayTeam: "埃及", kickoff: "2026-06-16", result: null };
  assert.deepEqual(findPrematureResults([pending], NOW), []);
});

test("findPrematureResults: kickoff 缺失/不可解析却有 result → 矛盾(无法证明已开赛=不可信)", () => {
  const noKick = { sequence: 4, homeTeam: "A", awayTeam: "B", kickoff: "", result: { home: 1, away: 0 } };
  assert.equal(findPrematureResults([noKick], NOW).length, 1);
});

test("findPrematureResults: date-only kickoff 取 23:59:59 保守边界(边界前=矛盾,边界后=放行)", () => {
  // 实测案例:06-09 #2203 阿根廷vs冰岛 kickoff="2026-06-10",result 3-0(ESPN 核实为真)
  // —— 06-10 20:00 仍判矛盾(宁短暂 pending 勿留旁路可消费的先于开赛 result),次日自然放行。
  const f = { sequence: "2203", homeTeam: "阿根廷", awayTeam: "冰岛", date: "2026-06-09", kickoff: "2026-06-10", result: { home: 3, away: 0 } };
  assert.equal(findPrematureResults([f], NOW).length, 1);
  assert.equal(findPrematureResults([f], Date.parse("2026-06-11T00:30:00+08:00")).length, 0);
});

test("listStoreDates: 扫描域=目录全部日期文件(含 ledger 没有的日期),排除非日期/备份文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "result-sanity-"));
  try {
    for (const name of ["2026-06-06.json", "2026-06-07.json", "1930-07-13.json"]) {
      writeFileSync(join(dir, name), "{}", "utf8");
    }
    // 不应入扫描域的:备份、非日期命名
    writeFileSync(join(dir, "2026-06-06.json.bak"), "{}", "utf8");
    writeFileSync(join(dir, "fixtures-2026-06-06.backup-x.json"), "{}", "utf8");
    writeFileSync(join(dir, "notes.json"), "{}", "utf8");
    assert.deepEqual(listStoreDates(dir), ["1930-07-13", "2026-06-06", "2026-06-07"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 源码守护:扫描域/判据不得回退 ─────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));

test("守护: detox 第二步扫描域=listStoreDates(fixtureDir),判据=findPrematureResults", () => {
  const src = readFileSync(join(here, "..", "scripts", "detox-ledger-2026-06-10.mjs"), "utf8");
  assert.match(src, /listStoreDates\(fixtureDir\)/, "detox 第二步必须扫 store 全部日期文件");
  assert.match(src, /for \(const d of storeDates\)/, "detox 第二步不得回退为只遍历 ledger 日期");
  assert.match(src, /findPrematureResults\(fixtures, now\)/, "detox 判据必须走共享 findPrematureResults");
});

test("守护: 全量矛盾自检脚本存在且只读 fail-loud(发现矛盾 exit 1)", () => {
  const src = readFileSync(join(here, "..", "scripts", "audit-premature-results.mjs"), "utf8");
  assert.match(src, /listStoreDates\(fixtureDir\)/);
  assert.match(src, /findPrematureResults\(fixtures, now\)/);
  assert.match(src, /process\.exit\(1\)/, "发现矛盾必须非零退出,不得静默");
  assert.doesNotMatch(src, /writeFileSync|saveFixtures/, "自检脚本必须只读,清洗动作集中在 detox");
});
