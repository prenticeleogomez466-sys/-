// 俱乐部联赛赛季战绩查询层(补 ESPN 不覆盖的联赛,如芬超)。
// 数据源 = D:/football-model-data/club-league-standings.json(worldfootball 真实积分榜,浏览器抓)。
// 诚实:这是"本季赛季战绩/攻防",不是"近5场具体结果"——渲染层须如实标注,绝不冒充成近5。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PATH = join(process.env.FOOTBALL_DATA_DIR || "D:/football-model-data", "club-league-standings.json");

let _cache = null;
function load() {
  if (_cache) return _cache;
  try { _cache = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : { leagues: {} }; }
  catch { _cache = { leagues: {} }; }
  return _cache;
}

// 队名归一(去空白/大小写/常见后缀),中英双向匹配
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").replace(/fc|if|sk|ps$/g, "").trim();

// 返回某队赛季战绩 {found,league,fetchedAt,rank,M,W,D,L,gf,ga,gfpg,gapg,record,winPct} 或 null
export function clubLeagueForm(zhName, leagueName) {
  const db = load();
  const want = norm(zhName);
  const leagues = leagueName ? [[leagueName, db.leagues?.[leagueName]]] : Object.entries(db.leagues || {});
  for (const [lg, ld] of leagues) {
    if (!ld?.teams) continue;
    for (const [zh, t] of Object.entries(ld.teams)) {
      if (zh === zhName || norm(zh) === want || norm(t.en) === want) {
        const gfpg = t.M ? Math.round((t.gf / t.M) * 100) / 100 : null;
        const gapg = t.M ? Math.round((t.ga / t.M) * 100) / 100 : null;
        return {
          found: true, league: lg, fetchedAt: ld.fetchedAt, season: ld.season,
          en: t.en, rank: t.rank, M: t.M, W: t.W, D: t.D, L: t.L, gf: t.gf, ga: t.ga,
          gfpg, gapg, record: `${t.W}胜${t.D}平${t.L}负`,
          winPct: t.M ? Math.round((t.W / t.M) * 100) : null,
          source: db.source || "club-league-standings",
        };
      }
    }
  }
  return null;
}

export function hasClubLeague(leagueName) {
  return !!load().leagues?.[leagueName];
}
