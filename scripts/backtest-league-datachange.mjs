/**
 * 每联赛数据变化指纹 leak-safe walk-forward 回测(2026-05-31)
 * ──────────────────────────────────────────────────────────────────────────
 * 用户决定"先回测验证再驱动概率"。本脚本检验:把每联赛指纹(向全局收缩)接进预测,
 * 在赛前可知的市场上(大小球 over / 热门让球过盘 / 平局)是否真增益,过测才采信驱动。
 *
 * 严格 leak-safe:按赛季滚动,测季 S 只用"早于 S 的赛季"训练指纹(含同样的 w=n/(n+K) 收缩)。
 *
 * 三臂对比(每个市场):
 *   market = 开盘市场隐含(去vig,赛前可知的基准,公认最难超)
 *   global = 全局先验(大模型一刀切)
 *   league = 联赛收缩先验(本框架基础层)
 * 指标:Brier(越低越好)+ 命中率。只报赛前可驱动的市场。
 * 另:1X2 开→收漂移"泄漏感知上限"单列(收盘价开赛才知=不可生产驱动,仅看天花板)。
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";

const SEASONS_ALL = ["2122", "2223", "2324", "2425", "2526"]; // 由旧到新
const K = 300;

const rate = (n, d) => (d > 0 ? n / d : null);
const favKey = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw");
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const isOver = (m) => m.homeGoals + m.awayGoals > 2.5;
function favCovers(m) {
  const line = Number(m.asian?.lineClose ?? m.asian?.line);
  if (!Number.isFinite(line)) return null;
  const favAdj = (line < 0 ? 1 : -1) * (m.homeGoals - m.awayGoals + line);
  if (Math.abs(favAdj) < 1e-9) return null; // 走盘不计入命中分母
  return favAdj > 0 ? 1 : 0;
}

// 从一批比赛建"联赛→{overRate,coverRate,drawRate}"+全局,带收缩
function buildPriors(matches) {
  const g = { over: [0, 0], cover: [0, 0], draw: [0, 0] };
  const per = {};
  for (const m of matches) {
    if (m.homeGoals == null) continue;
    const L = (per[m.league] ??= { over: [0, 0], cover: [0, 0], draw: [0, 0] });
    g.over[1]++; L.over[1]++; if (isOver(m)) { g.over[0]++; L.over[0]++; }
    if (outcome(m) === "draw") { g.draw[0]++; L.draw[0]++; } g.draw[1]++; L.draw[1]++;
    const c = favCovers(m);
    if (c != null) { g.cover[1]++; L.cover[1]++; if (c) { g.cover[0]++; L.cover[0]++; } }
  }
  const gr = { over: rate(...g.over), cover: rate(...g.cover), draw: rate(...g.draw) };
  const shrunk = (L, key) => {
    const n = L[key][1], lr = rate(...L[key]);
    if (lr == null) return gr[key];
    const w = n / (n + K);
    return w * lr + (1 - w) * gr[key];
  };
  return {
    global: gr,
    league(code) {
      const L = per[code];
      if (!L) return gr;
      return { over: shrunk(L, "over"), cover: shrunk(L, "cover"), draw: shrunk(L, "draw") };
    },
  };
}

const brier = (p, y) => (p - y) ** 2;

async function main() {
  console.log(`[bt] 加载 ${ALL_LEAGUES.length} 联赛 × ${SEASONS_ALL.length} 赛季…`);
  const bySeason = {};
  for (const s of SEASONS_ALL) {
    const { matches } = await loadFootballDataMatches({ leagues: ALL_LEAGUES, seasons: [s] });
    bySeason[s] = matches;
    console.log(`  ${s}: ${matches.length} 场`);
  }

  // 累计器:每市场每臂 {brierSum, n, hit, hitN}
  const mk = () => ({ market: blank(), global: blank(), league: blank() });
  function blank() { return { bs: 0, n: 0, hit: 0, hn: 0 }; }
  const acc = { over: mk(), cover: mk() };
  const driftUB = { steamN: 0, steamFavWin: 0, driftN: 0, driftFavWin: 0 }; // 泄漏上限参考

  // 滚动:测 idx>=1 的赛季,训练=之前所有赛季
  for (let i = 1; i < SEASONS_ALL.length; i++) {
    const train = SEASONS_ALL.slice(0, i).flatMap((s) => bySeason[s]);
    const test = bySeason[SEASONS_ALL[i]];
    const priors = buildPriors(train);

    for (const m of test) {
      if (m.homeGoals == null) continue;
      const lp = priors.league(m.league);
      // ── 大小球 over 2.5 ──
      const yOver = isOver(m) ? 1 : 0;
      if (Number.isFinite(m.overProb)) { // 市场开盘 over 概率
        acc.over.market.bs += brier(m.overProb, yOver); acc.over.market.n++;
        acc.over.market.hn++; if ((m.overProb >= 0.5 ? 1 : 0) === yOver) acc.over.market.hit++;
      }
      if (priors.global.over != null) {
        acc.over.global.bs += brier(priors.global.over, yOver); acc.over.global.n++;
        acc.over.global.hn++; if ((priors.global.over >= 0.5 ? 1 : 0) === yOver) acc.over.global.hit++;
      }
      if (lp.over != null) {
        acc.over.league.bs += brier(lp.over, yOver); acc.over.league.n++;
        acc.over.league.hn++; if ((lp.over >= 0.5 ? 1 : 0) === yOver) acc.over.league.hit++;
      }
      // ── 热门让球过盘 ──
      const yCov = favCovers(m);
      if (yCov != null) {
        // market 臂:用收盘亚盘水位去vig的热门覆盖隐含(赛前可知用开盘水位)
        const a = m.asian;
        const homeFav = Number(a?.lineClose ?? a?.line) < 0;
        const hw = a?.homeWater, aw = a?.awayWater;
        let mCov = null;
        if (Number.isFinite(hw) && Number.isFinite(aw) && hw > 1 && aw > 1) {
          const ih = 1 / hw, ia = 1 / aw; const favImp = (homeFav ? ih : ia) / (ih + ia);
          mCov = favImp;
        }
        if (mCov != null) { acc.cover.market.bs += brier(mCov, yCov); acc.cover.market.n++; acc.cover.market.hn++; if ((mCov >= 0.5 ? 1 : 0) === yCov) acc.cover.market.hit++; }
        acc.cover.global.bs += brier(priors.global.cover, yCov); acc.cover.global.n++; acc.cover.global.hn++; if ((priors.global.cover >= 0.5 ? 1 : 0) === yCov) acc.cover.global.hit++;
        acc.cover.league.bs += brier(lp.cover, yCov); acc.cover.league.n++; acc.cover.league.hn++; if ((lp.cover >= 0.5 ? 1 : 0) === yCov) acc.cover.league.hit++;
      }
      // ── 1X2 漂移泄漏上限(仅参考)──
      if (m.odds && m.oddsClose) {
        const fav = favKey(m.odds); const d = m.oddsClose[fav] - m.odds[fav]; const won = outcome(m) === fav;
        if (d > 0.02) { driftUB.steamN++; if (won) driftUB.steamFavWin++; }
        else if (d < -0.02) { driftUB.driftN++; if (won) driftUB.driftFavWin++; }
      }
    }
  }

  const r3 = (x) => (x == null ? "—" : Math.round(x * 10000) / 10000);
  const r1 = (x) => (x == null ? "—" : Math.round(x * 1000) / 10);
  const line = (label, arm) => `  ${label.padEnd(8)} Brier ${r3(arm.bs / arm.n)}  命中 ${r1(rate(arm.hit, arm.hn))}%  (n=${arm.n})`;

  console.log("\n===== leak-safe walk-forward(测 2223/2324/2425/2526,训练=各自之前赛季)=====");
  console.log("【大小球 over2.5】(市场=开盘over赔, 越低Brier越好)");
  console.log(line("market", acc.over.market));
  console.log(line("global", acc.over.global));
  console.log(line("league", acc.over.league));
  console.log("\n【热门让球过盘】(market=开盘水位隐含覆盖)");
  console.log(line("market", acc.cover.market));
  console.log(line("global", acc.cover.global));
  console.log(line("league", acc.cover.league));

  console.log("\n【1X2 开→收漂移·泄漏感知上限(收盘开赛才知,不可生产驱动,仅看天花板)】");
  console.log(`  被加注热门胜率 ${r1(rate(driftUB.steamFavWin, driftUB.steamN))}% (n=${driftUB.steamN}) vs 退烧 ${r1(rate(driftUB.driftFavWin, driftUB.driftN))}% (n=${driftUB.driftN})`);

  // 裁决
  const verdict = (m, label) => {
    const gB = m.global.bs / m.global.n, lB = m.league.bs / m.league.n, mB = m.market.n ? m.market.bs / m.market.n : Infinity;
    const leagueBeatsGlobal = lB < gB - 1e-4;
    const leagueBeatsMarket = lB < mB - 1e-4;
    console.log(`  ${label}: league ${leagueBeatsGlobal ? "优于" : "未优于"} global(ΔBrier ${r3(lB - gB)});league ${leagueBeatsMarket ? "优于" : "未优于"} market(ΔBrier ${r3(lB - mB)})`);
    return { leagueBeatsGlobal, leagueBeatsMarket };
  };
  console.log("\n===== 裁决(过测=league 至少优于 global 才值得驱动该市场)=====");
  verdict(acc.over, "大小球");
  verdict(acc.cover, "让球过盘");
}

main().catch((e) => { console.error("[bt] 失败:", e.message); process.exit(1); });
