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
import { deliverDailyReportToWechat } from "../src/wechat-delivery.js";

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
            // 缺陷#18(2026-06-10):补救路径重建了报告(此前 official 没投或投的是缺竞彩的旧包),
            // 必须同 daily-evolution 主链一样投递微信 outbox,否则 outbox 停更、手机端拿不到当日表。
            status.wechat = await deliverWechatSafely(pkg);
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
    // 缺陷#18(2026-06-10 根修):fallback 成功出表也必须投递微信 —— 此前只有 daily-evolution 的
    // marketCheck.ok 分支会投,官方源被封走 500 兜底的日子(06-09/06-10)出了表 outbox 却停在 06-08。
    status.wechat = await deliverWechatSafely(pkg);
  }
  // 每日链统一交付出口(2026-06-10 缺陷#5#7根修):无论 official / 补救 / 500兜底哪条路成功,
  // 都必须刷新唯一输出出口 —— fetch-match-coverage(近5/H2H/大小球补全层)+ today-full-coverage --jconly
  // (xlsx20列专业版→桌面+桌面\足球推荐\<date>\稳定子文件夹 + 手机页 + 英文页,三面同源同日期)。
  // 此前每日链只出 exports 的 daily-report 简表,coverage/adversarial/手机页整层没人跑(06-10三面三个日期的根因)。
  if (status.ok) {
    status.deliveryRefresh = refreshUnifiedDelivery(date);
    if (!status.deliveryRefresh.ok) process.exitCode = 1; // 交付层失败必须响(监控可见),不掩盖
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

// 唯一交付出口刷新(缺陷#5#7):coverage 失败只降级标缺不阻断;today-full-coverage 失败=交付层事故(ok=false)。
function refreshUnifiedDelivery(d) {
  const out = { ok: false, coverage: null, fullCoverage: null };
  const cover = run("node", ["scripts/fetch-match-coverage.mjs", d]);
  out.coverage = cover.status === 0 ? "ok" : `failed:${cover.status}(交付表近5/H2H/亚盘列将标⚠️缺,不编)`;
  const full = run("node", ["scripts/today-full-coverage.mjs", d, "--jconly"]);
  out.fullCoverage = full.status === 0 ? "ok" : `failed:${full.status}`;
  out.ok = full.status === 0;
  return out;
}

// 微信投递(缺陷#18):投递失败绝不掩盖"已成功出表"的事实 —— 只如实记录投递结果,
// 不让投递异常把出表打成失败(表已真实落盘);deliverDailyReportToWechat 自身已含
// webhook 重试 + 本地 outbox 落盘双通道。
async function deliverWechatSafely(pkg) {
  try {
    return await deliverDailyReportToWechat(pkg);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
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
