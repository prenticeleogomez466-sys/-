/**
 * 近五年全量「数据变化」实证学习(2026-05-31)
 * ──────────────────────────────────────────────────────────────────────────
 * 用户要求:读取近五年所有比赛的"数据变化"(开盘→收盘 欧赔漂移 / 亚盘线+水位移动 /
 * 大小球漂移),学习其与真实结果的经验关系,提炼进永久记忆。
 *
 * 诚实口径(遵 reference_signal_backtest_findings):开→收漂移大部分已被市场定价,
 * 学出来的是"某数据变化 → 某结果的经验频率",不是打败市场的命中率。残余信号主要在
 * 让球(是否过盘)/比分分差/大小球这些次级市场。
 *
 * 数据:football-data.co.uk 18 联赛(五大+13次级)× 5 赛季(2122-2526)。
 * 全部去 vig、open(Avg)vs close(AvgC)、亚盘 AHh→AHCh、O/U Avg→AvgC。
 * 输出:① 控制台关键发现 ② JSON profile(供生产读)③ 桌面 xlsx。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { getExportDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SEASONS = (getArg("seasons", "2526,2425,2324,2223,2122")).split(",");

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }
function favKey(p) { return p.home >= p.draw && p.home >= p.away ? "home" : (p.away >= p.draw ? "away" : "draw"); }
function outcome(m) { return m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw"; }

// 累加器:{n, 命中计数...}
function acc() { return { n: 0, favWin: 0, draw: 0, dog: 0, over25: 0, favCover: 0, push: 0, favWin1: 0, favWin2plus: 0 }; }
function tally(a, m, fav) {
  a.n++;
  const out = outcome(m);
  const favWon = out === fav;
  if (out === "draw") a.draw++;
  else if (favWon) a.favWin++;
  else a.dog++;
  if (m.homeGoals + m.awayGoals > 2.5) a.over25++;
  // 热门赢球分差(只在热门赢时):1 球 vs ≥2 球
  if (favWon) {
    const gd = Math.abs(m.homeGoals - m.awayGoals);
    if (gd === 1) a.favWin1++; else if (gd >= 2) a.favWin2plus++;
  }
}
function summarize(a) {
  return {
    n: a.n,
    热门胜率: pct(a.favWin, a.n), 平率: pct(a.draw, a.n), 冷门率: pct(a.dog, a.n),
    大球率: pct(a.over25, a.n),
    热门赢时1球分差占比: pct(a.favWin1, a.favWin), 热门赢时2球以上占比: pct(a.favWin2plus, a.favWin),
  };
}

// 亚盘:热门是否覆盖收盘让球线。line 从主队视角(负=主让)。
function favCovers(m) {
  const line = Number(m.asian?.lineClose ?? m.asian?.line);
  if (!Number.isFinite(line)) return null;
  const gd = m.homeGoals - m.awayGoals;        // 主队净胜球
  const homeFav = line < 0;                     // 主让=主热
  const adj = gd + line;                        // 主队让球后净胜(>0 主过盘)
  const favAdj = homeFav ? adj : -adj;          // 从热门视角:>0 过盘
  if (Math.abs(favAdj) < 1e-9) return "push";
  return favAdj > 0 ? "cover" : "no-cover";
}

async function main() {
  console.log(`[study] 加载 ${ALL_LEAGUES.length} 联赛 × ${SEASONS.length} 赛季(${SEASONS.join("/")})…`);
  const { ok, matches, withOdds, withClosing, withAsian, byLeague } =
    await loadFootballDataMatches({ leagues: ALL_LEAGUES, seasons: SEASONS });
  if (!ok) { console.error("无数据(网络?)"); process.exit(1); }
  console.log(`[study] 共 ${matches.length} 场 | 带开盘 ${withOdds} | 带收盘 ${withClosing} | 带亚盘 ${withAsian}`);

  // ① 1X2 热门 开→收 漂移 → 结果
  const drift1x2 = { steam: acc(), stable: acc(), drift: acc() }; // steam=被加注(收盘概率↑), drift=退烧(↓)
  // ② 亚盘热门 水位 开→收 移动 → 是否过盘
  const water = { up: acc(), flat: acc(), down: acc() };          // 热门方水位升/平/降
  // ③ 大小球 开→收 漂移 → 大球
  const ouDrift = { up: acc(), flat: acc(), down: acc() };
  // ④ 亚盘线 开→收 移动(加深/减浅)→ 过盘
  const lineMove = { deeper: acc(), flat: acc(), shallower: acc() };

  let n1x2 = 0, nWater = 0, nOu = 0, nLine = 0;
  const coverCount = { up: { c: 0, p: 0, n: 0 }, flat: { c: 0, p: 0, n: 0 }, down: { c: 0, p: 0, n: 0 },
                       deeper: { c: 0, p: 0, n: 0 }, shallower: { c: 0, p: 0, n: 0 }, lflat: { c: 0, p: 0, n: 0 } };
  const addCover = (bucket, cov) => { if (!cov) return; coverCount[bucket].n++; if (cov === "cover") coverCount[bucket].c++; else if (cov === "push") coverCount[bucket].p++; };

  for (const m of matches) {
    if (m.homeGoals == null || m.awayGoals == null) continue;
    // ① 1X2 漂移
    if (m.odds && m.oddsClose) {
      const fav = favKey(m.odds);
      const d = m.oddsClose[fav] - m.odds[fav];
      const b = d > 0.02 ? "steam" : d < -0.02 ? "drift" : "stable";
      tally(drift1x2[b], m, fav); n1x2++;
    }
    // ② 亚盘水位移动(热门方)
    const a = m.asian;
    if (a && Number.isFinite(a.homeWater) && Number.isFinite(a.homeWaterClose)) {
      const line = Number(a.lineClose ?? a.line);
      const homeFav = line < 0;
      const wOpen = homeFav ? a.homeWater : a.awayWater;
      const wClose = homeFav ? a.homeWaterClose : a.awayWaterClose;
      if (Number.isFinite(wOpen) && Number.isFinite(wClose)) {
        const dw = wClose - wOpen;
        const b = dw > 0.03 ? "up" : dw < -0.03 ? "down" : "flat";
        const fav = homeFav ? "home" : "away";
        tally(water[b], m, fav); nWater++;
        addCover(b, favCovers(m));
      }
    }
    // ③ 大小球漂移
    if (Number.isFinite(m.overProb) && Number.isFinite(m.overProbClose)) {
      const d = m.overProbClose - m.overProb;
      const b = d > 0.02 ? "up" : d < -0.02 ? "down" : "flat";
      const fav = m.odds ? favKey(m.odds) : "home";
      tally(ouDrift[b], m, fav); nOu++;
    }
    // ④ 亚盘线移动
    if (a && Number.isFinite(a.line) && Number.isFinite(a.lineClose)) {
      const homeFav = (a.lineClose ?? a.line) < 0;
      // 线"加深"=收盘比开盘让得更多(热门更被看好)
      const deeper = Math.abs(a.lineClose) > Math.abs(a.line) + 0.05;
      const shallower = Math.abs(a.lineClose) < Math.abs(a.line) - 0.05;
      const b = deeper ? "deeper" : shallower ? "shallower" : "flat";
      const fav = homeFav ? "home" : "away";
      tally(lineMove[b], m, fav); nLine++;
      addCover(b === "deeper" ? "deeper" : b === "shallower" ? "shallower" : "lflat", favCovers(m));
    }
  }

  const coverRate = (k) => pct(coverCount[k].c, coverCount[k].n);
  const pushRate = (k) => pct(coverCount[k].p, coverCount[k].n);

  const findings = {
    generatedAtNote: "由 study-5yr-data-changes.mjs 生成;时间戳由外层落盘补",
    seasons: SEASONS, leagues: ALL_LEAGUES.length, totalMatches: matches.length,
    withOdds, withClosing, withAsian, byLeague,
    "①_1X2热门开收漂移": {
      被加注_收盘概率升: { ...summarize(drift1x2.steam) },
      稳定: { ...summarize(drift1x2.stable) },
      退烧_收盘概率降: { ...summarize(drift1x2.drift) },
      n: n1x2,
    },
    "②_亚盘热门水位移动→过盘": {
      热门升水_资金少: { ...summarize(water.up), 过盘率: coverRate("up"), 走盘率: pushRate("up") },
      水位平稳: { ...summarize(water.flat), 过盘率: coverRate("flat"), 走盘率: pushRate("flat") },
      热门降水_资金多: { ...summarize(water.down), 过盘率: coverRate("down"), 走盘率: pushRate("down") },
      n: nWater,
    },
    "③_大小球开收漂移→大球": {
      升_看涨进球: { ...summarize(ouDrift.up) },
      平: { ...summarize(ouDrift.flat) },
      降_看跌进球: { ...summarize(ouDrift.down) },
      n: nOu,
    },
    "④_亚盘线开收移动→过盘": {
      线加深_更看好热门: { ...summarize(lineMove.deeper), 过盘率: coverRate("deeper"), 走盘率: pushRate("deeper") },
      线变浅_退让: { ...summarize(lineMove.shallower), 过盘率: coverRate("shallower"), 走盘率: pushRate("shallower") },
      n: nLine,
    },
  };

  // 落 JSON profile(供生产读)
  const outDir = getExportDir();
  const jsonPath = join(outDir, "data-change-study-5yr.json");
  writeFileSync(jsonPath, JSON.stringify(findings, null, 2), "utf8");

  // 落 xlsx(桌面可读)
  const rowsOf = (title, obj) => {
    const rows = [[title], ["分桶", "样本n", "热门胜率%", "平率%", "冷门率%", "大球率%", "赢时1球%", "赢时2+球%", "过盘率%", "走盘率%"]];
    for (const [k, v] of Object.entries(obj)) {
      if (k === "n" || typeof v !== "object") continue;
      rows.push([k, v.n, v.热门胜率, v.平率, v.冷门率, v.大球率, v.热门赢时1球分差占比, v.热门赢时2球以上占比, v.过盘率 ?? "", v.走盘率 ?? ""]);
    }
    rows.push([]);
    return rows;
  };
  const sheet = [
    ["近五年数据变化实证学习", `${SEASONS.join("/")} · ${ALL_LEAGUES.length}联赛 · ${matches.length}场`],
    [],
    ...rowsOf("① 1X2 热门 开→收 漂移", findings["①_1X2热门开收漂移"]),
    ...rowsOf("② 亚盘热门 水位 开→收 移动 → 是否过盘", findings["②_亚盘热门水位移动→过盘"]),
    ...rowsOf("③ 大小球 开→收 漂移 → 大球", findings["③_大小球开收漂移→大球"]),
    ...rowsOf("④ 亚盘线 开→收 移动 → 是否过盘", findings["④_亚盘线开收移动→过盘"]),
  ];
  const deskPath = join(process.env.USERPROFILE || outDir, "Desktop", `近五年数据变化学习_${SEASONS[0]}.xlsx`);
  let wroteDesk = deskPath;
  try { writeXlsxWorkbook(deskPath, [{ name: "数据变化学习", rows: sheet }]); }
  catch { wroteDesk = join(outDir, `近五年数据变化学习_${SEASONS[0]}.xlsx`); writeXlsxWorkbook(wroteDesk, [{ name: "数据变化学习", rows: sheet }]); }

  // 控制台关键发现
  console.log("\n===== 关键发现(近五年实证)=====");
  console.log(JSON.stringify(findings, null, 2));
  console.log(`\n[study] JSON → ${jsonPath}`);
  console.log(`[study] XLSX → ${wroteDesk}`);
}

main().catch((e) => { console.error("[study] 失败:", e.message); process.exit(1); });
