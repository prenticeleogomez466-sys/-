/**
 * 一条龙·当日竞彩全覆盖(2026-06-15 用户裁决:"每天能不能不要让我重复跟你说,一次给我生成好全覆盖的")。
 * ──────────────────────────────────────────────────────────────────────────
 * 一句话 `npm run today` 跑完整条链路,不再需要逐条手动补:
 *   ① 抓全5赔种(500竞彩XML:胜平负/让球/比分/半全场/总进球)+ 数据完整性审计
 *   ② 高级数据层同步(advanced:sync)
 *   ③ 世界杯保鲜(在赛窗内):48强Elo / 16城真实天气 / 大小球totals真盘 / 逐场盘口(preflight freshness 闸要)
 *   ④ 预测首发情报(sync:predicted-xi → 情报详情首发可追溯)
 *   ⑤ 近5场/H2H/大小球覆盖(fetch-match-coverage,ESPN跨league真实战绩)
 *   ⑥ 标准交付(today-full-coverage:盘口为主·模型参考·四玩法盘口主推+模型方向·让球后胜平负·三处同源)
 *   ⑦ audit:suite 本地硬闸(24项,红=拒交付 exit1)
 *
 * 铁律:关键玩法/数据源缺 → 诚实标缺不阻断(coverage/intel/advanced 为软步骤,警告不致命);
 *       抓取/交付/审计失败 → fail-loud 退出1(真钱管线,不静默顶替)。
 * 用法:node scripts/today-oneshot.mjs [--date=YYYY-MM-DD] [--skip-wc] [--skip-coverage]
 */
import "../src/env.js";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWorldCupWindow } from "../src/odds-api-rotation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const readArg = (name) => {
  const pre = args.find((a) => a.startsWith(`${name}=`));
  if (pre) return pre.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const todayInShanghai = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const date = readArg("--date") ?? todayInShanghai();
const skipWc = args.includes("--skip-wc");
const skipCoverage = args.includes("--skip-coverage");
const isWc = !skipWc && isWorldCupWindow(date);

const node = process.execPath;
const S = (script, extra = []) => join(__dirname, script);
const warnings = [];
function step({ title, script, scriptArgs = [], critical = false, optional = false }) {
  const label = `── ${title} ──`;
  console.log(`\n${label}`);
  const r = spawnSync(node, [S(script), ...scriptArgs], { stdio: "inherit", timeout: 600000 });
  if (r.status !== 0) {
    const msg = `${title} 非0退出(exit ${r.status})`;
    if (critical) { console.error(`🔴 ${msg} —— 真钱管线关键步骤失败,拒交付。`); process.exit(1); }
    warnings.push(msg);
    console.error(`⚠️ ${msg}${optional ? "(软步骤:相关列将诚实标缺、不阻断)" : ""}`);
  }
  return r.status === 0;
}

console.log(`\n🎯 一条龙·当日竞彩全覆盖  date=${date}  worldCupWindow=${isWc}`);

// ① 抓全5赔种 + 完整性审计(关键:无赔率无法出盘口为主推荐)
step({ title: "① 抓全5赔种(500竞彩XML)+完整性审计", script: "ingest-500-jingcai-fallback.mjs", scriptArgs: [`--date=${date}`], critical: true });

// ② 高级数据层(深度上下文/状态/H2H结构化;软)
step({ title: "② 高级数据层同步 advanced:sync", script: "../src/advanced-data-runner.js", scriptArgs: [`--date=${date}`], optional: true });

// ③ 世界杯保鲜(preflight freshness 闸要:Elo<4天 / 天气<48h / totals<48h / 逐场盘口<36h)
if (isWc) {
  step({ title: "③a 48强Elo保鲜 sync:wc-elo", script: "sync-wc-elo.mjs", optional: true });
  step({ title: "③b 16城真实天气 sync:wc-weather", script: "sync-worldcup-weather.mjs", optional: true });
  step({ title: "③c 大小球totals真盘 sync-wc-totals", script: "sync-wc-totals.mjs", optional: true });
  step({ title: "③d 逐场盘口刷新 wc:odds-capture", script: "refresh-wc-match-odds-espn.mjs", optional: true });
  step({ title: "③e 盘口快照 wc:odds-snapshot", script: "wc-odds-snapshot.mjs", optional: true });
}

// ④ 预测首发情报(情报详情首发可追溯;软)
step({ title: "④ 预测首发情报 sync:predicted-xi", script: "sync-predicted-lineups.mjs", scriptArgs: [date], optional: true });

// ⑤ 近5/H2H/大小球覆盖(ESPN跨league;软,缺标缺)
if (!skipCoverage) step({ title: "⑤ 近5/H2H/大小球覆盖 fetch-match-coverage", script: "fetch-match-coverage.mjs", scriptArgs: [date], optional: true });

// ⑥ 标准交付(关键:fail-loud)
step({ title: "⑥ 标准交付 today-full-coverage(盘口为主·三处同源)", script: "today-full-coverage.mjs", scriptArgs: ["--jconly", "--write", `--date=${date}`], critical: true });

// ⑥b 配套专业xlsx(软:焊进一条龙,杜绝"每次忘跑配套"——专业标准4配套之2有现成生成器)
//     盘口标准区间(深浅临界)+ 盘口共性挖掘与触发条件,落同一交付夹 桌面\足球推荐\<date>\
step({ title: "⑥b-1 配套·盘口标准区间(深浅临界)", script: "build-odds-reference-bands.mjs", optional: true });
step({ title: "⑥b-2 配套·盘口共性挖掘与触发条件", script: "export-handicap-patterns-xlsx.mjs", optional: true });
step({ title: "⑥b-3 配套·模型全面体检与提升", script: "export-scorecard-xlsx.mjs", optional: true });

// ⑦ 本地硬闸(关键:红=拒交付)
{
  console.log(`\n── ⑦ audit:suite 本地硬闸(24项) ──`);
  const r = spawnSync(node, [S("audit-suite.mjs")], { stdio: "inherit", timeout: 600000 });
  if (r.status !== 0) { console.error(`🔴 audit:suite 闸红 —— 拒交付(真钱管线不放行)。`); process.exit(1); }
}

console.log(`\n✅ 一条龙完成(${date})。交付=xlsx+手机页+英文页三处同源,审计24/24绿。`);
if (warnings.length) console.log(`⚠️ 软步骤告警(相关列已诚实标缺,不影响硬闸):\n  - ${warnings.join("\n  - ")}`);
