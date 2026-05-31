/**
 * 每联赛「数据变化」指纹 + 向全局收缩 = 独立小模型框架基础(2026-05-31)
 * ──────────────────────────────────────────────────────────────────────────
 * 用户:"把所有比赛包含进去,尤其近五年,作为独立小模型的框架基础"。
 *
 * 定位(诚实):
 *  - 球队强度已证必须全局一起学(project_league_expert_mixture:独立全面学反而更差),不重走。
 *  - 本脚本补的是 mixture 没有的一维 —— 每联赛**市场变化(开→收)→结果**的行为指纹,
 *    且沿用 mixture 的分层收缩(w=n/(n+K) 向全局收),小联赛不过拟合。
 *  - 行为基础层(胜平负/平局/进球/比分,含无赔率的 30 联赛)由 experience-library 覆盖,
 *    本层 = 18 个带开盘+收盘赔率的联赛的"市场效率/漂移→结果"指纹。两层合起来=小模型框架基础。
 *
 * 数据:football-data.co.uk 18 联赛 × 5 赛季(2122-2526)。
 * 产物:data-change-league-profile.json(供生产/展示读)+ 桌面 xlsx。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFootballDataMatches, ALL_LEAGUES, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { getExportDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SEASONS = (getArg("seasons", "2526,2425,2324,2223,2122")).split(",");
const K = Number(getArg("k", 300)); // 收缩强度:n=K 时一半信本联赛、一半信全局

const rate = (n, d) => (d > 0 ? n / d : null);
const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
const favKey = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw");
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");

// 热门是否覆盖收盘让球线(line 主队视角,负=主让)
function favCovers(m) {
  const line = Number(m.asian?.lineClose ?? m.asian?.line);
  if (!Number.isFinite(line)) return null;
  const favAdj = (line < 0 ? 1 : -1) * (m.homeGoals - m.awayGoals + line);
  if (Math.abs(favAdj) < 1e-9) return "push";
  return favAdj > 0 ? "cover" : "no-cover";
}

function newAcc() {
  return {
    n: 0, favWin: 0, draw: 0, over25: 0,
    steamN: 0, steamFavWin: 0, driftN: 0, driftFavWin: 0,   // 1X2 被加注 vs 退烧
    ouUpN: 0, ouUpOver: 0, ouDownN: 0, ouDownOver: 0,        // 大小球升/降盘
    coverN: 0, coverHit: 0,                                   // 热门过盘
  };
}

function tally(a, m) {
  if (m.homeGoals == null || m.awayGoals == null) return;
  const out = outcome(m);
  if (m.odds) {
    a.n++;
    const fav = favKey(m.odds);
    if (out === fav) a.favWin++;
    if (out === "draw") a.draw++;
    if (m.homeGoals + m.awayGoals > 2.5) a.over25++;
    if (m.oddsClose) {
      const d = m.oddsClose[fav] - m.odds[fav];
      if (d > 0.02) { a.steamN++; if (out === fav) a.steamFavWin++; }
      else if (d < -0.02) { a.driftN++; if (out === fav) a.driftFavWin++; }
    }
  }
  if (Number.isFinite(m.overProb) && Number.isFinite(m.overProbClose)) {
    const d = m.overProbClose - m.overProb;
    const over = m.homeGoals + m.awayGoals > 2.5;
    if (d > 0.02) { a.ouUpN++; if (over) a.ouUpOver++; }
    else if (d < -0.02) { a.ouDownN++; if (over) a.ouDownOver++; }
  }
  const cov = favCovers(m);
  if (cov) { a.coverN++; if (cov === "cover") a.coverHit++; }
}

// 从累加器提取原始指纹(未收缩)
function rawFingerprint(a) {
  return {
    n: a.n,
    favWinRate: rate(a.favWin, a.n),
    drawRate: rate(a.draw, a.n),
    over25Rate: rate(a.over25, a.n),
    steamFavWin: rate(a.steamFavWin, a.steamN),
    driftFavWin: rate(a.driftFavWin, a.driftN),
    ouUpOver: rate(a.ouUpOver, a.ouUpN),
    ouDownOver: rate(a.ouDownOver, a.ouDownN),
    favCoverRate: rate(a.coverHit, a.coverN),
  };
}

// 向全局收缩:每个比率 w*league + (1-w)*global, w=n/(n+K)。各维用各自有效样本。
function shrink(a, g) {
  const w = (n) => (n + K > 0 ? n / (n + K) : 0);
  const blend = (lr, gr, n) => (lr == null ? gr : gr == null ? lr : round(w(n) * lr + (1 - w(n)) * gr));
  const r = rawFingerprint(a), gr = rawFingerprint(g);
  return {
    samples: a.n,
    leagueWeight: round(w(a.n)),
    favWinRate: pct(blend(r.favWinRate, gr.favWinRate, a.n)),
    drawRate: pct(blend(r.drawRate, gr.drawRate, a.n)),
    over25Rate: pct(blend(r.over25Rate, gr.over25Rate, a.n)),
    // 市场效率指纹:被加注 vs 退烧 的热门胜率差(越大=开盘价越"未消化",漂移越有信息)
    steamFavWin: pct(blend(r.steamFavWin, gr.steamFavWin, a.steamN)),
    driftFavWin: pct(blend(r.driftFavWin, gr.driftFavWin, a.driftN)),
    driftSeparation: r.steamFavWin != null && r.driftFavWin != null
      ? pct(blend(r.steamFavWin, gr.steamFavWin, a.steamN) - blend(r.driftFavWin, gr.driftFavWin, a.driftN)) : null,
    // 大小球漂移分离度
    ouUpOver: pct(blend(r.ouUpOver, gr.ouUpOver, a.ouUpN)),
    ouDownOver: pct(blend(r.ouDownOver, gr.ouDownOver, a.ouDownN)),
    // 热门过盘率(<50% = 跟热门买让球长期不划算)
    favCoverRate: pct(blend(r.favCoverRate, gr.favCoverRate, a.coverN)),
  };
}
const round = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

async function main() {
  console.log(`[profile] 加载 ${ALL_LEAGUES.length} 联赛 × ${SEASONS.length} 赛季,收缩 K=${K}…`);
  const { ok, matches, byLeague } = await loadFootballDataMatches({ leagues: ALL_LEAGUES, seasons: SEASONS });
  if (!ok) { console.error("无数据"); process.exit(1); }

  const global = newAcc();
  const perLeague = {};
  for (const code of ALL_LEAGUES) perLeague[code] = newAcc();
  for (const m of matches) {
    tally(global, m);
    if (perLeague[m.league]) tally(perLeague[m.league], m);
  }

  const leagues = {};
  for (const code of ALL_LEAGUES) {
    const a = perLeague[code];
    if (a.n === 0) continue;
    leagues[code] = { label: LEAGUE_LABELS[code] ?? code, ...shrink(a, global) };
  }

  const profile = {
    schema: "league-datachange-profile/v1",
    note: "每联赛市场变化(开→收)→结果指纹,已向全局收缩(w=n/(n+K))。球队强度全局学(见 league-expert-mixture),本层只补市场行为维。",
    seasons: SEASONS, shrinkK: K, totalMatches: matches.length,
    global: { ...rawFingerprintPct(global) },
    leagues,
  };

  const outDir = getExportDir();
  const jsonPath = join(outDir, "data-change-league-profile.json");
  writeFileSync(jsonPath, JSON.stringify(profile, null, 2), "utf8");

  // xlsx
  const header = ["联赛", "代码", "样本n", "信本联赛w", "热门胜率%", "平率%", "大球率%",
    "被加注热门胜%", "退烧热门胜%", "漂移分离度pp", "升盘大球%", "降盘大球%", "热门过盘%"];
  const rows = [["每联赛数据变化指纹(向全局收缩)", `${SEASONS.join("/")} · K=${K} · ${matches.length}场`], [], header];
  const sorted = Object.entries(leagues).sort((a, b) => b[1].samples - a[1].samples);
  for (const [code, v] of sorted) {
    rows.push([v.label, code, v.samples, v.leagueWeight, v.favWinRate, v.drawRate, v.over25Rate,
      v.steamFavWin, v.driftFavWin, v.driftSeparation, v.ouUpOver, v.ouDownOver, v.favCoverRate]);
  }
  const g = rawFingerprintPct(global);
  rows.push([], ["全局(大模型先验)", "ALL", global.n, "—", g.favWinRate, g.drawRate, g.over25Rate,
    g.steamFavWin, g.driftFavWin, g.driftSeparation, g.ouUpOver, g.ouDownOver, g.favCoverRate]);
  const deskBase = `每联赛数据变化指纹_${SEASONS[0]}.xlsx`;
  let deskPath = join(process.env.USERPROFILE || outDir, "Desktop", deskBase);
  try { writeXlsxWorkbook(deskPath, [{ name: "联赛数据变化指纹", rows }]); }
  catch { deskPath = join(outDir, deskBase); writeXlsxWorkbook(deskPath, [{ name: "联赛数据变化指纹", rows }]); }

  console.log(`[profile] ${Object.keys(leagues).length} 联赛指纹已建`);
  console.log(`[profile] JSON → ${jsonPath}`);
  console.log(`[profile] XLSX → ${deskPath}`);
  // 控制台:按漂移分离度(市场低效程度)排序,挑出最值得用漂移信号的联赛
  console.log("\n=== 漂移分离度 Top(开盘价越未消化、漂移越有信息)===");
  for (const [code, v] of Object.entries(leagues).sort((a, b) => (b[1].driftSeparation ?? -99) - (a[1].driftSeparation ?? -99)).slice(0, 8)) {
    console.log(`${v.label}(${code}) n=${v.samples} 分离度=${v.driftSeparation}pp 被加注${v.steamFavWin}% vs 退烧${v.driftFavWin}% 过盘${v.favCoverRate}%`);
  }
}

function rawFingerprintPct(a) {
  const r = rawFingerprint(a);
  return {
    n: a.n,
    favWinRate: pct(r.favWinRate), drawRate: pct(r.drawRate), over25Rate: pct(r.over25Rate),
    steamFavWin: pct(r.steamFavWin), driftFavWin: pct(r.driftFavWin),
    driftSeparation: r.steamFavWin != null && r.driftFavWin != null ? pct(r.steamFavWin - r.driftFavWin) : null,
    ouUpOver: pct(r.ouUpOver), ouDownOver: pct(r.ouDownOver), favCoverRate: pct(r.favCoverRate),
  };
}

main().catch((e) => { console.error("[profile] 失败:", e.message); process.exit(1); });
