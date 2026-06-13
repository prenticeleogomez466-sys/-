#!/usr/bin/env node
/**
 * deliver-today —— 足球竞彩【一键全链交付编排】(2026-06-13 用户裁决:别让我漏步骤/忘审计)。
 * 顺序硬串,任一步失败即停;最后 audit:suite 硬闸(对抗审计缺=红=拒交付)。
 *   ① 全5赔率+DOM开球时刻+让球线  ② jqs-raw(串关总进球)  ③ 近5/H2H  ④ 出标准表  ⑤ 硬闸审计
 * 用法: node scripts/deliver-today.mjs --date 2026-06-13
 * ⚠️ 对抗审计(football-signal-verify)是 Claude agent 步骤,本脚本跑不了——
 *    若 ⑤ 因 s4-adversarial 红,先跑 Workflow({name:"football-signal-verify",args:"--date <date>"}),
 *    再重跑本命令(其余步骤幂等)。这是设计:闸门强制对抗审计,不靠人记忆。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const di = args.indexOf("--date");
const DATE = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);

function step(label, cmd, cmdArgs) {
  console.log(`\n━━ ${label} ━━`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`\n🔴 [${label}] 失败(退出码 ${r.status})——交付链中止,修复后重跑。`);
    process.exit(1);
  }
}

step("① 全5赔率+DOM开球时刻+让球线", "node", ["scripts/ingest-500-jingcai-fallback.mjs", `--date=${DATE}`]);
step("② jqs-raw 总进球原始赔率", "node", ["scripts/build-jqs-raw.mjs", `--date=${DATE}`]);
step("③ 近5/H2H/攻防", "node", ["src/advanced-data-runner.js", "--date", DATE]);
step("④ 出标准表(today-full-coverage)", "node", ["scripts/today-full-coverage.mjs", "--date", DATE]);

// ⑤ 硬闸审计(对抗审计缺=红);不用 step() 因为要给红闸专属指引
console.log(`\n━━ ⑤ 硬闸审计 audit:suite ━━`);
const audit = spawnSync("node", ["scripts/audit-suite.mjs"], { stdio: "inherit", encoding: "utf8" });
if (audit.status !== 0) {
  const advMissing = !existsSync(`D:/football-model-data/adversarial/${DATE}.json`);
  console.error(`\n🔴 审计未过,拒绝交付。`);
  if (advMissing) {
    console.error(`👉 多半是对抗审计未跑:先跑 Workflow({name:"football-signal-verify",args:"--date ${DATE}"}),`);
    console.error(`   写出 adversarial/${DATE}.json 后再重跑:node scripts/deliver-today.mjs --date ${DATE}`);
  } else {
    console.error(`👉 对抗审计已在位,红项见上——按 FAIL 项逐条修补后重跑本命令。`);
  }
  process.exit(1);
}
console.log(`\n✅ 全链绿:全5赔率+jqs+近5H2H+标准表+对抗审计+硬闸 全过,可交付。`);
console.log(`   手机页: http://172.16.3.60/今日足球推荐.html`);
console.log(`   xlsx:  桌面\\足球推荐\\${DATE}\\神选-竞彩推荐-${DATE}.xlsx`);
