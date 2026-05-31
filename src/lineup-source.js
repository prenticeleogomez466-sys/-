/**
 * Free Lineup Source(首发阵容免费源接入,2026-05-31)
 * ────────────────────────────────────────────────────────────
 * 目标:给"日韩/北欧/中超/巴甲…"这类只有收盘赔率、模型推理薄弱的联赛补一条**赛前首发**信号。
 * 首发阵容是少数**有时领先于市场**的公开信息(临场轮换/突发缺阵在收盘赔率定价后才确认),
 * 也是融合层 tactical-matchup / 阵型信号长期休眠的根因——此前根本没有 formation 数据源。
 *
 * 两条免费路径(诚实标注可达性):
 *   ① **ESPN summary**(`site.api.espn.com/.../{league}/summary?event={id}`)—— **Node 直连零授权**,
 *      实测覆盖日职/K联/MLS/巴甲/中超/沙特/北欧等(与 espn-results-source 同一批联赛),
 *      `rosters[].formation` + 每名球员 `starter/position/formationPlace`。首发赛前约 1 小时挂出。
 *      ⇒ 这是本模块主力,正好对口"薄数据联赛"。
 *   ② **Sofascore lineups**(走浏览器,Cloudflare 挡 Node)—— 五大联赛 + 多欧洲联赛,
 *      raw JSON 由浏览器层喂进来(同 sofascore-injury-source 的架构),本模块只做纯归一。
 *
 * ⚠️ 诚实边界:
 *   - ESPN 球员无身价/重要性 → 首发信号只用**阵型布阵姿态**(双防守→平局偏高、双进攻→平局偏低),
 *     这是有文献支撑、不需学习表的保守先验;不假装从首发名单推断"谁是核心"。
 *   - 公开首发大多已被收盘赔率定价 → 信号在**有市场先验时被融合层 gateFusionOff 正确关闭**,
 *     只在无欧赔的薄联赛 fire(那里没有市场价可依赖,先验有正价值)。
 *   - 布阵姿态→胜负平方向**关系弱且双向**(强队也常稳守反击取胜),故只动**平局轴**、严格有界,
 *     待 walk-forward 回测验证(需逐场历史 formation 回填)前不夸大,信号 LR 夹 [0.5,2]+融合双封顶。
 */

import { canonicalTeamName } from "./team-aliases.js";
import { ESPN_LEAGUES } from "./espn-results-source.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

/**
 * 解析阵型串 "3-4-2-1" → { defenders, midfielders, forwards, raw }。
 * 约定:首位=后卫数,末位=前锋数,中间各段之和=中场(含进攻中场)。无法解析 → null。
 */
