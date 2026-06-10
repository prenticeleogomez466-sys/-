#!/usr/bin/env node
/**
 * 一次性清洗(2026-06-10 缺陷#1#2):复盘 ledger 假赛果去毒。
 *
 * 背景:recommendation-ledger 中 55 条 settled 里大量是"未开赛世界杯场"被
 * backfill-results.mjs 单边锚定匹配回填的热身赛假赛果(例:墨西哥vs南非两日矛盾
 * 比分 5-1→0-1;阿根廷两场记同一个 3-0)。backfill 跳过已有 result 的场,假赛果
 * 不会自愈,必须一次性清洗。
 *
 * 判据(任一满足即假 settled):
 *   ① 该场 fixture 的开赛时刻(kickoffEpochMs,kickoff 内嵌日期优先)晚于其 settledAt
 *      ——结算时比赛还没踢,结算必假;
 *   ② 开赛时刻在未来(>now)但已有 result——没踢的比赛不存在真实赛果。
 *   kickoff 不可解析的 settled 行单独报告(不自动改,人工核对)。
 *
 * 动作:
 *   - ledger 原文件备份到同目录带时间戳副本 + D:\football-model-data\backups\ 双备份
 *     (exports 根有 16:01 清空史,持久备份不能只放根);
 *   - 假 settled 行重置为 pending(stripSettleFields 清掉 result/settled 相关字段,保留 pick);
 *   - fixture store 中 kickoff>now 却有 result 的场,result 清为 null(防 06-12 开赛后
 *     硬闸放行时旧假赛果"复活"再次结算);store 文件同样先备份;
 *   - 打印逐条清洗明细。
 *
 * 用法:
 *   node scripts/detox-ledger-2026-06-10.mjs --dry   # 只报告不写盘
 *   node scripts/detox-ledger-2026-06-10.mjs         # 实清洗
 */
import "../src/env.js";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { loadFixtures, fixtureDir } from "../src/fixture-store.js";
import { kickoffEpochMs, hasKickedOff } from "../src/kickoff-time.js";
import { findFixtureForLedger, stripSettleFields } from "../src/daily-recap.js";

const dry = process.argv.includes("--dry");
const now = Date.now();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const ledgerPath = join(getExportDir(), "recommendation-ledger.json");

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const settledRows = ledger.filter((r) => r.actualStatus === "settled" || r.actual);
console.log(`ledger 共 ${ledger.length} 行,settled ${settledRows.length} 行${dry ? "  [DRY-RUN 不写盘]" : ""}\n`);

// ── 备份(双份:同目录 + D 盘持久目录) ──────────────────────────────
const backupDir = "D:/football-model-data/backups";
if (!dry) {
  const sameDirBackup = join(getExportDir(), `recommendation-ledger.backup-${stamp}.json`);
  copyFileSync(ledgerPath, sameDirBackup);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(ledgerPath, join(backupDir, `recommendation-ledger.backup-${stamp}.json`));
  console.log(`已备份 ledger → ${sameDirBackup}`);
  console.log(`已备份 ledger → ${join(backupDir, `recommendation-ledger.backup-${stamp}.json`)}\n`);
}

// ── 第一步:ledger 假 settled 重置 pending ──────────────────────────
const dates = [...new Set(ledger.map((r) => r.date).filter(Boolean))].sort();
const fixturesByDate = new Map(dates.map((d) => [d, loadFixtures(d).fixtures]));

let cleaned = 0, keptSettled = 0, unjudgeable = 0;
const detail = [];
const nextLedger = ledger.map((row) => {
  const isSettled = row.actualStatus === "settled" || row.actual;
  if (!isSettled) return row;
  const fixture = findFixtureForLedger(row, fixturesByDate.get(row.date) ?? []);
  const ke = fixture ? kickoffEpochMs(fixture) : null;
  if (ke === null) {
    unjudgeable++;
    detail.push(`❓ 保留待人工核 ${row.date} ${row.sequence} ${row.match} score=${row.actualScore}(fixture ${fixture ? "kickoff 不可解析" : "未找到"})`);
    return row;
  }
  const settledAtMs = Date.parse(row.settledAt ?? "");
  const fakeBySettledAt = Number.isFinite(settledAtMs) && ke > settledAtMs; // 结算时还没开赛
  const fakeByFuture = ke > now; // 现在都还没开赛却有"赛果"
  if (!fakeBySettledAt && !fakeByFuture) {
    keptSettled++;
    detail.push(`✅ 真 settled 保留 ${row.date} ${row.sequence} ${row.match} score=${row.actualScore} kickoff=${fixture.kickoff}`);
    return row;
  }
  cleaned++;
  const why = fakeByFuture ? `kickoff(${fixture.kickoff})在未来` : `kickoff(${fixture.kickoff})晚于 settledAt(${row.settledAt})`;
  detail.push(`🧹 假赛果重置 pending ${row.date} ${row.sequence} ${row.match} 假score=${row.actualScore} —— ${why}`);
  return {
    ...stripSettleFields(row),
    actualStatus: "pending-result",
    pendingReason: `2026-06-10 去毒:原结算为错配假赛果(${why}),已重置等真实赛果`
  };
});

for (const line of detail) console.log(line);
console.log(`\nledger 清洗:重置 ${cleaned} 条假 settled,保留 ${keptSettled} 条真 settled,待人工核 ${unjudgeable} 条`);

// ── 第二步:fixture store 未开赛假 result 清除(防开赛后假赛果复活) ──
let storeCleaned = 0;
for (const d of dates) {
  const filePath = join(fixtureDir, `${d}.json`);
  if (!existsSync(filePath)) continue;
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  const poisoned = fixtures.filter((f) => f.result && !hasKickedOff(f, now));
  if (!poisoned.length) continue;
  for (const f of poisoned) {
    console.log(`🧹 store ${d}: 清除未开赛假 result ${f.sequence ?? ""} ${f.homeTeam} vs ${f.awayTeam} kickoff=${JSON.stringify(f.kickoff ?? "")} 假score=${f.result.home}-${f.result.away}`);
    storeCleaned++;
  }
  if (!dry) {
    copyFileSync(filePath, join(backupDir, `fixtures-${d}.backup-${stamp}.json`));
    const cleanedFixtures = fixtures.map((f) => (f.result && !hasKickedOff(f, now) ? { ...f, result: null } : f));
    const nextPayload = Array.isArray(payload)
      ? cleanedFixtures
      : { ...payload, fixtures: cleanedFixtures, detoxedAt: new Date().toISOString(), detoxNote: "2026-06-10 去毒:未开赛场假 result 清除" };
    writeFileSync(filePath, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");
  }
}
console.log(`\nfixture store 清洗:清除 ${storeCleaned} 个未开赛假 result(已备份原文件到 ${backupDir})`);

if (!dry) {
  writeFileSync(ledgerPath, `${JSON.stringify(nextLedger, null, 2)}\n`, "utf8");
  console.log(`\n已写回 ledger:${ledgerPath}`);
} else {
  console.log("\n[DRY-RUN] 未写盘。去掉 --dry 实清洗。");
}
