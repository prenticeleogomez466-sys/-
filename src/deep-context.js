// 深度情景数据层(2026-06-06 神选独立设计)——为足球大模型每日自动补齐:真实开赛时间 + 两队近5场状态
// + H2H 历史交锋。数据源 = ESPN 免授权 API(无 key、无反爬)。永久铁律:ESPN 不覆盖的联赛/未匹配的场
// 一律标缺(不进 fixtureData),绝不兜底/臆造。本层是【情景展示层】——只供展示与情景研判,不直接驱动
// wld 概率方向(回测铁证:form/H2H 叠加市场赔率不提命中率,见 reference_signal_backtest_findings)。
import { canonicalTeamName } from "./team-aliases.js";

// 竞彩常见联赛 → ESPN 联赛码(可扩展;未列出的联赛=ESPN无覆盖→该场标缺,不兜底)
export const ESPN_LEAGUE_CODES = {
  "日本职业联赛": "jpn.1", "日职": "jpn.1", "日职联": "jpn.1",
  "英超": "eng.1", "英冠": "eng.2", "英甲": "eng.3", "英乙": "eng.4", "英足总杯": "eng.fa",
  "西甲": "esp.1", "西乙": "esp.2", "意甲": "ita.1", "意乙": "ita.2",
  "德甲": "ger.1", "德乙": "ger.2", "法甲": "fra.1", "法乙": "fra.2",
  "荷甲": "ned.1", "葡超": "por.1", "比甲": "bel.1", "苏超": "sco.1", "土超": "tur.1",
  "美职": "usa.1", "韩K联": "kor.1", "K联赛": "kor.1", "沙特联": "ksa.1",
  "挪超": "nor.1", "瑞超": "swe.1", "丹超": "den.1", "巴甲": "bra.1", "阿甲": "arg.1",
  "中超": "chn.1", "澳超": "aus.1", "俄超": "rus.1", "希腊超": "gre.1", "墨超": "mex.1",
  "国际赛": "fifa.friendly", "友谊赛": "fifa.friendly", "国家队赛": "fifa.friendly",
  "欧冠": "uefa.champions", "欧罗巴": "uefa.europa", "欧协联": "uefa.europa.conf",
};

export function espnCodeFor(competition) {
  if (!competition) return null;
  const c = String(competition).trim();
  if (ESPN_LEAGUE_CODES[c]) return ESPN_LEAGUE_CODES[c];
  for (const [k, v] of Object.entries(ESPN_LEAGUE_CODES)) if (c.includes(k)) return v;
  return null;
}

