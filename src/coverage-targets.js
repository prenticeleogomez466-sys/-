/**
 * coverage 抓取目标动态生成(2026-06-10,审计rank2)
 * ──────────────────────────────────────────────────
 * 废 fetch-match-coverage.mjs 里 7 场硬编码 MATCHES(06-09 批)——硬名单导致新场次
 * (世界杯 22 场,store 标 marketType=shengfucai)的近5/H2H/大小球/亚盘补全永不发生。
 * 改为从当日 fixtures store 动态生成:竞彩在售(jingcai)+ 世界杯场(shengfucai)全收,按对阵去重。
 *
 * 中文→英文映射(给 ESPN/The Odds API 查队用):
 *   · 世界杯队:groups.json team_name_zh 反查(真实官方数据,48 队全覆盖);
 *   · 非世界杯国际赛队:下方 INTL_ZH_EN 静态译名表(纯队名翻译、非数据编造,收录此前硬编码批已用过的);
 *   · 两边都查不到 → re=null,抓取层诚实标"⚠️无英文映射"不编(铁律:缺就标缺)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

// ESPN/The Odds API 对 groups.json 规范名的已知变体(同 world-cup-priors WC_TEAM_ALIASES 思路,只做名称归一)
const EN_VARIANTS = {
  "Korea Republic": "South Korea|Korea Republic",
  "Czechia": "Czechia|Czech Republic",
  "Turkiye": "Türkiye|Turkiye|Turkey",
  "United States": "United States|^USA",
  "Bosnia and Herzegovina": "Bosnia",
  "Ivory Coast": "Ivory Coast|Côte d'Ivoire|Cote d'Ivoire",
  "Cape Verde": "Cape Verde|Cabo Verde",
  "DR Congo": "DR Congo|Congo DR|Democratic Republic of the Congo",
  "Curacao": "Curaçao|Curacao",
  "Iran": "Iran|IR Iran",
};

// 非世界杯国际赛常见队译名(此前 06-09 硬编码批用过的 + 当期竞彩出现过的;查不到的诚实标缺,别往这堆猜)
const INTL_ZH_EN = {
  "中国": "China PR|^China$",
  "泰国": "Thailand",
  "匈牙利": "Hungary",
  "哈萨克斯坦": "Kazakhstan",
  "冰岛": "Iceland",
  "哥斯达黎加": "Costa Rica",
  "尼日利亚": "Nigeria",
};

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** groups.json team_name_zh 反查:中文 → 英文规范名。文件缺 → 空表(不编)。 */
export function loadZhToEn() {
  const p = join(getDataSubdir("world-cup"), "2026", "groups.json");
  if (!existsSync(p)) return {};
  const zh = JSON.parse(readFileSync(p, "utf8"))?.team_name_zh ?? {};
  const out = {};
  for (const [en, z] of Object.entries(zh)) out[z] = en;
  return out;
}

/**
 * fixtures(store 当日)→ 抓取目标列表(对阵去重)。
 * 收录规则:marketType=jingcai 或 competition 含"世界杯"(shengfucai 的世界杯场必须进来)。
 * @returns [{ zh, comp, wc, home:{zh,en,re}, away:{zh,en,re} }]
 */
export function buildCoverageTargets(fixtures, zhToEn = {}) {
  const seen = new Map();
  const reOf = (zhName) => {
    const en = zhToEn[zhName] ?? INTL_ZH_EN[zhName] ?? null;
    if (!en) return { zh: zhName, en: null, re: null }; // ⚠️无英文映射 → 抓取层标缺不编
    return { zh: zhName, en, re: EN_VARIANTS[en] ?? reEscape(en) };
  };
  for (const f of fixtures ?? []) {
    if (!f?.homeTeam || !f?.awayTeam) continue;
    const wc = String(f.competition ?? "").includes("世界杯");
    if (!(f.marketType === "jingcai" || wc)) continue;
    const key = `${f.homeTeam}|${f.awayTeam}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      zh: `${f.homeTeam} vs ${f.awayTeam}`,
      comp: wc ? "世界杯·单场" : (f.competition || "国际赛"),
      wc,
      home: reOf(f.homeTeam),
      away: reOf(f.awayTeam),
    });
  }
  return [...seen.values()];
}
