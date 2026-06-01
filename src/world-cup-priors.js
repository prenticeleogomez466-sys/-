/**
 * 2026 世界杯专属特征/先验模块(2026-06-01 用户:「围绕世界杯各方面做准备」)。
 *
 * 把世界杯的**场地(海拔/气温/恒温顶棚)、赛制阶段、分组、时差**等结构性真实特征,
 * 转成模型推断时可用的 λ(进球)乘子 + 阶段强度/平局倾向,接进 prediction-engine 的
 * 估 λ 与软赛事平局重校准。数据来自:
 *   D:\football-model-data\world-cup\2026\{venues,groups,format}.json(真实,来源已核 FIFA/Wikipedia)。
 *
 * 设计原则:
 *  - 只在「确属 2026 世界杯且能确定场地/阶段」时叠加修正,否则优雅降级(返回中性 1.0),不臆造。
 *  - 所有系数为**先验**,标 TODO 待 walk-forward + 历史世界杯(2018/2022)回测校准。
 *  - 不破坏俱乐部/常规赛路径:isWorldCup 为假时全部短路返回中性。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

let _cache = null;
function load() {
  if (_cache) return _cache;
  const dir = join(getDataSubdir("world-cup"), "2026");
  const read = (f) => {
    const p = join(dir, f);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  const venuesDoc = read("venues.json");
  const groupsDoc = read("groups.json");
  const formatDoc = read("format.json");
  // 建中文/英文 → venue 的城市索引(场馆匹配用)
  const venueByCity = new Map();
  for (const v of venuesDoc?.venues ?? []) {
    venueByCity.set(v.city.toLowerCase(), v);
    if (v.city_zh) venueByCity.set(v.city_zh, v);
  }
  // 球队 → 组 索引(英文规范名 + 中文)
  const teamGroup = new Map();
  const zh = groupsDoc?.team_name_zh ?? {};
  for (const [g, teams] of Object.entries(groupsDoc?.groups ?? {})) {
    for (const t of teams) {
      teamGroup.set(t.toLowerCase(), g);
      if (zh[t]) teamGroup.set(zh[t], g);
    }
  }
  _cache = { venuesDoc, groupsDoc, formatDoc, venueByCity, teamGroup, zh };
  return _cache;
}

/** 是否属于 2026 世界杯正赛:竞赛名命中世界杯 且 日期落在赛会窗口内。 */
export function isWorldCup2026(competition, date) {
  if (!/世界杯|World\s*Cup|FIFA\s*World/i.test(String(competition ?? ""))) return false;
  if (date) {
    const d = String(date).slice(0, 10);
    if (d < "2026-06-11" || d > "2026-07-19") return false;
  }
  return true;
}

/** 按日期判定赛事阶段(小组赛/淘汰赛…),返回 {phase, phase_zh, intensity, drawTendency} 或 null。 */
export function worldCupPhase(date) {
  const { formatDoc } = load();
  if (!formatDoc || !date) return null;
  const d = String(date).slice(0, 10);
  for (const ph of formatDoc.phases) {
    if (ph.start && ph.end && d >= ph.start && d <= ph.end) {
      return { phase: ph.phase, phase_zh: ph.phase_zh, intensity: ph.intensity, drawTendency: ph.draw_tendency, note: ph.note };
    }
  }
  // 窗口内但落在阶段间隙 → 归最近的小组/淘汰阶段默认
  if (d >= "2026-06-11" && d <= "2026-07-19") {
    const ph = formatDoc.phases.find((p) => p.phase === (d <= "2026-06-27" ? "group" : "round_of_16"));
    return ph ? { phase: ph.phase, phase_zh: ph.phase_zh, intensity: ph.intensity, drawTendency: ph.draw_tendency, note: ph.note } : null;
  }
  return null;
}

/** 取该队所在小组(英文/中文均可),无则 null。 */
export function teamGroupOf(team) {
  if (!team) return null;
  const { teamGroup } = load();
  return teamGroup.get(String(team).toLowerCase()) ?? teamGroup.get(String(team)) ?? null;
}