// ISO(UTC) → 北京时间 "MM-DD HH:mm"(权威开赛时间,替代之前缺失/不可信的时刻)
export function kickoffBeijing(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.month}-${v.day} ${v.hour}:${v.minute}`;
}

// ESPN team schedule JSON → 该队近 N 场已完赛的"胜/平/负"串(最近在右)。无完赛=null(不臆造)
export function parseEspnForm(scheduleJson, teamId, n = 5) {
  const evs = (scheduleJson?.events || []).filter((e) => e?.competitions?.[0]?.status?.type?.completed);
  const done = evs.slice(-n);
  const out = [];
  for (const e of done) {
    const c = e.competitions[0];
    const me = (c.competitors || []).find((x) => String(x.team?.id) === String(teamId));
    const op = (c.competitors || []).find((x) => String(x.team?.id) !== String(teamId));
    const ms = Number(me?.score?.value ?? me?.score), os = Number(op?.score?.value ?? op?.score);
    if (!Number.isFinite(ms) || !Number.isFinite(os)) continue;
    out.push(ms > os ? "胜" : ms < os ? "负" : "平");
  }
  return out.length ? out.join("") : null;
}

// ESPN summary.headToHeadGames → 最近 N 次交锋比分串。无=null
export function parseEspnH2h(summaryJson, n = 3) {
  const hg = summaryJson?.headToHeadGames;
  const games = Array.isArray(hg) ? (hg[0]?.events || []) : [];
  const out = games.slice(0, n).map((g) => {
    const hs = g.homeTeamScore ?? g.homeScore, as = g.awayTeamScore ?? g.awayScore;
    const dt = (g.gameDate || g.date || "").slice(0, 7);
    return (hs != null && as != null) ? `${dt} ${hs}-${as}` : null;
  }).filter(Boolean);
  return out.length ? out.join(" / ") : null;
}

// 把 fixture 的中文主客队匹配到 ESPN scoreboard 事件(canonical 双边)。无匹配=null(标缺)
export function matchFixtureToEvent(fixture, events) {
  const hC = canonicalTeamName(fixture.homeTeam), aC = canonicalTeamName(fixture.awayTeam);
  for (const e of events || []) {
    const comp = e.competitions?.[0]; if (!comp) continue;
    const home = (comp.competitors || []).find((x) => x.homeAway === "home");
    const away = (comp.competitors || []).find((x) => x.homeAway === "away");
    if (!home || !away) continue;
    const ehC = canonicalTeamName(home.team?.displayName), eaC = canonicalTeamName(away.team?.displayName);
    if (ehC === hC && eaC === aC) return { event: e, homeId: home.team?.id, awayId: away.team?.id };
    // 主客可能相反(ESPN 用 "X at Y" 表示 Y 主场)→ 也认对应同向
    if (ehC === aC && eaC === hC) return { event: e, homeId: home.team?.id, awayId: away.team?.id, swapped: true };
  }
  return null;
}

// 近期交锋识别(两回合赛制线索):H2H 最近一次若在 fixture 前 ~16 天内 = 两队刚踢过,
//   很可能是两回合淘汰赛首回合 → 标出"近X天交锋 A-B"作线索(留意累计形势/领先方轮换)。
//   永久铁律:只标真实观测到的"刚交锋"事实+谨慎线索,不自动硬判"死签"(那是启发式会误判),
//   累计/死签由用户结合判断。无近期交锋=null。
export function recentMeetingContext(h2h, kickoffIso, withinDays = 16) {
  if (!h2h || !kickoffIso) return null;
  const first = String(h2h).split("/")[0].trim(); // "2026-05 5-0"
  const m = first.match(/(\d{4})-(\d{2})\s+(\d+)-(\d+)/);
  if (!m) return null;
  const koMs = new Date(kickoffIso).getTime();
  // H2H 只给到年-月,取该月中估算;保守用"月初"算最大间隔,够近才标
  const metMs = new Date(`${m[1]}-${m[2]}-15T00:00Z`).getTime();
  if (!Number.isFinite(koMs) || !Number.isFinite(metMs)) return null;
  const days = Math.round((koMs - metMs) / 86400000);
  if (days < 0 || days > withinDays + 15) return null; // +15 容月内估算误差
  return { score: `${m[3]}-${m[4]}`, monthsTag: `${m[1]}-${m[2]}`,
    note: `近期已交锋 ${m[3]}-${m[4]}(${m[1]}-${m[2]})——若两回合赛制,此为首回合,留意累计形势与领先方轮换` };
}

const espnUrl = (code, path) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/${path}`;
async function espnJson(url, fetchImpl) {
  try { const r = await fetchImpl(url); return r.ok ? await r.json() : null; } catch { return null; }
}

/**
 * 每日深度情景层:为每场抓真实开赛时间 + 两队近5状态 + H2H。
 * @returns {{ok,source,count,fixtureData}} fixtureData[fixtureId]={kickoffBeijing,kickoffIso,home:{form},away:{form},h2h,source}
 */
export async function syncDeepContext(date, fixtures = [], fetchImpl = (typeof fetch !== "undefined" ? fetch : null)) {
  if (!fetchImpl) return { ok: false, source: "ESPN", count: 0, fixtureData: {}, warning: "无 fetch 实现" };
  const ymd = String(date).replace(/-/g, "");
  // 按 ESPN 联赛码分组(未映射的联赛跳过=标缺,不兜底)
  const byCode = new Map();
  for (const fx of fixtures) {
    const code = espnCodeFor(fx.competition);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(fx);
  }
  const fixtureData = {};
  const formCache = new Map();
  for (const [code, fxs] of byCode) {
    const sb = await espnJson(espnUrl(code, `scoreboard?dates=${ymd}`), fetchImpl);
    const events = sb?.events || [];
    for (const fx of fxs) {
      const m = matchFixtureToEvent(fx, events);
      if (!m) continue; // 未匹配=标缺
      const teamForm = async (id) => {
        const ck = `${code}:${id}`;
        if (formCache.has(ck)) return formCache.get(ck);
        const sch = await espnJson(espnUrl(code, `teams/${id}/schedule`), fetchImpl);
        const f = parseEspnForm(sch, id);
        formCache.set(ck, f); return f;
      };
      const [hForm, aForm, summary] = await Promise.all([
        teamForm(m.homeId), teamForm(m.awayId),
        espnJson(espnUrl(code, `summary?event=${m.event.id}`), fetchImpl),
      ]);
      const h2h = parseEspnH2h(summary);
      fixtureData[fx.id] = {
        kickoffIso: m.event.date ?? null,
        kickoffBeijing: kickoffBeijing(m.event.date),
        home: { form: m.swapped ? aForm : hForm },
        away: { form: m.swapped ? hForm : aForm },
        h2h,
        recentMeeting: recentMeetingContext(h2h, m.event.date),
        source: "ESPN (免授权)",
      };
    }
  }
  const count = Object.keys(fixtureData).length;
  return { ok: count > 0, source: "ESPN (kickoff/form/H2H)", count, fixtureData, warning: count ? null : "今日无 ESPN 覆盖联赛/未匹配" };
}
