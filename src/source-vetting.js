import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const exportDir = getExportDir();

const SOURCES = [
  {
    name: "中国体彩网 / 竞彩网",
    url: "https://www.lottery.gov.cn/jc/jsq/zqspf/",
    decision: "accepted",
    tier: "P0",
    layers: ["竞彩赛程", "胜平负", "让球胜平负", "比分赔率", "半全场赔率"],
    modelValue: "官方业务日与赔率闸门主源，正式推荐必须先过它。",
    caveat: "只覆盖中国竞彩受注范围。"
  },
  {
    name: "500彩票网公开赔率页",
    url: "https://odds.500.com/",
    decision: "accepted",
    tier: "P0",
    layers: ["竞彩亚盘", "14场欧赔", "14场亚盘"],
    modelValue: "补齐亚洲盘口、初赔/即赔变化，是爆冷和盘口漂移判断的关键补源。",
    caveat: "仅使用公开页面；失败时不得绕过反爬、登录或付费限制。"
  },
  {
    name: "新浪胜负彩公开赔率文章",
    url: "https://sports.sina.com.cn/l/football/",
    decision: "accepted-fast-fallback",
    tier: "P0",
    layers: ["14场欧赔", "14场澳盘", "欧亚对照"],
    modelValue: "作为 14 场胜负彩赔率快源兜底，当前比逐站抓 500/捷报/聚合站更快更稳定。",
    caveat: "仅用于公开文章解析；若官方 14 场未来提供结构化赔率 API，应优先替换。"
  },
  {
    name: "football-data.co.uk",
    url: "https://www.football-data.co.uk/data.php",
    decision: "accepted",
    tier: "P1",
    layers: ["历史赛果", "历史赔率", "射门/射正统计"],
    modelValue: "用于近期状态、赛程强度、射门质量代理特征和长期回测。",
    caveat: "不是实时源；只作为赛前增强与回测校准。"
  },
  {
    name: "Open-Meteo",
    url: "https://open-meteo.com/en/docs",
    decision: "accepted",
    tier: "P2",
    layers: ["天气", "风速", "降雨", "地理编码"],
    modelValue: "用于大小球、节奏、冷门解释的环境修正。",
    caveat: "城市/球场映射不全时只能部分覆盖。"
  },
  {
    name: "StatsBomb Open Data",
    url: "https://github.com/statsbomb/open-data",
    decision: "accepted-for-training",
    tier: "P2",
    layers: ["事件数据", "历史xG训练样本"],
    modelValue: "用于训练/验证xG和射门质量方法，不直接冒充今日实时xG。",
    caveat: "覆盖赛事有限；许可与用途需要保留来源说明。"
  },
  {
    name: "OpenLigaDB",
    url: "https://www.openligadb.de/api/",
    decision: "accepted",
    tier: "P2",
    layers: ["赛程", "赛果"],
    modelValue: "德语区赛果补源，增强每日复盘结算率。",
    caveat: "覆盖联赛有限。"
  },
  {
    name: "GDELT DOC 2.1",
    url: "https://api.gdeltproject.org/api/v2/doc/doc",
    decision: "accepted",
    tier: "P2",
    layers: ["新闻", "突发事件", "战意上下文"],
    modelValue: "只作冷门原因提示，不直接改变硬概率大权重。",
    caveat: "新闻匹配噪声高，需要低权重。"
  },
  {
    name: "Sofascore/FotMob/Understat 非官方抓取",
    url: "",
    decision: "rejected-by-default",
    tier: "blocked",
    layers: ["阵容", "xG", "伤停"],
    modelValue: "数据有价值，但没有稳定公开授权API时不进入无人值守生产。",
    caveat: "不绕过登录、验证码、付费墙或反爬。"
  }
];

export function buildSourceVettingReport(date = todayInShanghai()) {
  const accepted = SOURCES.filter((source) => source.decision.startsWith("accepted"));
  const rejected = SOURCES.filter((source) => source.decision.startsWith("rejected"));
  const report = {
    ok: accepted.some((source) => source.tier === "P0"),
    date,
    generatedAt: new Date().toISOString(),
    policy: "只接入合法公开、免费层、官方文档明确或用户自有授权的数据源；不做技术攻破。",
    summary: {
      total: SOURCES.length,
      accepted: accepted.length,
      rejected: rejected.length,
      p0Accepted: accepted.filter((source) => source.tier === "P0").length
    },
    sources: SOURCES
  };
  writeReport(report);
  return report;
}

function writeReport(report) {
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, `source-vetting-${report.date}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(exportDir, `source-vetting-${report.date}.md`), renderMarkdown(report), "utf8");
}

function renderMarkdown(report) {
  return [
    `# 足球大模型数据源甄别 ${report.date}`,
    "",
    `策略：${report.policy}`,
    "",
    "| 来源 | 结论 | 优先级 | 数据层 | 实际意义 | 限制 |",
    "|---|---|---|---|---|---|",
    ...report.sources.map((source) => `| ${source.url ? `[${source.name}](${source.url})` : source.name} | ${source.decision} | ${source.tier} | ${source.layers.join("、")} | ${source.modelValue} | ${source.caveat} |`),
    ""
  ].join("\n");
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("source-vetting.js")) {
  const date = readArg("--date") ?? todayInShanghai();
  const report = buildSourceVettingReport(date);
  console.log(JSON.stringify({ ok: report.ok, summary: report.summary, path: join(exportDir, `source-vetting-${date}.json`) }, null, 2));
  if (!report.ok) process.exitCode = 1;
}