/** 解析 fixture 的世界杯场地:优先 fixture.venue/city/stadium 字段,匹配 venues 表;无则 null。 */
export function worldCupVenue(fixture) {
  if (!fixture) return null;
  const { venueByCity, venuesDoc } = load();
  const cand = [fixture.venueCity, fixture.city, fixture.venue, fixture.stadium].filter(Boolean);
  for (const c of cand) {
    const hit = venueByCity.get(String(c).toLowerCase()) ?? venueByCity.get(String(c));
    if (hit) return hit;
    // 模糊:venue 表里 stadium 名包含
    const byStadium = (venuesDoc?.venues ?? []).find((v) => String(c).toLowerCase().includes(v.stadium.toLowerCase().split(" ")[0]));
    if (byStadium) return byStadium;
  }
  return null;
}

/**
 * 场地(海拔/气温/恒温)对**进球总量 λ** 的先验乘子。
 * 依据足球研究常识(待回测校准):
 *  - 高海拔:稀薄空气球速快 + 客队体能折损 → 进球略增。>2000m ×1.06、1200-2000 ×1.03。
 *  - 高温(室外非恒温):节奏下降、补水暂停 → 进球略减。>34℃ ×0.95、30-34 ×0.97。
 *  - 恒温顶棚场:抵消高温,温度乘子归 1。
 * 返回 { mult, factors:[...] }。无 venue → {mult:1, factors:[]}(中性)。
 */
export function venueLambdaMultiplier(venue) {
  if (!venue) return { mult: 1, factors: [] };
  let mult = 1;
  const factors = [];
  const alt = Number(venue.altitude_m);
  if (Number.isFinite(alt)) {
    if (alt >= 2000) { mult *= 1.06; factors.push(`海拔${alt}m(稀薄空气·客队体能折损)→进球↑6%`); }
    else if (alt >= 1200) { mult *= 1.03; factors.push(`海拔${alt}m→进球↑3%`); }
  }
  const temp = Number(venue.june_july_avg_high_c);
  if (Number.isFinite(temp) && !venue.indoor_climate_controlled) {
    if (temp >= 34) { mult *= 0.95; factors.push(`高温${temp}℃(节奏↓·补水暂停)→进球↓5%`); }
    else if (temp >= 30) { mult *= 0.97; factors.push(`偏热${temp}℃→进球↓3%`); }
  } else if (venue.indoor_climate_controlled) {
    factors.push("恒温顶棚→气温中性");
  }
  return { mult: Number(mult.toFixed(4)), factors };
}

/**
 * 世界杯综合 λ 上下文:给 estimateGoalLambdas 用的总量乘子 + 阶段平局倾向。
 * 返回 { isWC, phase, lambdaMult, drawTendency, venue, factors[] };非世界杯 → {isWC:false, lambdaMult:1}。
 */
export function worldCupLambdaContext(fixture, date) {
  const competition = fixture?.competition ?? fixture?.league ?? "";
  if (!isWorldCup2026(competition, date ?? fixture?.date)) {
    return { isWC: false, lambdaMult: 1, factors: [] };
  }
  const phase = worldCupPhase(date ?? fixture?.date);
  const venue = worldCupVenue(fixture);
  const { mult: venueMult, factors: venueFactors } = venueLambdaMultiplier(venue);
  // 阶段对总量的轻微影响:淘汰赛更谨慎 → 进球略减(平局倾向另在软重校准里处理)。
  let phaseMult = 1;
  const factors = [...venueFactors];
  if (phase) {
    if (phase.drawTendency === "lowest") { phaseMult *= 0.96; factors.push(`${phase.phase_zh}·强强谨慎→进球↓4%`); }
    else if (phase.drawTendency === "lower") { phaseMult *= 0.98; factors.push(`${phase.phase_zh}·淘汰赛谨慎→进球↓2%`); }
    else if (phase.phase === "group") { factors.push("小组赛·开放"); }
  }
  return {
    isWC: true,
    phase: phase?.phase ?? null,
    phase_zh: phase?.phase_zh ?? null,
    drawTendency: phase?.drawTendency ?? null,
    intensity: phase?.intensity ?? 1,
    venue: venue ? { city: venue.city_zh ?? venue.city, stadium: venue.stadium, altitude_m: venue.altitude_m, temp: venue.june_july_avg_high_c, indoor: !!venue.indoor_climate_controlled } : null,
    lambdaMult: Number((venueMult * phaseMult).toFixed(4)),
    factors
  };
}