export function parseFormation(str) {
  const raw = String(str ?? "").trim();
  const nums = raw.split(/[^0-9]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  // 阵型不含门将,至少要有"后卫-…-前锋"两段;总人数合理(7~10 名非门将球员)。
  if (nums.length < 2) return null;
  const total = nums.reduce((s, n) => s + n, 0);
  if (total < 7 || total > 10) return null;
  const defenders = nums[0];
  const forwards = nums[nums.length - 1];
  const midfielders = nums.slice(1, -1).reduce((s, n) => s + n, 0);
  return { defenders, midfielders, forwards, raw };
}

/**
 * 阵型布阵姿态:进攻/防守倾向。供首发信号判"双防守/双进攻"。
 * attack 仅作展示量;defensive/attacking 是信号实际用到的布尔判据。
 */
export function formationPosture(formation) {
  const f = parseFormation(formation);
  if (!f) return null;
  // 进攻指数:前锋越多、后防越薄越激进(纯展示,不直接进概率)。
  const attack = f.forwards + Math.max(0, 4 - f.defenders) * 0.5;
  return {
    ...f,
    attack: Math.round(attack * 100) / 100,
    // 用**无歧义**判据(2026-05-31 回测后修正):只认后卫数 / 真三前锋。
    //   旧判据 forwards<=1 把 4-2-3-1(末位 1 但实为平衡进攻)错判成摆防 → 双摆防占 37% 虚高。
    defensive: f.defenders >= 5,                  // 5 后卫 = 真低位防守
    attacking: f.forwards >= 3                    // 3 前锋(4-3-3 / 3-4-3)= 真压上
  };
}

/**
 * 首发布阵姿态 → 平局轴 LR(生产信号与回测的**单一真相源**)。
 * 只动平局轴(最稳健、有文献支撑的部分):
 *   - 双方都摆防 → 低进球闷局,平局↑(LR draw 1.18 / home,away 0.92)。
 *   - 双方都压上 → 对攻,平局↓(LR draw 0.85 / home,away 1.06)。
 *   - 其余 → null(布阵→胜负方向关系弱且双向,不强行推谁赢)。
 * @returns {{ lr:{home,draw,away}, detail:string, kind:"both-defensive"|"both-attacking" }|null}
 */
export function lineupPostureLR(homeFormation, awayFormation) {
  const pH = formationPosture(homeFormation);
  const pA = formationPosture(awayFormation);
  if (!pH || !pA) return null;
  if (pH.defensive && pA.defensive) {
    return { lr: { home: 0.92, draw: 1.18, away: 0.92 }, detail: `双方摆防(${pH.raw} vs ${pA.raw})→平局偏高`, kind: "both-defensive" };
  }
  if (pH.attacking && pA.attacking) {
    return { lr: { home: 1.06, draw: 0.85, away: 1.06 }, detail: `双方压上(${pH.raw} vs ${pA.raw})→平局偏低`, kind: "both-attacking" };
  }
  return null;
}

/**
 * 归一 ESPN summary 的 rosters → 统一首发层。
 * @returns {{home,away,source,confirmed}|null} 两侧都拿不到 → null
 */
export function normalizeEspnLineup(summary) {
  const rosters = summary?.rosters;
  if (!Array.isArray(rosters) || rosters.length < 2) return null;
  const side = (homeAway) => {
    const r = rosters.find((x) => x?.homeAway === homeAway) ?? null;
    if (!r) return null;
    const roster = Array.isArray(r.roster) ? r.roster : [];
    const starters = roster
      .filter((p) => p?.starter)
      .map((p) => ({
        name: p.athlete?.displayName ?? p.athlete?.fullName ?? p.athlete?.shortName ?? "",
        position: p.position?.abbreviation ?? null,
        slot: p.formationPlace ?? null
      }));
    return {
      team: r.team?.displayName ?? r.team?.name ?? null,
      formation: r.formation ?? null,
      starters,
      starterCount: starters.length,
      confirmed: starters.length >= 11   // 满 11 人 = 官方首发已确认(非"预测阵容")
    };
  };
  const home = side("home");
  const away = side("away");
  if (!home && !away) return null;
  return {
    home,
    away,
    source: "espn-summary",
    confirmed: Boolean(home?.confirmed && away?.confirmed)
  };
}

/**
 * 归一 Sofascore lineups(浏览器喂入 raw)→ 统一首发层。
 * Sofascore 形如 { confirmed, home:{formation, players:[{player,substitute}]}, away:{...} }。
 */
export function normalizeSofascoreLineup(lineups) {
  if (!lineups) return null;
  const side = (s) => {
    if (!s) return null;
    const starters = (Array.isArray(s.players) ? s.players : [])
      .filter((p) => p && p.substitute !== true)
      .map((p) => ({
        name: p.player?.name ?? "",
        position: p.player?.position ?? null,
        slot: p.player?.formationPlace ?? null
      }));
    return {
      team: s.team?.name ?? null,
      formation: s.formation ?? null,
      starters,
      starterCount: starters.length,
      confirmed: Boolean(lineups.confirmed) && starters.length >= 11
    };
  };
  const home = side(lineups.home);
  const away = side(lineups.away);
  if (!home && !away) return null;
  return { home, away, source: "sofascore-lineups", confirmed: Boolean(lineups.confirmed) };
}

// ── ESPN 当日赛程↔fixture 匹配(复用 canonical 别名 + 后缀容错,与 sofascore-injury-source 同思路) ──

const CLUB_AFFIXES = /\b(fk|fc|bk|ff|if|il|sk|cf|sc|ac|afc|cd|ud|kf|aif|bif|gif|sif|united|city|club|de)\b/gi;
function strippedCandidates(name) {
  const rawCanon = canonicalTeamName(name);
  const out = new Set();
  if (rawCanon) out.add(rawCanon);
  const noAffix = String(name ?? "").replace(CLUB_AFFIXES, " ").replace(/\s+/g, " ").trim();
  const c2 = canonicalTeamName(noAffix);
  if (c2) out.add(c2);
  return out;
}
function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** 在 ESPN 一个联赛 scoreboard 的 events 里给 fixture 匹配 event id(主客两侧都中才算)。 */
export function matchEspnEvent(events, fixture) {
  if (!Array.isArray(events) || !fixture) return null;
  const fh = canonicalTeamName(fixture.homeTeam);
  const fa = canonicalTeamName(fixture.awayTeam);
  if (!fh || !fa) return null;
  const teamsOf = (ev) => {
    const comp = ev?.competitions?.[0];
    const cs = comp?.competitors ?? [];
    const h = cs.find((c) => c.homeAway === "home")?.team;
    const a = cs.find((c) => c.homeAway === "away")?.team;
    return { h, a };
  };
  // 第一轮:严格 canonical 直配。
  for (const ev of events) {
    const { h, a } = teamsOf(ev);
    if (canonicalTeamName(h?.displayName ?? h?.name ?? "") === fh
      && canonicalTeamName(a?.displayName ?? a?.name ?? "") === fa) return ev.id;
  }
  // 第二轮:后缀容错宽松匹配。
  const fhSet = strippedCandidates(fixture.homeTeam);
  const faSet = strippedCandidates(fixture.awayTeam);
  for (const ev of events) {
    const { h, a } = teamsOf(ev);
    if (intersects(fhSet, strippedCandidates(h?.displayName ?? h?.name ?? ""))
      && intersects(faSet, strippedCandidates(a?.displayName ?? a?.name ?? ""))) return ev.id;
  }
  return null;
}

/** 抓单场 ESPN summary 首发。网络失败安全返回 ok:false。 */
export async function fetchEspnLineup(league, eventId, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  try {
    const r = await fetchImpl(`${ESPN_BASE}/${league}/summary?event=${eventId}`, { headers: UA });
    if (!r.ok) return { ok: false, reason: `ESPN HTTP ${r.status}` };
    const lineup = normalizeEspnLineup(await r.json());
    if (!lineup) return { ok: false, reason: "无 rosters/首发尚未挂出" };
    return { ok: true, lineup };
  } catch (e) {
    return { ok: false, reason: `ESPN summary 抓取失败:${e.message}` };
  }
}

function espnDateParam(date) {
  return String(date ?? "").replace(/-/g, "").slice(0, 8);
}

/**
 * 为当日 fixtures 抓 ESPN 免费首发:遍历 ESPN 覆盖联赛 scoreboard → 匹配 fixture → 抓 summary 首发。
 * 只对**匹配上且已挂首发**的场返回数据;其余正常跳过(赛前过早/非 ESPN 联赛)。
 * @returns {{ fixtureData: Record<string,object>, count: number, source: string }}
 */
export async function fetchEspnLineupsForFixtures(date, fixtures, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const leagues = opts.leagues ?? Object.keys(ESPN_LEAGUES);
  const dates = espnDateParam(date);
  const fixtureData = {};
  let count = 0;
  // 先各联赛 scoreboard 一次,建 event 索引,避免逐 fixture 重复抓。
  const leagueEvents = {};
  await Promise.all(leagues.map(async (lg) => {
    try {
      const r = await fetchImpl(`${ESPN_BASE}/${lg}/scoreboard?dates=${dates}`, { headers: UA });
      if (!r.ok) return;
      const j = await r.json();
      leagueEvents[lg] = Array.isArray(j?.events) ? j.events : [];
    } catch {
      // 单联赛失败不影响其它
    }
  }));
  for (const fixture of fixtures) {
    let matched = null;
    for (const [lg, events] of Object.entries(leagueEvents)) {
      const eventId = matchEspnEvent(events, fixture);
      if (eventId != null) { matched = { lg, eventId }; break; }
    }
    if (!matched) continue;
    const res = await fetchEspnLineup(matched.lg, matched.eventId, { fetch: fetchImpl });
    if (!res.ok) continue;
    fixtureData[fixture.id] = { ...res.lineup, league: matched.lg, providerEventId: matched.eventId };
    count += 1;
  }
  return { fixtureData, count, source: "ESPN summary (free)" };
}

/**
 * 首发轮询去重决策(纯函数,2026-06-01 抽出可测)。
 * 用户硬规则 [[feedback_lineup_autoreport]]:出阵容自动分析推送一份,且**同一场不重复发**。
 * 把"哪些是新首发 / 更新已上报状态 / 是否触发"的逻辑从 lineup-watch-gate(混 I/O)抽成纯函数,
 * 便于回归测试,防去重逻辑被改坏导致漏推或刷屏。
 *
 * @param {Object} prevState  watch-state.json 内容:{ "YYYY-MM-DD": [已上报 fixtureId...] }
 * @param {string} date       当日
 * @param {string[]} withLineupIds  当前已挂首发的 fixtureId 列表
 * @returns {{ fresh:string[], nextState:object, shouldTrigger:boolean }}
 *   fresh=本轮新出现(未上报过)的场;nextState=合并后的状态(去重、保序);shouldTrigger=有新首发。
 */
export function computeLineupWatch(prevState, date, withLineupIds) {
  const state = prevState && typeof prevState === "object" ? prevState : {};
  const seen = new Set(Array.isArray(state[date]) ? state[date] : []);
  const fresh = [];
  const freshSeen = new Set();
  for (const id of Array.isArray(withLineupIds) ? withLineupIds : []) {
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key) || freshSeen.has(key)) continue; // 已上报 或 本轮内重复 → 跳过
    freshSeen.add(key);
    fresh.push(key);
  }
  const nextState = { ...state, [date]: [...seen, ...fresh] };
  return { fresh, nextState, shouldTrigger: fresh.length > 0 };
}
