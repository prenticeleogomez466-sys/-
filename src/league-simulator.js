/**
 * 联赛赛季蒙特卡洛模拟引擎(对标 Opta 超算的另一招牌:整季 → 夺冠/欧战/降级概率)。
 *
 * 复用 tournament-simulator 的比分抽样原语(sampleScoreline / poissonSample / mulberry32)。
 * 评级源可插拔(免费替代 Opta Power Rankings):俱乐部用 ClubElo(clubelo.com 免费 API)。
 * 支持两种模式:
 *   - 赛季前(preseason):无 currentTable/fixtures → 自动生成双循环全赛程从 0 跑
 *   - 赛季中(midseason):传 currentTable(已有积分/净胜球/进球)+ remainingFixtures(剩余对阵)→ 只跑剩余
 *
 * 产出:每队 P(夺冠) / P(前N=欧冠区) / P(欧战区) / P(降级) + 平均积分 + 平均名次。
 */
import { sampleScoreline, mulberry32 } from "./tournament-simulator.js";

/** 生成双循环全赛程(每对各主客一次)。 */
export function generateDoubleRoundRobin(teams) {
  const fixtures = [];
  for (const h of teams) for (const a of teams) if (h !== a) fixtures.push({ home: h, away: a });
  return fixtures;
}

/**
 * 模拟一个赛季 → 最终积分榜(名次从高到低)。
 * @param {string[]} teams 球队名
 * @param {(t:string)=>number} eloOf 评级
 * @param {object} opts { fixtures?, currentTable?{team:{pts,gd,gf}}, homeAdv=65, lambdaTotal=2.7 }
 * @param {()=>number} rng
 * @returns {Array<{team,pts,gd,gf}>} 排序后积分榜
 */
export function simulateLeagueSeason(teams, eloOf, opts, rng) {
  const homeAdv = opts?.homeAdv ?? 65;
  const lambdaTotal = opts?.lambdaTotal ?? 2.7;
  const fixtures = opts?.fixtures ?? generateDoubleRoundRobin(teams);
  const pts = {}, gd = {}, gf = {};
  for (const t of teams) {
    const cur = opts?.currentTable?.[t];
    pts[t] = cur?.pts ?? 0; gd[t] = cur?.gd ?? 0; gf[t] = cur?.gf ?? 0;
  }
  for (const fx of fixtures) {
    const { a, b } = sampleScoreline(eloOf(fx.home), eloOf(fx.away), { lambdaTotal, homeAdv }, rng);
    if (a > b) pts[fx.home] += 3; else if (a < b) pts[fx.away] += 3; else { pts[fx.home]++; pts[fx.away]++; }
    gd[fx.home] += a - b; gd[fx.away] += b - a; gf[fx.home] += a; gf[fx.away] += b;
  }
  // 排名:积分→净胜球→进球→评级兜底(确定性,非随机)。各联赛细则不同(相互战绩等),概率层用主导规则足够。
  return [...teams]
    .map((t) => ({ team: t, pts: pts[t], gd: gd[t], gf: gf[t] }))
    .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || (eloOf(y.team) || 0) - (eloOf(x.team) || 0));
}

/**
 * 蒙特卡洛 N 次 → 每队各结局概率。
 * @param {object} opts 透传 simulateLeagueSeason 的 opts,外加:
 *        euroSpots=4(欧冠区,前N) | europaCut=6(欧战区,前M) | relegationSpots=3(降级,后K)
 * @returns {{n, teams:[{team,elo,champion,euroUcl,euro,relegation,avgPts,avgRank}], audit}}
 */
export function runLeagueMonteCarlo(teams, eloOf, opts = {}, N = 10000, seed = 20260801) {
  const rng = mulberry32(seed);
  const euroSpots = opts.euroSpots ?? 4;
  const europaCut = opts.europaCut ?? 6;
  const relegationSpots = opts.relegationSpots ?? 3;
  const T = teams.length;
  const tally = {};
  for (const t of teams) tally[t] = { champion: 0, euroUcl: 0, euro: 0, relegation: 0, sumPts: 0, sumRank: 0 };
  for (let s = 0; s < N; s++) {
    const table = simulateLeagueSeason(teams, eloOf, opts, rng);
    for (let rank = 0; rank < table.length; rank++) {
      const row = table[rank];
      const ta = tally[row.team];
      if (rank === 0) ta.champion++;
      if (rank < euroSpots) ta.euroUcl++;
      if (rank < europaCut) ta.euro++;
      if (rank >= T - relegationSpots) ta.relegation++;
      ta.sumPts += row.pts; ta.sumRank += rank + 1;
    }
  }
  const rows = teams.map((t) => ({
    team: t, elo: eloOf(t),
    champion: tally[t].champion / N,
    euroUcl: tally[t].euroUcl / N,
    euro: tally[t].euro / N,
    relegation: tally[t].relegation / N,
    avgPts: tally[t].sumPts / N,
    avgRank: tally[t].sumRank / N,
  })).sort((a, b) => a.avgRank - b.avgRank);
  // 审计:夺冠和≈1、欧冠区和≈euroSpots、降级和≈relegationSpots
  const champSum = rows.reduce((s, r) => s + r.champion, 0);
  const uclSum = rows.reduce((s, r) => s + r.euroUcl, 0);
  const relSum = rows.reduce((s, r) => s + r.relegation, 0);
  const ok = Math.abs(champSum - 1) < 0.02 && Math.abs(uclSum - euroSpots) < 0.5 && Math.abs(relSum - relegationSpots) < 0.5;
  return { n: N, seed, teams: rows, audit: { champSum, uclSum, relSum, euroSpots, relegationSpots, ok } };
}
