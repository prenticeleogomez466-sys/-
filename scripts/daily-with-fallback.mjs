// 每日生成(带 500 兜底)——根因修复:官方源被反爬封锁时不再空跑。
//
// 流程:
//   1. 先按严格模式跑官方实时源闸门(lottery.gov.cn / sporttery.cn)。
//   2. 闸门通过 → 走正常 daily-evolution(官方数据,完整竞彩+14场)。
//   3. 闸门失败(官方源 567 反爬 / TLS 拒握手等)→ 自动降级:
//        - 用 500.com 公开静态赔率 XML 兜底抓当日竞彩;
//        - buildDailyRecommendationPackage 以兜底数据产出"竞彩-only"推荐;
//        - 产出明确标记数据源=500.com兜底,14场按硬规则缺失则不发。
//   4. 两条路都失败 → 如实写失败状态,exitCode=1(不伪造任何推荐)。
//
// 严格默认值不变:本包装器只在严格闸门已经失败时才启用兜底,
// 不削弱官方源优先级,只是把"官方挂了就空跑"改成"官方挂了走公开兜底并标注"。
//
// 用法:node scripts/daily-with-fallback.mjs --date=2026-05-30
//        建议把无人值守 cron 的 `npm run daily` 换成本脚本。

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/env.js";
import { getExportDir } from "../src/paths.js";
import { buildDailyRecommendationPackage } from "../src/daily-report.js";
import { loadFixtures } from "../src/fixture-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();

const status = { date, startedAt: new Date().toISOString(), mode: null, officialExit: null, fallbackUsed: false, dailyPath: null, jingcai: 0, ok: false, error: null };

try {
  // 第一优先:官方源标准流程(完整能力,含 14 场)。只评估一次闸门 —— 由 daily-evolution
  // 内部跑实时源闸门,避免"先单独评估再 spawn"造成的双次闸门 + 官方源间歇反爬的判定漂移。
  const official = run("node", ["src/daily-evolution.js", "--date", date]);
  status.officialExit = official.status;

  if (official.status === 0) {
    status.mode = "official";
    status.ok = true;
    // 官方成功(通常是 14 场源漏过反爬),但竞彩源(lottery.gov.cn)常被 567 持续封,
    // 导致竞彩缺席。若当日无竞彩 fixture,用 500 兜底补竞彩并重建报告 —— 官方 14 场 + 兜底竞彩同出一份。
    const hasJingcai = loadFixtures(date).fixtures.some((f) => f.marketType === "jingcai");
    // official 是否真生成了竞彩推荐(源闸可能因早盘赔率不全 skip 推荐,但进程仍 exit 0)。
    let officialGenerated = false;
    try { officialGenerated = JSON.parse(readFileSync(join(exportDir, `daily-evolution-status-${date}.json`), "utf8"))?.recommendation?.generated === true; } catch { officialGenerated = false; }
    // 补救触发(2026-06-07 修数据源bug):①无竞彩 fixture(官方竞彩源被封,原逻辑) 或 ②有竞彩 fixture 但 official
    //   因源闸跳过了推荐(如早盘盘口未全开、赔率不完整4/18→4场真竞彩被挡,误判0场)。重抓全(盘口现已开),
    //   ingest 自带全赔种完整性审计,审计过+真出竞彩(jingcai>0)才采纳——数据已补全,非"带病出表"。
    if (!hasJingcai || !officialGenerated) {
      const ingest = run("node", ["scripts/ingest-500-jingcai-fallback.mjs", `--date=${date}`]);
      if (ingest.status === 0) {
        const merged = loadFixtures(date).fixtures.some((f) => f.marketType === "jingcai");
        if (merged) {
          const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
          const jc = pkg.recommendations.predictions.filter((p) => p.fixture.marketType === "jingcai").length;
          if (jc > 0) {
            status.mode = hasJingcai ? "official跳过→源闸补救竞彩" : "official+500竞彩补充";
            status.jingcaiFallback = true;
            status.dailyPath = pkg.dailyPath;
            status.jingcai = jc;
          }
        }
      }
    }
  } else {
    // 官方源被封(闸门未过)—— 启用 500 兜底,产出竞彩-only。
    status.mode = "fallback-500";
    status.fallbackUsed = true;
    const ingest = run("node", ["scripts/ingest-500-jingcai-fallback.mjs", `--date=${date}`]);
    if (ingest.status !== 0) throw new Error("500 兜底抓取失败,无法产出推荐");
    const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
    status.dailyPath = pkg.dailyPath;
    status.jingcai = pkg.recommendations.predictions.filter((p) => p.fixture.marketType !== "shengfucai").length;
    status.fourteenAvailable = pkg.recommendations.fourteen.available === true;
    status.ok = pkg.audit.ok && status.jingcai > 0;
    if (!status.ok) throw new Error("兜底模式未能产出有效竞彩推荐");
  }
} catch (error) {
  status.error = (status.error ? status.error + " | " : "") + (error.message || String(error));
  process.exitCode = 1;
} finally {
  status.finishedAt = new Date().toISOString();
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, `daily-with-fallback-status-${date}.json`), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(status, null, 2));
}

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { cwd: rootDir, stdio: "inherit", shell: false });
}

function readArg(name) {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
