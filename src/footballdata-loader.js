/**
 * football-data.co.uk 加载器
 * ────────────────────────────────────────────────────────────
 * 免费历史源,CSV 同时含:赛果(FTHG/FTAG/FTR)、半场(HTHG/HTAG)、
 * 多家博彩赔率(B365/Pinnacle/Avg)、裁判、射门角球牌。
 * 用于 walk-forward 实战级回测 —— 终于能把"赔率隐含概率"纳入对比,
 * 回答"模型+融合能否赢过市场"。
 *
 * 联赛代码:E0=英超 SP1=西甲 D1=德甲 I1=意甲 F1=法甲。
 * 赔率优先用 Avg*(市场均值,最稳),缺失退回 B365*。
 */

const BASE = "https://www.football-data.co.uk/mmz4281";
const DEFAULT_LEAGUES = ["E0", "SP1", "D1", "I1", "F1"];
// 扩展联赛(Z 档):football-data.co.uk 免费同格式覆盖、且带开盘+收盘赔率的其余 13 个联赛。
// big-5 已由 OpenFootball 回填,故扩展集只含新联赛,避免与 big-5 重复。
export const EXTENDED_LEAGUES = ["E1", "E2", "EC", "SC0", "D2", "I2", "SP2", "F2", "N1", "B1", "P1", "T1", "G1"];
export const ALL_LEAGUES = [...DEFAULT_LEAGUES, ...EXTENDED_LEAGUES];
export const LEAGUE_LABELS = {
  E0: "英超", E1: "英冠", E2: "英甲", EC: "英乙", SC0: "苏超",
  SP1: "西甲", SP2: "西乙", D1: "德甲", D2: "德乙", I1: "意甲", I2: "意乙",
  F1: "法甲", F2: "法乙", N1: "荷甲", B1: "比甲", P1: "葡超", T1: "土超", G1: "希腊超"
};
// 近五年(经验库需要):2122/2223/2324/2425/2526。早赛季部分联赛 CSV 列较少,loadOne 容错。
const DEFAULT_SEASONS = ["2526", "2425", "2324", "2223", "2122"];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length / 2) continue;
    rows.push({ idx, cells });
  }
  return { header, rows };
}

