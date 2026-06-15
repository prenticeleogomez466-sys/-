/**
 * 赔率档位 × 水位/盘口变化 两因子交叉实证(2026-06-13)
 * ──────────────────────────────────────────────────────────────────────────
 * 回答用户问题:"什么样的欧赔/亚盘/让球赔率 配合 盘口水位变化,容易出什么结果?"
 * 口径与 study-5yr-data-changes.mjs 一致:football-data.co.uk 18联赛×5季,
 * 开盘=Avg 去vig,收盘=AvgC 去vig,亚盘 AHh/AvgAHH → AHCh/AvgCAHH。
 *
 * 诚实声明:全部是"描述性经验频率"(收盘信息开赛才可知),不是赛前可下注的edge;
 * 用途=情境画像/置信分层,不用于宣称打败市场(遵 reference_signal_backtest_findings)。
 *
 * 四张交叉表:
 *  A. 欧赔热门档位(收盘隐含概率) × 1X2开收漂移方向 → 热门胜/平/冷/大球
 *  B. 亚盘线深度 × 热门方水位移动方向 → 过盘/走盘/热门胜
 *  C. 收盘热门方水位绝对档(低/中/高水) × 线深 → 过盘率(检验"低水深盘"民间口诀)
 *  D. 欧赔漂移 × 亚盘线移动 同向/背离 → 热门胜/平/冷/过盘(欧亚联动)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { getExportDir } from "../src/paths.js";

const SEASONS = ["2526", "2425", "2324", "2223", "2122"];
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const favKey = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw");
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");

function favCovers(m) {
  const line = Number(m.asian?.lineClose ?? m.asian?.line);
  if (!Number.isFinite(line)) return null;
  const favAdj = (line < 0 ? 1 : -1) * (m.homeGoals - m.awayGoals + line);
  if (Math.abs(favAdj) < 1e-9) return "push";
  return favAdj > 0 ? "cover" : "no-cover";
}

function cell() { return { n: 0, favWin: 0, draw: 0, dog: 0, over: 0, cover: 0, push: 0, coverN: 0 }; }
function add(c, m, fav) {
  c.n++;
  const out = outcome(m);
  if (out === "draw") c.draw++; else if (out === fav) c.favWin++; else c.dog++;
  if (m.homeGoals + m.awayGoals > 2.5) c.over++;
  const cov = favCovers(m);
  if (cov) { c.coverN++; if (cov === "cover") c.cover++; else if (cov === "push") c.push++; }
}
function fmt(c) {
  return { n: c.n, 热门胜率: pct(c.favWin, c.n), 平率: pct(c.draw, c.n), 冷门率: pct(c.dog, c.n),
    大球率: pct(c.over, c.n), 过盘率: pct(c.cover, c.coverN), 走盘率: pct(c.push, c.coverN) };
}

// 档位定义
function oddsBand(p) { // p=收盘热门隐含概率(去vig)
  if (p >= 0.70) return "①超热(赔率≲1.40,隐含≥70%)";
  if (p >= 0.60) return "②大热(≈1.40-1.65)";
  if (p >= 0.50) return "③中热(≈1.65-1.95)";
  if (p >= 0.42) return "④小热(≈1.95-2.30)";
  return "⑤均势(>2.30,无明显热门)";
}
function lineBand(absLine) {
  if (absLine < 0.4) return "浅盘(平手/半球内: 0~0.25)";
  if (absLine < 0.9) return "中盘(半球~半一: 0.5~0.75)";
  if (absLine < 1.4) return "深盘(一球~球半内: 1~1.25)";
  return "超深盘(≥1.5)";
}
// football-data 亚盘赔率为欧式小数(含本金,≈1.90);中式水位≈欧式-1
function waterBand(w) {
  if (w < 1.85) return "低水(中式<0.85,钱压热门)";
  if (w <= 2.02) return "中水(中式0.85-1.02)";
  return "高水(中式>1.02,钱不在热门)";
}

async function main() {
  const { ok, matches } = await loadFootballDataMatches({ leagues: ALL_LEAGUES, seasons: SEASONS });
  if (!ok) { console.error("no data"); process.exit(1); }

  const A = {}, B = {}, C = {}, D = {};
  const at = (obj, k1, k2) => ((obj[k1] ??= {})[k2] ??= cell());

  for (const m of matches) {
    if (m.homeGoals == null || m.awayGoals == null) continue;
    const a = m.asian;
    const line = a ? Number(a.lineClose ?? a.line) : NaN;
    const homeFav = line < 0;

    // A. 欧赔档位 × 漂移
    if (m.odds && m.oddsClose) {
      const fav = favKey(m.oddsClose);
      const d = m.oddsClose[favKey(m.odds)] - m.odds[favKey(m.odds)];
      const dir = d > 0.02 ? "被加注(收盘概率↑)" : d < -0.02 ? "退烧(收盘概率↓)" : "稳定";
      add(at(A, oddsBand(m.oddsClose[fav]), dir), m, fav);
    }

    // B. 线深 × 水位移动 / C. 水位绝对档 × 线深
    if (a && Number.isFinite(line)) {
      const fav = homeFav ? "home" : "away";
      const wOpen = homeFav ? a.homeWater : a.awayWater;
      const wClose = homeFav ? a.homeWaterClose : a.awayWaterClose;
      if (Number.isFinite(wOpen) && Number.isFinite(wClose)) {
        const dw = wClose - wOpen;
        const dir = dw > 0.03 ? "升水(热门方资金少)" : dw < -0.03 ? "降水(热门方资金多)" : "水位平稳";
        add(at(B, lineBand(Math.abs(line)), dir), m, fav);
      }
      if (Number.isFinite(wClose)) {
        add(at(C, waterBand(wClose), lineBand(Math.abs(line))), m, fav);
      }
    }

    // D. 欧亚联动:欧赔漂移 × 亚盘线移动
    if (m.odds && m.oddsClose && a && Number.isFinite(a.line) && Number.isFinite(a.lineClose)) {
      const fav = favKey(m.odds);
      const d = m.oddsClose[fav] - m.odds[fav];
      const euro = d > 0.02 ? "euro-up" : d < -0.02 ? "euro-down" : "euro-flat";
      const deeper = Math.abs(a.lineClose) > Math.abs(a.line) + 0.05;
      const shallower = Math.abs(a.lineClose) < Math.abs(a.line) - 0.05;
      const asia = deeper ? "asia-deeper" : shallower ? "asia-shallower" : "asia-flat";
      let combo;
      if (euro === "euro-up" && asia === "asia-deeper") combo = "①欧亚同向看好(欧赔升概率+亚盘加深)";
      else if (euro === "euro-down" && asia === "asia-shallower") combo = "②欧亚同向看衰(欧赔退烧+亚盘变浅)";
      else if (euro === "euro-up" && asia === "asia-shallower") combo = "③背离:欧看好亚退让";
      else if (euro === "euro-down" && asia === "asia-deeper") combo = "④背离:欧退烧亚加深";
      else if (euro === "euro-flat" && asia === "asia-flat") combo = "⑤双稳";
      else combo = "⑥单边动(另一边稳)";
      add(at(D, combo, "全部"), m, fav);
    }
  }

  const render = (obj) => {
    const out = {};
    for (const [k1, row] of Object.entries(obj)) { out[k1] = {}; for (const [k2, c] of Object.entries(row)) out[k1][k2] = fmt(c); }
    return out;
  };
  const findings = {
    note: "描述性经验频率(用到收盘信息),非赛前可下注edge",
    seasons: SEASONS, leagues: ALL_LEAGUES.length, totalMatches: matches.length,
    "A_欧赔档位×开收漂移": render(A),
    "B_亚盘线深×水位移动": render(B),
    "C_收盘水位档×线深→过盘": render(C),
    "D_欧亚联动同向背离": render(D),
  };
  const jsonPath = join(getExportDir(), "odds-water-interaction-5yr.json");
  writeFileSync(jsonPath, JSON.stringify(findings, null, 2), "utf8");
  console.log(JSON.stringify(findings, null, 2));
  console.log(`\n[diag] JSON → ${jsonPath}`);
}

main().catch((e) => { console.error("[diag] fail:", e.message); process.exit(1); });
