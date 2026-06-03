/**
 * StatsBomb 事件级 xG 数据源(国家队大赛)— 读 scripts/sb_fetch_intl_xg.py 产出的汇总,
 * 暴露每队【场均 xG攻/防/净 + 临门质量】供模型作【独立强度交叉验证 / 分析展示】。
 *
 * 来源:StatsBomb 开放数据(免费,射门级 xG,无反爬);本机 FBref 被 Cloudflare 挡故走此路。
 * 诚实:小样本(每队 3-7 场/届),独立于赔率/Elo 的真实信号,但不单独保证命中率;
 *   定位=补"国家队 xG 事件级缺口"作分析与先验交叉核,非实时下注信号(遵离线特征不进闸门)。
 *
 * 纯读,无网络。数据缺失时优雅返回 null/空(遵 no-fabrication,不臆造 xG)。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

let _cache = null;
function summaryPath() {
  return join(getDataSubdir("soccerdata-bridge"), "intl-team-xg-summary.json");
}

/** 加载 xG 汇总(缓存)。缺文件返回 { teams:{} }。 */
export function loadIntlXg() {
  if (_cache) return _cache;
  const p = summaryPath();
  if (!existsSync(p)) { _cache = { teams: {}, missing: true }; return _cache; }
  try { _cache = JSON.parse(readFileSync(p, "utf8")); _cache.teams ||= {}; }
  catch { _cache = { teams: {}, missing: true }; }
  return _cache;
}

// StatsBomb 英文队名 ↔ 常见别名(本模型可能用别的英文/中文写法)。
const ALIAS = {
  "South Korea": ["Korea Republic", "韩国", "Korea"],
  "United States": ["USA", "美国", "United States of America"],
  "Iran": ["IR Iran", "伊朗"],
  "Ivory Coast": ["Côte d'Ivoire", "科特迪瓦"],
  "Czechia": ["Czech Republic", "捷克"],
  "China PR": ["China", "中国"],
};
// 中文→StatsBomb 英文(取自常见 32/48 强;缺的靠 team-priors en 字段补)
const ZH2EN = {
  "西班牙": "Spain", "法国": "France", "阿根廷": "Argentina", "英格兰": "England",
  "巴西": "Brazil", "葡萄牙": "Portugal", "德国": "Germany", "荷兰": "Netherlands",
  "比利时": "Belgium", "克罗地亚": "Croatia", "意大利": "Italy", "乌拉圭": "Uruguay",
  "墨西哥": "Mexico", "美国": "United States", "摩洛哥": "Morocco", "塞内加尔": "Senegal",
  "日本": "Japan", "韩国": "South Korea", "瑞士": "Switzerland", "丹麦": "Denmark",
  "波兰": "Poland", "塞尔维亚": "Serbia", "厄瓜多尔": "Ecuador", "加纳": "Ghana",
  "喀麦隆": "Cameroon", "突尼斯": "Tunisia", "澳大利亚": "Australia", "加拿大": "Canada",
  "哥伦比亚": "Colombia", "土耳其": "Turkey", "奥地利": "Austria", "挪威": "Norway",
};

function resolveKey(teams, name) {
  if (!name) return null;
  if (teams[name]) return name;                     // 直接英文命中
  if (ZH2EN[name] && teams[ZH2EN[name]]) return ZH2EN[name]; // 中文→英文
  for (const [canon, alts] of Object.entries(ALIAS)) {       // 别名
    if ((canon === name || alts.includes(name)) && teams[canon]) return canon;
  }
  return null;
}

/**
 * 取某队事件级 xG 画像。
 * @param {string} name 队名(中/英)
 * @returns {{matches,xgForPerGame,xgAgainstPerGame,xgDiffPerGame,goalsForPerGame,finishingPerGame,tournaments}|null}
 */
export function teamXgProfile(name) {
  const { teams } = loadIntlXg();
  const key = resolveKey(teams, name);
  return key ? { team: key, ...teams[key] } : null;
}

/** 是否有可用 xG 数据(供调用方判断是否启用交叉核)。 */
export function hasIntlXg() {
  const d = loadIntlXg();
  return !d.missing && Object.keys(d.teams).length > 0;
}
