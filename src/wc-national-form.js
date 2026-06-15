// 世界杯 48 队【近5战 + H2H】决定因素(2026-06-11)——数据来自 sync-wc-national-results.mjs 缓存的真实 ESPN 国际赛赛果。
// 铁律:只用真实抓到的赛果;归一不到/无样本 → 标缺不编。回测层面 form/H2H 对 1X2 命中未证增益
//   ([[reference_football_module_ablation_2026-06-02]]),故仅作【透明决定因素观察】展示,不偷偷改概率。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { canonicalTeamName } from "./team-aliases.js";

const CACHE = join(getDataSubdir("world-cup"), "2026", "wc-national-results.json");

export function loadNationalResults() {
  if (!existsSync(CACHE)) return { fetchedAt: null, matches: [] };
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return { fetchedAt: null, matches: [] }; }
}

const RES = (gf, ga) => (gf > ga ? "胜" : gf === ga ? "平" : "负");

// 缓存按【英文名】(homeEn/awayEn)存,而调用方常传规范中文名(canonicalTeamName(德国)="德国")——
// 直接 === 比对会因中英不一致全 miss(2026-06-14 "情报近期赛全空"根因)。两侧统一过 canonicalTeamName 归一,
// 中/英任一形式都能匹配;homeEn 为 null 时回退 home 字段。
const canon = (v) => canonicalTeamName(v ?? "");
const homeName = (m) => m.homeEn || m.home;
const awayName = (m) => m.awayEn || m.away;
const isTeam = (name, team) => name != null && canon(name) === team;

/** 某队近 n 场(队名中/英皆可)。返回 null 表示无缓存样本(标缺)。 */
export function recentForm(cache, team, n = 5) {
  const T = canon(team);
  if (!T || !cache?.matches?.length) return null;
  const ms = cache.matches.filter((m) => isTeam(homeName(m), T) || isTeam(awayName(m), T))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  if (!ms.length) return null;
  let gf = 0, ga = 0, w = 0, d = 0, l = 0;
  const list = ms.map((m) => {
    const home = isTeam(homeName(m), T);
    const my = home ? m.homeGoals : m.awayGoals, opp = home ? m.awayGoals : m.homeGoals;
    const opName = home ? awayName(m) : homeName(m);
    const r = RES(my, opp); if (r === "胜") w++; else if (r === "平") d++; else l++;
    gf += my; ga += opp;
    return { date: m.date, vs: opName, ha: home ? "主" : "客", score: `${my}-${opp}`, r };
  });
  return { played: ms.length, record: `${w}胜${d}平${l}负`, w, d, l, gf, ga, since: ms[ms.length - 1].date, list };
}

/** 两队 H2H(从 a 视角,队名中/英皆可)。无交手返回 null。 */
export function headToHead(cache, a, b, n = 6) {
  const A = canon(a), B = canon(b);
  if (!A || !B || !cache?.matches?.length) return null;
  const ms = cache.matches.filter((m) =>
    (isTeam(homeName(m), A) && isTeam(awayName(m), B)) || (isTeam(homeName(m), B) && isTeam(awayName(m), A)))
    .sort((a2, b2) => b2.date.localeCompare(a2.date)).slice(0, n);
  if (!ms.length) return null;
  let aw = 0, dr = 0, bw = 0;
  const list = ms.map((m) => {
    const aHome = isTeam(homeName(m), A);
    const ag = aHome ? m.homeGoals : m.awayGoals, bg = aHome ? m.awayGoals : m.homeGoals;
    const r = RES(ag, bg); if (r === "胜") aw++; else if (r === "平") dr++; else bw++;
    return { date: m.date, score: `${ag}-${bg}`, aHome, r };
  });
  return { played: ms.length, aWins: aw, draws: dr, bWins: bw, summary: `${A} ${aw}胜${dr}平${bw}负`, list };
}
