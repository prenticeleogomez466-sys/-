/**
 * football-data.co.uk "/new/" 扩展源 loader(北欧/日职/其它主源未覆盖联赛)
 * ──────────────────────────────────────────────────────────────────────
 * 主源 mmz4281 只有五大联赛 + 13 个次级欧洲联赛;今天的竞彩常出现 芬超/瑞超/挪超/
 * 日职 等不在主源。football-data 的 /new/<国家>.csv 单文件含该国全部赛季(2012→今),
 * 用于建"经验库"覆盖这些联赛。
 *
 * ⚠️ 与主源的诚实差异(下游必须知道,避免假装有数据):
 *   - 只有【收盘赔率】(AvgC/PSC/B365C),没有开盘 → 无开→收 drift(SP变化维度对这些联赛缺失)。
 *   - 没有半场比分(HTHG/HTAG)→ 半全场只能由全场结果近似,不能精算。
 *   - 没有亚盘线/水位列、没有射门数据。
 *
 * 列(/new/ 统一 25 列):
 *   1 Country 2 League 3 Season 4 Date 5 Time 6 Home 7 Away 8 HG 9 AG 10 Res
 *   11-13 PSCH/D/A(Pinnacle 收) 14-16 MaxC 17-19 AvgCH/D/A(均值收) 23-25 B365C
 *
 * match shape 与 footballdata-loader 对齐(odds=oddsClose,hasOpening:false)。
 */

const BASE = "https://www.football-data.co.uk/new";

// /new/ 文件名(国家码)→ 中文竞彩联赛名(与 500.com fixture.competition 对齐)。
// 仅映射高把握的顶级联赛;未列出的国家文件默认用英文 League 列原值。
export const NEW_LEAGUE_FILES = {
  SWE: "瑞典超级联赛",
  NOR: "挪威超级联赛",
  FIN: "芬兰超级联赛",
  JPN: "日本职业联赛",
  DNK: "丹麦超级联赛",
  USA: "美国职业大联盟",
  MEX: "墨西哥足球甲级联赛",
  BRA: "巴西足球甲级联赛",
  ARG: "阿根廷足球甲级联赛",
  CHN: "中国足球协会超级联赛",
  IRL: "爱尔兰超级联赛",
  POL: "波兰足球甲级联赛",
  ROU: "罗马尼亚足球甲级联赛",
  RUS: "俄罗斯足球超级联赛",
  AUT: "奥地利足球超级联赛",
  SWZ: "瑞士足球超级联赛",
};

// 今天竞彩最常用的北欧 + 日职(默认抓取集,可扩)
export const NEW_DEFAULT_FILES = ["SWE", "NOR", "FIN", "JPN", "DNK"];

function toIsoDate(ddmmyyyy) {
  const m = String(ddmmyyyy || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function impliedProbs(oh, od, oa) {
  if (!oh || !od || !oa || oh <= 1 || od <= 1 || oa <= 1) return null;
  const raw = { home: 1 / oh, draw: 1 / od, away: 1 / oa };
  const total = raw.home + raw.draw + raw.away;
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { header: [], rows: [] };
  const header = lines[0].replace(/^﻿/, "").split(",").map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length / 2) continue;
    rows.push({ idx, cells });
  }
  return { header, rows };
}

async function loadOneFile(fileCode, fetchImpl) {
  const url = `${BASE}/${fileCode}.csv`;
  let text;
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return [];
    text = await r.text();
  } catch {
    return [];
  }
  const { rows } = parseCsv(text);
  if (!rows?.length) return [];
  const leagueLabel = NEW_LEAGUE_FILES[fileCode];
  const out = [];
  for (const { idx, cells } of rows) {
    const at = (name) => cells[idx(name)];
    const date = toIsoDate(at("Date"));
    const home = (at("Home") || "").trim();
    const away = (at("Away") || "").trim();
    const hg = num(at("HG"));
    const ag = num(at("AG"));
    if (!date || !home || !away || hg === null || ag === null) continue;
    // 收盘赔率(只此一个价格点):Avg 收 → Pinnacle 收 → B365 收
    const close =
      impliedProbs(num(at("AvgCH")), num(at("AvgCD")), num(at("AvgCA"))) ??
      impliedProbs(num(at("PSCH")), num(at("PSCD")), num(at("PSCA"))) ??
      impliedProbs(num(at("B365CH")), num(at("B365CD")), num(at("B365CA")));
    out.push({
      date,
      league: leagueLabel || (at("League") || "").trim() || fileCode,
      leagueFile: fileCode,
      season: (at("Season") || "").trim(),
      home,
      away,
      homeGoals: hg,
      awayGoals: ag,
      halfHome: null, // /new/ 无半场
      halfAway: null,
      referee: null,
      shots: null,
      sot: null,
      odds: close, // 无开盘 → 用收盘当唯一价格点
      oddsClose: close,
      oddsPinnacle: null,
      oddsPinnacleClose: impliedProbs(num(at("PSCH")), num(at("PSCD")), num(at("PSCA"))),
      hasOpening: false, // ⚠️ 无开盘赔率,不可算 drift
      hasHalfTime: false,
      source: "football-data /new/",
    });
  }
  return out;
}

/**
 * @param {{files?:string[], seasonFrom?:number, fetch?:Function}} opts
 *   files: /new/ 文件码数组(默认北欧+日职);seasonFrom: 只保留 Season >= 此年(如 2021)
 * @returns {Promise<{ok, matches, byLeague, withClosing}>}
 */
export async function loadFootballDataNewMatches(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const files = opts.files ?? NEW_DEFAULT_FILES;
  const seasonFrom = opts.seasonFrom ?? null;
  const all = [];
  const byLeague = {};
  for (const fileCode of files) {
    let rows = await loadOneFile(fileCode, fetchImpl);
    if (seasonFrom) rows = rows.filter((m) => Number(m.season) >= seasonFrom);
    all.push(...rows);
    byLeague[NEW_LEAGUE_FILES[fileCode] || fileCode] = rows.length;
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    ok: all.length > 0,
    matches: all,
    byLeague,
    withClosing: all.filter((m) => m.oddsClose).length,
  };
}
