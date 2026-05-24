import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";
import { loadAdvancedData } from "./advanced-data-store.js";
import { buildMarketCoverageStatus } from "./market-data-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

const CAPABILITIES = [
  {
    layer: "数据闸门",
    name: "官方赛程 + 实时赔率硬闸门",
    status: "connected",
    priority: "P0",
    modelUse: "阻断陈旧赔率和缺失场次，保证正式推荐先验数据真实可追溯。",
    sources: ["中国体彩网竞彩足球计算器", "竞彩网传统足彩公告"]
  },
  {
    layer: "市场赔率",
    name: "欧赔/让球/亚盘/大小球/赔率变化",
    status: "connected",
    priority: "P0",
    modelUse: "将赔率隐含概率、盘口变化和冷热方向作为胜平负与爆冷判断核心输入。",
    sources: ["Sporttery official odds", "The Odds API h2h/spreads/totals", "公开赔率补源"]
  },
  {
    layer: "球队强度",
    name: "Elo/市场派生强度",
    status: "connected-with-derived-fallback",
    priority: "P1",
    modelUse: "用真实 Elo 或市场隐含强度修正基础胜率，降低纯赔率模型对热门方向的偏差。",
    sources: ["ClubElo public API", "market-implied-strength fallback"]
  },
  {
    layer: "近期状态",
    name: "近况/赛程强度/进失球形态",
    status: "connected-with-derived-fallback",
    priority: "P1",
    modelUse: "用于识别状态背离、连续赛程疲劳和赔率未充分反映的状态风险。",
    sources: ["football-data.co.uk CSV", "market-implied-form fallback"]
  },
  {
    layer: "xG/进球模型",
    name: "xG、Poisson/Skellam、蒙特卡洛比分",
    status: "connected-with-derived-fallback",
    priority: "P1",
    modelUse: "把胜平负概率转换为比分、大小球、半全场路径，并审计比分/半全场不冲突。",
    sources: ["StatsBomb Open Data for training reference", "model-derived xG fallback"]
  },
  {
    layer: "阵容伤停",
    name: "伤停名单/预计首发/实际首发",
    status: "derived-until-authorized-source",
    priority: "P1",
    modelUse: "真实源可直接影响强弱修正；无真实源时只作为临场复核风险，不冒充真实伤停。",
    sources: ["API-Football when key configured", "authorized JSON source", "neutral lineup fallback"]
  },
  {
    layer: "战意赛程",
    name: "升降级/杯赛轮换/赛程密度/新闻战意",
    status: "connected-with-heuristic-fallback",
    priority: "P2",
    modelUse: "解释爆冷原因，识别保级、升级、欧战席位和杯赛轮换风险。",
    sources: ["GDELT DOC API", "competition-stage heuristic"]
  },
  {
    layer: "环境因素",
    name: "天气/旅行/场地",
    status: "connected-partial",
    priority: "P2",
    modelUse: "通过降雨、风速、温度影响节奏、总进球和冷门风险。",
    sources: ["Open-Meteo forecast + geocoding"]
  },
  {
    layer: "回测校准",
    name: "Brier/LogLoss/命中率/复盘闭环",
    status: "connected",
    priority: "P0",
    modelUse: "每天复盘胜平负、比分、半全场，长期评估概率校准和模型退化。",
    sources: ["local recap ledger", "daily scheduled recap"]
  },
  {
    layer: "资金风控",
    name: "EV/凯利/回撤约束",
    status: "connected-when-enabled",
    priority: "P1",
    modelUse: "把推荐和投注资金分离，按 EV、凯利和最大回撤控制风险。",
    sources: ["local bankroll policy"]
  },
  {
    layer: "可解释性",
    name: "多因素融合判断要点",
    status: "connected",
    priority: "P0",
    modelUse: "每场输出爆冷、大小球、战意、阵容、状态、赔率变化和融合结论。",
    sources: ["factor-analysis module"]
  },
  {
    layer: "历史训练集",
    name: "开放历史赛果/赔率/事件数据扩展",
    status: "candidate",
    priority: "P2",
    modelUse: "用于训练更稳定的联赛参数、xG/xT、盘口漂移和赛前冷门模型。",
    sources: ["StatsBomb Open Data", "openfootball", "football-data.org", "OpenLigaDB"]
  }
];

const REFERENCES = [
  {
    name: "StatsBomb Open Data",
    url: "https://github.com/statsbomb/open-data",
    use: "公开事件级数据，可用于 xG/xT/战术训练与样例验证。"
  },
  {
    name: "football-data.co.uk",
    url: "https://www.football-data.co.uk/data",
    use: "历史赛果、比赛统计和赔率 CSV，适合回测和联赛状态参数。"
  },
  {
    name: "ClubElo",
    url: "http://api.clubelo.com/",
    use: "球队 Elo 强度评级，适合作为长期强弱先验。"
  },
  {
    name: "Open-Meteo",
    url: "https://open-meteo.com/en/docs",
    use: "无需 key 的天气、地理编码、风雨温度输入。"
  },
  {
    name: "GDELT DOC API",
    url: "https://api.gdeltproject.org/api/v2/doc/doc",
    use: "新闻与舆情检索，用于战意/突发事件提示。"
  },
  {
    name: "football-data.org",
    url: "https://docs.football-data.org/general/v4/coding_client.html",
    use: "赛程、球队、积分榜和比赛 JSON API，需免费 token。"
  },
  {
    name: "The Odds API",
    url: "https://the-odds-api.com/liveapi/guides/v3/",
    use: "h2h、spreads、totals 赔率补源，需 API key。"
  },
  {
    name: "OpenLigaDB",
    url: "https://www.openligadb.de/api/",
    use: "德国联赛赛程、比分和积分信息候选源。"
  },
  {
    name: "ScoreBat",
    url: "https://www.scorebat.com/video-api/docs/",
    use: "公开视频/资讯候选源，不作为赔率或赛程硬源。"
  }
];

