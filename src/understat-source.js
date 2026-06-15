/**
 * Understat 免费真 xG 源(2026-05-31)—— 五大联赛 + 俄超的真实 xG/npxG。
 * ────────────────────────────────────────────────────────────
 * Understat 把数据嵌在网页 JS 里:`var teamsData = JSON.parse('...hex...')` / `var datesData = ...`。
 * Node 直连只拿到 18KB 空壳(反爬剥数据)→ **raw 由浏览器层抓**(Playwright/系统 Chrome,
 * 仿 sofascore-injury-source 架构):浏览器 navigate 到 understat.com/league/<LG>/<season>,
 * 取页面里的 teamsData/datesData(HTML 或 evaluate 出的对象),存 dump 文件;本模块**纯归一**(可单测)。
 *
 * 输出喂 advanced-data 的 xg 层(同 {home:{team,xg}, away:{team,xg}} 形状),给 DC λ 更真的进球期望。
 * 诚实边界:仅 Understat 覆盖的联赛(EPL/La_liga/Bundesliga/Serie_A/Ligue_1/RFPL);
 * xG 提的是 λ/比分质量,**非市场 alpha**(回测证 xG 赢不过盘口)。免费,符合"只要免费"硬规则。
 */
import { canonicalTeamName } from "./team-aliases.js";


/**
 * 从 Understat 页面 HTML 提取并解码内嵌变量(`var <name> = JSON.parse('...')`)。
 * 字符串是 \xHH 十六进制转义,先还原再 JSON.parse。失败返回 null。
 */
export function decodeUnderstatVar(html, varName) {
  if (typeof html !== "string") return null;
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*JSON\\.parse\\(\\s*'([^']+)'\\s*\\)`);
  const m = html.match(re);
  if (!m) return null;
  try {
    const decoded = m[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * 某队近 n 场 xG 形态(防泄漏:只取严格早于 beforeDate 的场)。
 * @param {Object} teamsData Understat teamsData:{teamId:{title, history:[{date,h_a,xG,xGA,...}]}}
 * @returns {{xgFor:number, xgAgainst:number, n:number}|null}
 */
export function teamRecentXg(teamsData, teamTitle, opts = {}) {
  const n = opts.n ?? 6;
  const beforeDate = opts.beforeDate ?? null;
  const canon = canonicalTeamName(teamTitle);
  const team = Object.values(teamsData ?? {}).find((t) => canonicalTeamName(t?.title) === canon);
  if (!team || !Array.isArray(team.history)) return null;
  const hist = team.history
    .filter((g) => {
      if (!beforeDate) return true;
      const d = String(g.date ?? "").slice(0, 10);
      return d && d < beforeDate;
    })
    .slice(-n);
  if (!hist.length) return null;
  let sf = 0, sa = 0, c = 0;
  for (const g of hist) {
    const xg = num(g.xG), xga = num(g.xGA);
    if (xg == null || xga == null) continue;
    sf += xg; sa += xga; c++;
  }
  if (!c) return null;
  return { xgFor: sf / c, xgAgainst: sa / c, n: c };
}

const HOME_ADV = 1.1; // 主场进球期望乘子(温和,xG 已隐含部分主场)

/**
 * 用双方近期 xG 形态估这场的前瞻 λ(主/客进球期望):
 *   home λ = (主队近期攻 xG + 客队近期防 xGA)/2 × 主场乘子
 *   away λ = (客队近期攻 xG + 主队近期防 xGA)/2 ÷ 主场乘子
 * 任一队无数据 → null(优雅降级,不编造)。
 */
export function fixtureXgEstimate(teamsData, homeTeam, awayTeam, opts = {}) {
  const h = teamRecentXg(teamsData, homeTeam, opts);
  const a = teamRecentXg(teamsData, awayTeam, opts);
  if (!h || !a) return null;
  const homeXg = ((h.xgFor + a.xgAgainst) / 2) * HOME_ADV;
  const awayXg = ((a.xgFor + h.xgAgainst) / 2) / HOME_ADV;
  return {
    home: Math.round(homeXg * 1000) / 1000,
    away: Math.round(awayXg * 1000) / 1000,
    samples: { home: h.n, away: a.n },
  };
}

/**
 * 为当日 fixtures 装 xg 层(byFixtureId),只覆盖 Understat 能匹配上的场。
 * @param {Array} fixtures fixture-store 当日 fixtures
 * @param {Object} teamsData 浏览器抓来的 Understat teamsData(可多联赛 merge)
 * @param {{beforeDate?:string, n?:number}} opts
 */
export function buildXgLayerFromUnderstat(fixtures, teamsData, opts = {}) {
  const byFixtureId = {};
  let matched = 0;
  for (const fx of fixtures ?? []) {
    const est = fixtureXgEstimate(teamsData, fx.homeTeam, fx.awayTeam, opts);
    if (!est) continue;
    byFixtureId[fx.id] = {
      // source 含 "form-estimate":这是**赛前近期 xG 形态均值**(非该场真值),回测证比市场 O/U 差
      //   → estimateGoalLambdas 据此把它排在 O/U 之下、经验库之上(只在无盘口时兜底)。
      home: { team: fx.homeTeam, xg: est.home, source: "understat-form-estimate" },
      away: { team: fx.awayTeam, xg: est.away, source: "understat-form-estimate" },
      source: "understat-form-estimate",
      proxy: false, // 真 xG 派生(非射门代理),但为赛前形态估计、不顶替 O/U
      samples: est.samples,
    };
    matched++;
  }
  return { byFixtureId, matched, source: "understat" };
}

/**
 * 从一场 Understat match 页的 shotsData 汇总两队 xG(post-match 真值,用于回测校准)。
 * shotsData:{ h:[{xG,...}], a:[{xG,...}] }
 */
export function matchXgFromShots(shotsData) {
  if (!shotsData) return null;
  const sum = (arr) => (Array.isArray(arr) ? arr.reduce((s, sh) => s + (num(sh.xG) ?? 0), 0) : 0);
  if (!Array.isArray(shotsData.h) && !Array.isArray(shotsData.a)) return null;
  return { home: Math.round(sum(shotsData.h) * 1000) / 1000, away: Math.round(sum(shotsData.a) * 1000) / 1000 };
}

/**
 * 从 datesData(联赛赛程,含每场 xG)取某场的赛果级 xG(post-match)。供回测/校准。
 * datesData:[{ isResult, h:{title}, a:{title}, goals:{h,a}, xG:{h,a}, datetime }]
 */
export function matchXgFromDates(datesData, homeTeam, awayTeam) {
  if (!Array.isArray(datesData)) return null;
  const hc = canonicalTeamName(homeTeam), ac = canonicalTeamName(awayTeam);
  const row = datesData.find((d) => d?.isResult
    && canonicalTeamName(d?.h?.title) === hc && canonicalTeamName(d?.a?.title) === ac);
  if (!row?.xG) return null;
  return { home: num(row.xG.h), away: num(row.xG.a), goals: row.goals ? { home: num(row.goals.h), away: num(row.goals.a) } : null };
}
