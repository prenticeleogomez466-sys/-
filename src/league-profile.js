/**
 * 联赛画像加载/匹配(2026-05-31)—— 把 build-league-profiles 产出的各联赛历史特点
 * (场均进球/平局率/主场优势/大球率)按 fixture.competition 取出,供预测吸取联赛特点。
 * 覆盖:五大联赛 + 次级 + 日韩职/澳超/美职/巴甲/沙特/挪超/瑞超等。缺则回退全局基准。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

let CACHE = null;
function load() {
  if (CACHE) return CACHE;
  const path = join(getExportDir(), "league-profiles.json");
  CACHE = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8"))?.leagues ?? {}) : {};
  return CACHE;
}
export function _resetCache() { CACHE = null; }

// competition 名 → 画像 key 的模糊匹配(中文/英文 label 互通)。
const ALIASES = [
  [/英超|Premier\s*League|English\s*Premier/i, "英超"],
  [/西甲|La\s*Liga/i, "西甲"], [/德甲|Bundesliga/i, "德甲"], [/意甲|Serie\s*A/i, "意甲"], [/法甲|Ligue\s*1/i, "法甲"],
  [/英冠|Championship/i, "英冠"], [/荷甲|Eredivisie/i, "荷甲"], [/葡超|Primeira/i, "葡超"], [/土超|Super\s*Lig/i, "土超"], [/比甲|Jupiler|Belgian\s*Pro/i, "比甲"],
  [/日职|J\.?\s*League|日本/i, "日职"], [/韩K|K\s*League|韩职|韩国/i, "韩K"],
  [/澳超|A-?League|澳大利亚/i, "澳超"], [/美职|MLS|美国职业/i, "美职"],
  [/巴甲|Brasileir|巴西/i, "巴甲"], [/沙职|沙特|Saudi/i, "沙特联"], [/挪超|Eliteserien|挪威/i, "挪超"],
  [/瑞超|Allsvenskan|瑞典/i, "瑞超"], [/丹超|Superliga|丹麦/i, "丹超"], [/俄超|Russian|俄罗斯/i, "俄超"],
  [/墨超|Liga\s*MX|墨西哥/i, "墨超"], [/阿甲|阿根廷/i, "阿甲"], [/中超|Chinese|中国/i, "中超"],
  [/芬超|Veikkausliiga|芬兰/i, "芬超"],
  // 国际赛/友谊赛(非世界杯/非洲际杯赛):画像=ESPN 国际友谊先验,真实平局率高(~31%)、偏闷,供情景层提示平局风险。
  [/国际赛|国际友谊|友谊赛|International\s*Friendly|Friendly/i, "国际赛"],
  // 洲际杯赛:欧冠↔欧洲冠军联赛同一赛事(欧罗巴/欧协联为独立赛事,各自单变体不并)。
  [/欧冠|欧洲冠军|Champions\s*League/i, "欧冠"],
];

/** 把任意联赛名(中文全称/简称/英文)归一到规范 key,供跨数据源(画像/复盘账本)匹配。 */
export function canonicalLeague(name) {
  const s = String(name ?? "").trim();
  if (!s) return null;
  return ALIASES.find(([re]) => re.test(s))?.[1] ?? s;
}

/**
 * 取联赛画像。先精确 key,再模糊别名,最后全局基准兜底。
 * @returns {{avgGoals,drawRate,homeAdvantage,homeWinRate,overRate,n,source,matched:boolean}}
 */
export function leagueProfile(competition) {
  const leagues = load();
  const s = String(competition ?? "").trim();
  let p = leagues[s];
  if (!p) {
    const key = ALIASES.find(([re]) => re.test(s))?.[1];
    if (key) p = leagues[key];
  }
  const g = leagues.__global__ ?? { avgGoals: 2.7, drawRate: 0.26, homeAdvantage: 1.25, homeWinRate: 0.44, overRate: 0.52, n: 0, source: "fallback" };
  return p ? { ...p, matched: true } : { ...g, matched: false };
}

/** λ 缩放:本联赛场均进球 / 全局场均,夹在合理区间(德甲>1 放大、日职/意甲<1 收小)。 */
export function leagueLambdaScale(competition) {
  const leagues = load();
  const p = leagueProfile(competition);
  const g = leagues.__global__;
  if (!p.matched || !g?.avgGoals) return 1;
  const scale = p.avgGoals / g.avgGoals;
  return Math.max(0.8, Math.min(1.2, scale));
}
