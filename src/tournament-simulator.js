/**
 * 通用锦标赛蒙特卡洛模拟引擎(对标 Opta 超算 ④层 — 纯工程、免费、不依赖买不到的数据)。
 *
 * 取代旧 run-worldcup-champion-sim.mjs 的三处随机近似硬伤:
 *   ① 小组同分用 Math.random()  → 改真 FIFA tiebreaker(积分→净胜球→进球→相互战绩→评级)
 *   ② 淘汰赛每轮 Math.random() 重新洗牌配对 → 改固定布拉克特(强度种子树,强队晚相遇)
 *   ③ 固定总进球 2.6、无加时 → 改阶段强度可变 λ + 90分钟→加时→点球三段
 *
 * 评级源可插拔(免费替代 Opta Power Rankings):
 *   - 国家队:world-cup-priors.teamPrior(t).elo(eloratings.net 免费)
 *   - 俱乐部:clubelo-loader(clubelo.com 免费 API)
 * 调用方只需传 ratingOf(team)->Elo 数字。引擎不关心评级怎么来。
 *
 * 可复现:内置 mulberry32 seeded PRNG,同 seed 同结果(Opta 风格确定性)。
 */
import { eloExpectation } from "./world-cup-priors.js";

/** mulberry32:32 位 seeded PRNG,返回 [0,1) — 用于可复现模拟(不用 Math.random)。 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 泊松抽样(Knuth),rng 为 ()->[0,1)。lambda 夹 [0.05, 6] 防极端。 */
export function poissonSample(lambda, rng) {
  const lam = Math.max(0.05, Math.min(6, Number(lambda) || 0));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/** seeded 标准正态(Box-Muller,用传入 rng,不用 Math.random)。 */
function normalSample(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** seeded Gamma(shape, scale=1)抽样 — Marsaglia & Tsang,用传入 rng。shape<1 用 boost。 */
function gammaSample(shape, rng) {
  if (shape < 1) return gammaSample(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normalSample(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * 负二项抽样(mean=μ, size=r → 过离散 var=μ+μ²/r),gamma-Poisson 混合实现:
 *   λ ~ Gamma(shape=r, scale=μ/r),k ~ Poisson(λ)。r 非正/∞ → 退化为纯泊松。
 * 与 dixon-coles-engine.nbPmf 同一参数化(国际赛 r≈8 已 leak-safe 验证,holdout 精确比分 logloss −0.03)。
 */
export function nbSample(mu, size, rng) {
  const m = Math.max(0.05, Math.min(6, Number(mu) || 0));
  if (!Number.isFinite(size) || size <= 0) return poissonSample(m, rng);
  const lam = gammaSample(size, rng) * (m / size);
  return poissonSample(lam, rng);
}

/**
 * 一场比赛抽样比分。用两队 Elo → 主胜期望 we → 按总进球 λtot 拆成主客 λ → 各自泊松。
 * @param {number} eloA @param {number} eloB
 * @param {object} ctx { lambdaTotal=2.6, homeAdv=0, intensity=1, rueSalvesen=0.15, nbSize, venueMult=1 }
 *   intensity=阶段强度(×λtot);rueSalvesen=γ 进球收缩(见下);
 *   nbSize=负二项过离散 size(有限正数→过离散抽样,与单场模型 NB_SIZE_SOFT 一致;缺省=纯泊松);
 *   venueMult=场地(海拔/气温)对总进球的乘子(默认 1=中性;逐场 venue 数据齐时由调用方传)。
 * @returns {{a:number,b:number,we:number}}
 */
export function sampleScoreline(eloA, eloB, ctx, rng) {
  const venueMult = Number.isFinite(ctx?.venueMult) ? ctx.venueMult : 1;
  const lamTot = (ctx?.lambdaTotal ?? 2.6) * (ctx?.intensity ?? 1) * venueMult;
  const exp = eloExpectation(eloA, eloB, ctx?.homeAdv ?? 0);
  const we = exp ? exp.homeWinExpectancy : 0.5;
  // 进球期望随实力差轻微放大领先方(避免强弱差全被平均化);保持总量≈lamTot。
  let la = lamTot * we;
  let lb = lamTot * (1 - we);
  // Rue-Salvesen γ 收缩(2026-06-03 接入,49k 国际赛 leak-safe 回测验证):
  //   we 是胜率非进球比,线性拆分过度放大领先方 λ;按 (1−γ) 压缩两队 log-λ 之差,
  //   几何均值(总进球)不变。holdout WLD logloss -0.0131、比分 -0.0015(均改善)。γ=0 关闭。
  const gamma = ctx?.rueSalvesen ?? 0.15;
  if (gamma && la > 0 && lb > 0) {
    const dlt = (Math.log(la) - Math.log(lb)) / 2;
    la = Math.exp(Math.log(la) - gamma * dlt);
    lb = Math.exp(Math.log(lb) + gamma * dlt);
  }
  // 比分分布与单场世界杯模型统一:国际赛进球过离散用负二项(nbSize),否则纯泊松。
  //   "大融合"核心 — 超算每场比分不再各算各的,与 prediction-engine 同一 NB(8) 分布(2026-06-04)。
  const nb = ctx?.nbSize;
  return { a: nbSample(la, nb, rng), b: nbSample(lb, nb, rng), we };
}

/**
 * 小组循环赛排名 — 真 FIFA tiebreaker。
 * 顺序:积分 → 净胜球 → 进球数 → 相互战绩(子联赛积分→净胜球→进球) → 评级(eloOf) 兜底(非随机)。
 * @param {string[]} teams
 * @param {Array<{home,away,ga,gb}>} matches 本组已抽样的全部对阵结果
 * @param {(t:string)=>number} eloOf 最终确定性兜底(取代旧 Math.random)
 * @returns {string[]} 名次从高到低
 */
export function rankGroup(teams, matches, eloOf) {
  const pts = {}, gd = {}, gf = {};
  for (const t of teams) { pts[t] = 0; gd[t] = 0; gf[t] = 0; }
  for (const m of matches) {
    if (m.ga > m.gb) pts[m.home] += 3; else if (m.ga < m.gb) pts[m.away] += 3; else { pts[m.home]++; pts[m.away]++; }
    gd[m.home] += m.ga - m.gb; gd[m.away] += m.gb - m.ga;
    gf[m.home] += m.ga; gf[m.away] += m.gb;
  }
  // 相互战绩(仅在并列子集内计算)
  const h2h = (subset) => {
    const sp = {}, sgd = {}, sgf = {};
    for (const t of subset) { sp[t] = 0; sgd[t] = 0; sgf[t] = 0; }
    for (const m of matches) {
      if (!subset.includes(m.home) || !subset.includes(m.away)) continue;
      if (m.ga > m.gb) sp[m.home] += 3; else if (m.ga < m.gb) sp[m.away] += 3; else { sp[m.home]++; sp[m.away]++; }
      sgd[m.home] += m.ga - m.gb; sgd[m.away] += m.gb - m.ga;
      sgf[m.home] += m.ga; sgf[m.away] += m.gb;
    }
    return { sp, sgd, sgf };
  };
  return [...teams].sort((x, y) => {
    if (pts[y] !== pts[x]) return pts[y] - pts[x];
    if (gd[y] !== gd[x]) return gd[y] - gd[x];
    if (gf[y] !== gf[x]) return gf[y] - gf[x];
    // 并列:相互战绩(找出与 x,y 同分的整个并列集)
    const tied = teams.filter((t) => pts[t] === pts[x] && gd[t] === gd[x] && gf[t] === gf[x]);
    if (tied.length >= 2) {
      const { sp, sgd, sgf } = h2h(tied);
      if (sp[y] !== sp[x]) return sp[y] - sp[x];
      if (sgd[y] !== sgd[x]) return sgd[y] - sgd[x];
      if (sgf[y] !== sgf[x]) return sgf[y] - sgf[x];
    }
    return (eloOf(y) || 0) - (eloOf(x) || 0); // 确定性兜底:抽签位置以评级代替(非随机)
  });
}

/**
 * 小组赛阶段:遍历每组循环赛 → 排名 → 取每组前2(直接出线)+ 各组第3(竞争 8 张最佳第三)。
 * @returns {{ winners, runners, thirdsRanked, advancers(32), standings }}
 */
export function simulateGroupStage(groups, eloOf, rng, opts = {}) {
  const ctx = {
    lambdaTotal: opts.lambdaTotal ?? 2.6,
    intensity: opts.groupIntensity ?? 1,
    nbSize: opts.nbSize,
    rueSalvesen: opts.rueSalvesen,
    venueMult: opts.venueMult
  };
  const hosts = opts.hosts instanceof Set ? opts.hosts : new Set(opts.hosts ?? []);
  const hostAdv = opts.hostAdv ?? 35;
  const winners = [], runners = [], thirds = [];
  const standings = {};
  for (const [g, teams] of Object.entries(groups)) {
    const matches = [];
    // 逐场场地乘子(海拔/气温):opts.groupVenueMults[组]=该组6场 venueMult(赛号序);缺省退 ctx.venueMult。
    const gvm = opts.groupVenueMults?.[g];
    let pairIdx = 0;
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const A = teams[i], B = teams[j];
        let ha = 0; if (hosts.has(A)) ha += hostAdv; if (hosts.has(B)) ha -= hostAdv;
        const vm = gvm ? gvm[pairIdx++] : ctx.venueMult;
        const { a, b } = sampleScoreline(eloOf(A), eloOf(B), { ...ctx, homeAdv: ha, venueMult: vm }, rng);
        matches.push({ home: A, away: B, ga: a, gb: b });
      }
    }
    const ranked = rankGroup(teams, matches, eloOf);
    standings[g] = ranked;
    winners.push({ team: ranked[0], group: g, seedRank: 1 });
    runners.push({ team: ranked[1], group: g, seedRank: 2 });
    // 第3名带其积分/净胜球/进球用于最佳第三排序
    const pts = {}, gd = {}, gf = {};
    for (const t of teams) { pts[t] = 0; gd[t] = 0; gf[t] = 0; }
    for (const m of matches) {
      if (m.ga > m.gb) pts[m.home] += 3; else if (m.ga < m.gb) pts[m.away] += 3; else { pts[m.home]++; pts[m.away]++; }
      gd[m.home] += m.ga - m.gb; gd[m.away] += m.gb - m.ga; gf[m.home] += m.ga; gf[m.away] += m.gb;
    }
    const t3 = ranked[2];
    thirds.push({ team: t3, group: g, pts: pts[t3], gd: gd[t3], gf: gf[t3] });
  }
  // 最佳 8 个第三:积分→净胜球→进球→评级
  const thirdsRanked = [...thirds].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || (eloOf(b.team) || 0) - (eloOf(a.team) || 0));
  const bestThirds = thirdsRanked.slice(0, 8);
  const advancers = [...winners, ...runners, ...bestThirds.map((x) => ({ team: x.team, group: x.group, seedRank: 3 }))];
  return { winners, runners, thirdsRanked, bestThirds, advancers, standings };
}

/**
 * 强度种子布拉克特:把 32 支出线队按 Elo 排名 1..32,放进标准单淘汰树(1v32,16v17… 同八区),
 * 使强队尽量晚相遇。返回固定的对阵树(数组,长度 32 = 16 场 R32)。
 * ⚠️ 非 FIFA 官方位次(2026 官方 R32 第三名分配表 495 组合,待 bracket.json 覆盖);
 *    但比"每轮随机重洗"严谨得多(强队不会 R32 就内战)。
 */
export function seedBracket(advancers, eloOf) {
  const sorted = [...advancers].sort((a, b) => (eloOf(b.team) || 0) - (eloOf(a.team) || 0));
  const n = sorted.length; // 32
  // 标准种子顺序:生成长度 n 的种子位序(1, n, n/2+1 ... 蛇形),保证 1 号与 2 号在两个半区
  const order = standardSeedOrder(n); // [seedIndex...] 0-based 指向 sorted
  return order.map((idx) => sorted[idx]);
}

/** 标准单淘汰种子位序(n 为 2 的幂)。返回 0-based 种子下标数组,使 1v(n)、按区分布。 */
export function standardSeedOrder(n) {
  let rounds = [[1, 2]];
  while (rounds[0].length < n) {
    const next = [];
    const m = rounds[0].length * 2 + 1;
    for (const s of rounds[0]) { next.push(s); next.push(m - s); }
    rounds = [next];
  }
  return rounds[0].map((s) => s - 1);
}

/**
 * 淘汰赛单场:90 分钟泊松 → 平局走加时(额外 ~30 分钟 λ)→ 仍平走点球(默认 50/50,有据)。
 * @returns {{winner, loser, decided:'reg'|'aet'|'pens'}}
 */
export function simulateKnockoutMatch(teamA, teamB, ctx, rng, eloOf) {
  let ha = 0;
  if (ctx?.hosts?.has(teamA)) ha += ctx.hostAdv ?? 35;
  if (ctx?.hosts?.has(teamB)) ha -= ctx.hostAdv ?? 35;
  const base = { lambdaTotal: ctx?.lambdaTotal ?? 2.6, intensity: ctx?.intensity ?? 1, homeAdv: ha, nbSize: ctx?.nbSize, rueSalvesen: ctx?.rueSalvesen, venueMult: ctx?.venueMult };
  let { a, b } = sampleScoreline(eloOf(teamA), eloOf(teamB), base, rng);
  if (a > b) return { winner: teamA, loser: teamB, decided: "reg" };
  if (b > a) return { winner: teamB, loser: teamA, decided: "reg" };
  // 加时:约 1/3 场时长
  const aet = { ...base, intensity: (ctx?.intensity ?? 1) / 3 };
  const e = sampleScoreline(eloOf(teamA), eloOf(teamB), aet, rng);
  if (e.a > e.b) return { winner: teamA, loser: teamB, decided: "aet" };
  if (e.b > e.a) return { winner: teamB, loser: teamA, decided: "aet" };
  // 点球:学界结论≈50/50(可配 penTilt 给强队极小倾斜,默认 0=纯 50/50)
  const tilt = ctx?.penTilt ?? 0;
  const we = eloExpectation(eloOf(teamA), eloOf(teamB), ha)?.homeWinExpectancy ?? 0.5;
  const pA = 0.5 + tilt * (we - 0.5);
  return rng() < pA
    ? { winner: teamA, loser: teamB, decided: "pens" }
    : { winner: teamB, loser: teamA, decided: "pens" };
}

/**
 * 官方对阵路径:用 bracket.json(FIFA 真实 R32 位次 + 第三名 495 分配表 + 赛号树)跑淘汰赛。
 * 与强度种子树的区别:R32 胜者/亚军位次官方固定、第三名按出线8组组合查官方表、R16+ 按赛号树推进
 * (非相邻折叠),且天然无同组 R32 重赛。
 * @returns {{champion, stageReached:{team:stage}}}
 */
export function simulateTournamentOfficial(config, rng) {
  const { groups, eloOf, bracket } = config;
  const hosts = config.hosts instanceof Set ? config.hosts : new Set(config.hosts ?? []);
  // 默认进球强度=实证校准(analyze-wc-stage-goals.mjs,448 场世界杯:淘汰赛≈小组赛,非更高)。旧默认 1.18–1.28 无据已弃。
  const phaseInt = config.phaseIntensity ?? { r32: 0.96, r16: 0.96, qf: 0.96, sf: 0.96, final: 0.96 };
  const stageReached = {};
  for (const teams of Object.values(groups)) for (const t of teams) stageReached[t] = "group";

  const gs = simulateGroupStage(groups, eloOf, rng, {
    lambdaTotal: config.lambdaTotal, groupIntensity: 1, hosts, hostAdv: config.hostAdv,
    nbSize: config.nbSize, rueSalvesen: config.rueSalvesen, venueMult: config.venueMult,
    groupVenueMults: config.groupVenueMults,
  });
  for (const a of gs.advancers) stageReached[a.team] = "r32";

  // 按组建 1X/2X/3X 映射
  const winnerByGroup = {}, runnerByGroup = {}, thirdByGroup = {};
  for (const w of gs.winners) winnerByGroup[w.group] = w.team;
  for (const r of gs.runners) runnerByGroup[r.group] = r.team;
  for (const t of gs.bestThirds) thirdByGroup[t.group] = t.team;
  const key = gs.bestThirds.map((t) => t.group).sort().join(",");
  const assign = bracket.thirdPlaceTable?.[key];
  if (!assign) return simulateTournamentSeeded(config, rng); // 安全兜底(理论上495组合全覆盖,不应触发)

  const resolve = (slot) => {
    if (slot[0] === "1") return winnerByGroup[slot[1]];
    if (slot[0] === "2") return runnerByGroup[slot[1]];
    if (slot.startsWith("T@")) { const g = assign[slot.slice(2)]; return g ? thirdByGroup[g] : undefined; }
    return undefined;
  };
  const koCtx = (intensity, venueMult) => ({ hosts, hostAdv: config.hostAdv, lambdaTotal: config.lambdaTotal, intensity, penTilt: config.penTilt, nbSize: config.nbSize, rueSalvesen: config.rueSalvesen, venueMult: venueMult ?? config.venueMult });
  // 淘汰赛逐场场地乘子:config.koVenueMult[赛号]=该场 venueMult(官方赛号→城市,仅官方对阵表路径有真实赛号)。
  const vmOf = (m) => config.koVenueMult?.[m];
  const mw = {}; // 赛号 -> 胜者

  for (const mt of bracket.r32) {
    const res = simulateKnockoutMatch(resolve(mt.home), resolve(mt.away), koCtx(phaseInt.r32, vmOf(mt.m)), rng, eloOf);
    mw[mt.m] = res.winner; stageReached[res.winner] = "r16";
  }
  const playRound = (matches, intensity, reach) => {
    for (const mt of matches) {
      const res = simulateKnockoutMatch(mw[mt.from[0]], mw[mt.from[1]], koCtx(intensity, vmOf(mt.m)), rng, eloOf);
      mw[mt.m] = res.winner; stageReached[res.winner] = reach;
    }
  };
  playRound(bracket.r16, phaseInt.r16, "qf");
  playRound(bracket.qf, phaseInt.qf, "sf");
  playRound(bracket.sf, phaseInt.sf, "final");
  playRound([bracket.final], phaseInt.final, "champion");
  return { champion: mw[bracket.final.m], stageReached };
}

/**
 * 跑一届完整锦标赛(小组→R32→…→决赛)。config.bracket 存在→走官方对阵表,否则→强度种子树。
 * @returns {{champion, stageReached:{team:stage}}}
 */
export function simulateTournament(config, rng) {
  if (config.bracket) return simulateTournamentOfficial(config, rng);
  return simulateTournamentSeeded(config, rng);
}

function simulateTournamentSeeded(config, rng) {
  const { groups, eloOf } = config;
  const hosts = config.hosts instanceof Set ? config.hosts : new Set(config.hosts ?? []);
  // 默认进球强度=实证校准(analyze-wc-stage-goals.mjs,448 场世界杯:淘汰赛≈小组赛,非更高)。旧默认 1.18–1.28 无据已弃。
  const phaseInt = config.phaseIntensity ?? { r32: 0.96, r16: 0.96, qf: 0.96, sf: 0.96, final: 0.96 };
  const stageReached = {};
  for (const teams of Object.values(groups)) for (const t of teams) stageReached[t] = "group";

  const gs = simulateGroupStage(groups, eloOf, rng, {
    lambdaTotal: config.lambdaTotal, groupIntensity: 1, hosts, hostAdv: config.hostAdv,
    nbSize: config.nbSize, rueSalvesen: config.rueSalvesen, venueMult: config.venueMult,
    groupVenueMults: config.groupVenueMults,
  });
  for (const a of gs.advancers) stageReached[a.team] = "r32";

  let bracket = seedBracket(gs.advancers, eloOf); // length 32
  const koCtx = (intensity, venueMult) => ({ hosts, hostAdv: config.hostAdv, lambdaTotal: config.lambdaTotal, intensity, penTilt: config.penTilt, nbSize: config.nbSize, rueSalvesen: config.rueSalvesen, venueMult: venueMult ?? config.venueMult });
  // 淘汰赛逐场场地乘子:config.koVenueMult[赛号]=该场 venueMult(官方赛号→城市,仅官方对阵表路径有真实赛号)。
  const vmOf = (m) => config.koVenueMult?.[m];
  const stages = [["r16", phaseInt.r32], ["qf", phaseInt.r16], ["sf", phaseInt.qf], ["final", phaseInt.sf], ["champion", phaseInt.final]];
  let round = bracket.map((x) => x.team);
  for (const [nextStage, intensity] of stages) {
    const winners = [];
    for (let i = 0; i < round.length; i += 2) {
      const res = simulateKnockoutMatch(round[i], round[i + 1], koCtx(intensity), rng, eloOf);
      winners.push(res.winner);
    }
    for (const w of winners) stageReached[w] = nextStage;
    round = winners;
    if (round.length === 1) break;
  }
  const champion = round[0];
  return { champion, stageReached };
}

/**
 * 蒙特卡洛 N 次 → 每队各阶段到达概率。
 * @param {object} config { groups, eloOf, hosts, lambdaTotal, hostAdv, penTilt, phaseIntensity }
 * @param {number} N @param {number} seed
 * @returns {{n, teams:[{team, advance, r16, qf, sf, final, champion}], audit}}
 */
export function runMonteCarlo(config, N = 20000, seed = 20260611) {
  const rng = mulberry32(seed);
  const STAGES = ["r32", "r16", "qf", "sf", "final", "champion"];
  const rank = { group: 0, r32: 1, r16: 2, qf: 3, sf: 4, final: 5, champion: 6 };
  const tally = {};
  for (const teams of Object.values(config.groups)) for (const t of teams) {
    tally[t] = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0 };
  }
  for (let s = 0; s < N; s++) {
    const { stageReached } = simulateTournament(config, rng);
    for (const [t, st] of Object.entries(stageReached)) {
      const r = rank[st];
      for (const stage of STAGES) if (r >= rank[stage]) tally[t][stage]++;
    }
  }
  const teams = Object.entries(tally).map(([team, c]) => ({
    team,
    advance: c.r32 / N, r16: c.r16 / N, qf: c.qf / N, sf: c.sf / N, final: c.final / N, champion: c.champion / N,
  })).sort((a, b) => b.champion - a.champion || b.final - a.final);
  // 审计:夺冠概率和≈1、出线和≈32、各队单调(champion≤final≤…≤advance)
  const champSum = teams.reduce((s, t) => s + t.champion, 0);
  const advSum = teams.reduce((s, t) => s + t.advance, 0);
  const monotonic = teams.every((t) => t.champion <= t.final + 1e-9 && t.final <= t.sf + 1e-9 && t.sf <= t.qf + 1e-9 && t.qf <= t.r16 + 1e-9 && t.r16 <= t.advance + 1e-9);
  return { n: N, seed, teams, audit: { champSum, advSum, monotonic, ok: Math.abs(champSum - 1) < 0.02 && Math.abs(advSum - 32) < 0.5 && monotonic } };
}