export function auditModelCapabilities(date) {
  mkdirSync(exportDir, { recursive: true });
  const market = safeMarket(date);
  const advanced = loadAdvancedData(date);
  const rows = CAPABILITIES.map((capability) => ({
    ...capability,
    readiness: readinessFor(capability, market, advanced),
    nextAction: nextActionFor(capability)
  }));
  const result = {
    ok: rows.every((row) => row.priority !== "P0" || row.readiness === "ready"),
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      ready: rows.filter((row) => row.readiness === "ready").length,
      partial: rows.filter((row) => row.readiness === "partial").length,
      candidate: rows.filter((row) => row.readiness === "candidate").length,
      blockedP0: rows.filter((row) => row.priority === "P0" && row.readiness !== "ready").length
    },
    market,
    advanced: summarizeAdvanced(advanced),
    rows,
    references: REFERENCES
  };
  writeCapabilityAudit(result);
  return result;
}

function readinessFor(capability, market, advanced) {
  if (capability.status === "candidate") return "candidate";
  if (capability.name.includes("官方赛程") || capability.name.includes("赔率")) {
    return market.ok && market.complete === market.fixtures && market.realtime === market.fixtures ? "ready" : "partial";
  }
  if (capability.name.includes("Elo")) return layerReady(advanced, "elo");
  if (capability.name.includes("近况")) return layerReady(advanced, "form");
  if (capability.name.includes("xG")) return layerReady(advanced, "xg");
  if (capability.name.includes("伤停")) return layerReady(advanced, "injuries") === "ready" ? "partial" : "candidate";
  if (capability.name.includes("升降级")) return layerReady(advanced, "news");
  if (capability.name.includes("天气")) return layerReady(advanced, "weather");
  if (capability.name.includes("资金")) return process.env.BANKROLL_RISK_POLICY === "1" ? "ready" : "partial";
  return "ready";
}

function nextActionFor(capability) {
  if (capability.status === "candidate") return "按许可证逐个启用候选适配器，先进入回测，不直接进入正式推荐。";
  if (capability.status.includes("derived")) return "继续寻找授权免费源替换代理特征，并保留代理标识。";
  if (capability.status === "connected-when-enabled") return "启用 BANKROLL_RISK_POLICY=1 后进入正式资金风控。";
  return "保持每日闸门、审计和复盘。";
}

function layerReady(advanced, key) {
  const layer = advanced.layers?.[key];
  if (!layer?.ok) return "candidate";
  return layer.derived ? "partial" : "ready";
}

function safeMarket(date) {
  try {
    const status = buildMarketCoverageStatus(date);
    return {
      ok: true,
      fixtures: status.fixtures,
      snapshots: status.snapshots,
      usable: status.usable,
      complete: status.complete,
      realtime: status.rows.filter((row) => row.realTime).length
    };
  } catch (error) {
    return { ok: false, error: error.message, fixtures: 0, snapshots: 0, usable: 0, complete: 0, realtime: 0 };
  }
}

function summarizeAdvanced(advanced) {
  return Object.fromEntries(Object.entries(advanced.layers ?? {}).map(([key, layer]) => [key, {
    ok: Boolean(layer.ok),
    count: layer.count ?? 0,
    realCount: layer.realCount ?? layer.count ?? 0,
    derivedCount: layer.derivedCount ?? 0,
    derived: Boolean(layer.derived),
    source: layer.source ?? ""
  }]));
}

function writeCapabilityAudit(result) {
  const jsonPath = join(exportDir, `model-capability-audit-${result.date}.json`);
  const markdownPath = join(exportDir, `model-capability-audit-${result.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
}

function renderMarkdown(result) {
  return [
    `# 足球大模型能力矩阵 ${result.date}`,
    "",
    `状态：${result.ok ? "核心能力可运行" : "存在 P0 阻断"}`,
    `能力：ready=${result.summary.ready} / partial=${result.summary.partial} / candidate=${result.summary.candidate}`,
    "",
    "## 能力矩阵",
    "| 层级 | 能力 | 优先级 | 状态 | 就绪度 | 用途 | 下一步 |",
    "|---|---|---|---|---|---|---|",
    ...result.rows.map((row) => `| ${row.layer} | ${row.name} | ${row.priority} | ${row.status} | ${row.readiness} | ${row.modelUse} | ${row.nextAction} |`),
    "",
    "## 合法公开来源",
    "| 来源 | 地址 | 用途 |",
    "|---|---|---|",
    ...result.references.map((source) => `| ${source.name} | ${source.url} | ${source.use} |`),
    ""
  ].join("\n");
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? todayInShanghai();
  const result = auditModelCapabilities(date);
  console.log(JSON.stringify({ ok: result.ok, summary: result.summary, path: join(exportDir, `model-capability-audit-${date}.json`) }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