// ───────────────────────── 球队实力先验(48队 Elo/FIFA排名/夺冠赔率)─────────────────────────
let _teamCache = null;
function loadTeams() {
  if (_teamCache) return _teamCache;
  const p = join(join(getDataSubdir("world-cup"), "2026"), "team-priors.json");
  _teamCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { teams: {} };
  return _teamCache;
}

/** 取该队世界杯先验(中文/英文名均可),无则 null。 */
export function teamPrior(name) {
  if (!name) return null;
  const { teams } = loadTeams();
  if (teams[name]) return teams[name];
  const key = Object.keys(teams).find((k) => teams[k].en && teams[k].en.toLowerCase() === String(name).toLowerCase());
  return key ? teams[key] : null;
}

/**
 * Elo 胜平负先验(标准 Elo + 经验平局率分解)。世界杯多为中立场,homeAdv 默认 0。
 *  We = 1/(10^(-(dr)/400)+1) 为主队期望分;平局率按 |dr| 经验收缩(均势≈0.30、悬殊≈0.10)。
 *  home=We*(1-draw)、away=(1-We)*(1-draw)、draw=drawRate。和恒为 1、非负。**先验,待历史世界杯回测校准。**
 */
export function eloExpectation(homeElo, awayElo, homeAdv = 0) {
  const dr = Number(homeElo) - Number(awayElo) + Number(homeAdv || 0);
  if (!Number.isFinite(dr)) return null;
  const we = 1 / (Math.pow(10, -dr / 400) + 1);
  const drawRate = Math.min(0.30, Math.max(0.10, 0.30 - 0.00025 * Math.abs(dr)));
  const home = we * (1 - drawRate);
  const away = (1 - we) * (1 - drawRate);
  return { home: round4(home), draw: round4(drawRate), away: round4(away), eloDiff: Math.round(dr), homeWinExpectancy: round4(we) };
}

/**
 * 世界杯一场对阵的胜平负先验(用两队 Elo)。东道主(USA/CAN/MEX)在本国主场给小幅 homeAdv。
 * 返回 { probabilities:{home,draw,away}, eloDiff, source } 或 null(任一队无 Elo)。
 * 用途:世界杯冷启动队(无俱乐部 DC、赛前无竞彩赔率)的真实实力先验,接进 prediction-engine 的
 *   priorProbabilities 兜底(同 borrowed-prior 机制),让强弱差异化、避免 data-missing 整场放弃。
 */
export function worldCupMatchPrior(homeTeam, awayTeam, opts = {}) {
  const h = teamPrior(homeTeam);
  const a = teamPrior(awayTeam);
  if (!h?.elo || !a?.elo) return null;
  // 中立场默认无主场优势;东道主在本土给 +35 Elo(温和先验,待校准)。
  const HOSTS = new Set(["United States", "Canada", "Mexico"]);
  const homeAdv = opts.neutral === false ? 60 : (HOSTS.has(h.en) && opts.hostHome ? 35 : 0);
  const exp = eloExpectation(h.elo, a.elo, homeAdv);
  if (!exp) return null;
  return {
    probabilities: { home: exp.home, draw: exp.draw, away: exp.away },
    eloDiff: exp.eloDiff,
    homeAdv,
    source: `world-cup-elo-prior(${h.elo} vs ${a.elo})`
  };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

export function worldCupDataLoaded() {
  const { venuesDoc, groupsDoc, formatDoc } = load();
  const { teams } = loadTeams();
  return {
    venues: venuesDoc?.venues?.length ?? 0,
    groups: Object.keys(groupsDoc?.groups ?? {}).length,
    teams: Object.values(groupsDoc?.groups ?? {}).flat().length,
    phases: formatDoc?.phases?.length ?? 0,
    teamPriors: Object.keys(teams ?? {}).length
  };
}