function toIsoDate(ddmmyyyy) {
  // DD/MM/YYYY 或 DD/MM/YY → YYYY-MM-DD
  const m = String(ddmmyyyy || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function num(cells, i) {
  if (i < 0) return null;
  const v = Number(cells[i]);
  return Number.isFinite(v) ? v : null;
}

function impliedProbs(oh, od, oa) {
  if (!oh || !od || !oa || oh <= 1 || od <= 1 || oa <= 1) return null;
  const raw = { home: 1 / oh, draw: 1 / od, away: 1 / oa };
  const total = raw.home + raw.draw + raw.away; // 去除 overround(vig)
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

// 大小球 2.5 两路赔率 → 去 vig 后的 P(总进球 > 2.5)。两路缺一即 null。
function impliedOver(over, under) {
  if (!over || !under || over <= 1 || under <= 1) return null;
  const o = 1 / over, u = 1 / under;
  return o / (o + u);
}

async function loadOne(league, season, fetchImpl) {
  const url = `${BASE}/${season}/${league}.csv`;
  let text;
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return [];
    text = await r.text();
  } catch {
    return [];
  }
  const parsed = parseCsv(text);
  if (!parsed.rows) return [];
  const { rows } = parsed;
  const out = [];
  for (const { idx, cells } of rows) {
    const date = toIsoDate(cells[idx("Date")]);
    const home = (cells[idx("HomeTeam")] || "").trim();
    const away = (cells[idx("AwayTeam")] || "").trim();
    const fthg = num(cells, idx("FTHG"));
    const ftag = num(cells, idx("FTAG"));
    if (!date || !home || !away || fthg === null || ftag === null) continue;
    // 赔率:优先市场均值,退回 Bet365
    // odds        = 开盘均赔(market consensus 早盘,= 当前 prior)
    // oddsClose   = 收盘均赔(AvgC*,博彩界公认最有效价格,只在 kickoff 已知)
    // oddsPinnacle/oddsPinnacleClose = Pinnacle 开/收(PS*/PSC*,最 sharp 的庄,锐钱风向)
    const odds =
      impliedProbs(num(cells, idx("AvgH")), num(cells, idx("AvgD")), num(cells, idx("AvgA"))) ??
      impliedProbs(num(cells, idx("B365H")), num(cells, idx("B365D")), num(cells, idx("B365A")));
    const oddsClose =
      impliedProbs(num(cells, idx("AvgCH")), num(cells, idx("AvgCD")), num(cells, idx("AvgCA"))) ??
      impliedProbs(num(cells, idx("B365CH")), num(cells, idx("B365CD")), num(cells, idx("B365CA")));
    const oddsPinnacle = impliedProbs(num(cells, idx("PSH")), num(cells, idx("PSD")), num(cells, idx("PSA")));
    const oddsPinnacleClose = impliedProbs(num(cells, idx("PSCH")), num(cells, idx("PSCD")), num(cells, idx("PSCA")));
    // 亚盘(经验库需要):AHh=开盘让球线(主队视角,负=主让),AvgAHH/AvgAHA=开盘均值水位;
    //   AHCh/AvgCAHH/AvgCAHA=收盘线+水位。线 open→close 移动 = 真实盘口异动信号。缺列为 null。
    const ahLine = num(cells, idx("AHh"));
    const ahLineClose = num(cells, idx("AHCh"));
    const asian =
      ahLine !== null || ahLineClose !== null
        ? {
            line: ahLine,
            homeWater: num(cells, idx("AvgAHH")),
            awayWater: num(cells, idx("AvgAHA")),
            lineClose: ahLineClose,
            homeWaterClose: num(cells, idx("AvgCAHH")),
            awayWaterClose: num(cells, idx("AvgCAHA")),
          }
        : null;
    // 射门 / 射正(HS/AS/HST/AST):pre-xG 时代期望进球代理的原料。
    // football-data.co.uk 五大联赛逐场都有,缺失(部分低级别联赛)则为 null,下游自动忽略。
    const hs = num(cells, idx("HS"));
    const as = num(cells, idx("AS"));
    const hst = num(cells, idx("HST"));
    const ast = num(cells, idx("AST"));
    const shots = hs !== null && as !== null ? { home: hs, away: as } : null;
    const sot = hst !== null && ast !== null ? { home: hst, away: ast } : null;
    // 角球(HC/AC)与牌(HY/AY/HR/AR/HF/AF):五大联赛逐场都有,低级别/早赛季部分缺 → null。
    // 角球喂角球泊松模型(全新低流动性市场);牌喂黄牌/犯规模型。下游缺失自动忽略。
    const hc = num(cells, idx("HC"));
    const ac = num(cells, idx("AC"));
    const corners = hc !== null && ac !== null ? { home: hc, away: ac } : null;
    const hy = num(cells, idx("HY"));
    const ay = num(cells, idx("AY"));
    const hr = num(cells, idx("HR"));
    const ar = num(cells, idx("AR"));
    const hf = num(cells, idx("HF"));
    const af = num(cells, idx("AF"));
    const cards =
      hy !== null && ay !== null
        ? { homeYellow: hy, awayYellow: ay, homeRed: hr, awayRed: ar, homeFouls: hf, awayFouls: af }
        : null;
    out.push({
      date,
      league,
      home,
      away,
      homeGoals: fthg,
      awayGoals: ftag,
      halfHome: num(cells, idx("HTHG")),
      halfAway: num(cells, idx("HTAG")),
      // 大小球 2.5 隐含 P(over):用于按 O/U 赔率校准 λ 总量。Avg→BbAv→B365 三级回退,缺为 null。
      overProb:
        impliedOver(num(cells, idx("Avg>2.5")), num(cells, idx("Avg<2.5"))) ??
        impliedOver(num(cells, idx("BbAv>2.5")), num(cells, idx("BbAv<2.5"))) ??
        impliedOver(num(cells, idx("B365>2.5")), num(cells, idx("B365<2.5"))),
      overProbClose:
        impliedOver(num(cells, idx("AvgC>2.5")), num(cells, idx("AvgC<2.5"))) ??
        impliedOver(num(cells, idx("B365C>2.5")), num(cells, idx("B365C<2.5"))),
      referee: (cells[idx("Referee")] || "").trim() || null,
      shots, // {home,away} 总射门数,或 null
      sot, // {home,away} 射正数,或 null
      corners, // {home,away} 角球数,或 null
      cards, // {homeYellow,awayYellow,homeRed,awayRed,homeFouls,awayFouls},或 null
      odds, // {home,draw,away} 去 vig 后的隐含概率,或 null(开盘均赔)
      oddsClose, // 收盘均赔隐含,或 null
      oddsPinnacle, // Pinnacle 开盘隐含,或 null
      oddsPinnacleClose, // Pinnacle 收盘隐含,或 null
      asian, // {line,homeWater,awayWater,lineClose,homeWaterClose,awayWaterClose} 或 null
      hasOpening: Boolean(odds)
    });
  }
  return out;
}

/**
 * @param {{leagues?, seasons?, fetch?}} opts
 * @returns {Promise<{ok, matches, withOdds, byLeague}>}
 */
export async function loadFootballDataMatches(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const leagues = opts.leagues ?? DEFAULT_LEAGUES;
  const seasons = opts.seasons ?? DEFAULT_SEASONS;
  const all = [];
  const byLeague = {};
  for (const league of leagues) {
    for (const season of seasons) {
      const rows = await loadOne(league, season, fetchImpl);
      all.push(...rows);
      byLeague[league] = (byLeague[league] ?? 0) + rows.length;
    }
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    ok: all.length > 0,
    matches: all,
    withOdds: all.filter((m) => m.odds).length,
    withClosing: all.filter((m) => m.oddsClose).length,
    withPinnacle: all.filter((m) => m.oddsPinnacle).length,
    withShots: all.filter((m) => m.shots && m.sot).length,
    withCorners: all.filter((m) => m.corners).length,
    withCards: all.filter((m) => m.cards).length,
    withAsian: all.filter((m) => m.asian && (m.asian.line !== null || m.asian.lineClose !== null)).length,
    byLeague
  };
}
