/**
 * ClubElo 预测力验证 · 留出回测(2026-05-31 学习轮 16,clubelo 第二步)
 * ─────────────────────────────────────────────────────────────
 * 目的:验证 clubelo Elo 对 football-data big-5 赛果有无预测力 + 与市场比。有 → 第三步接 DC 收缩锚。
 * 方法(leak-safe):抓测试期月度 Elo 快照(每月1号,含全俱乐部);每场用**赛前最近月快照**取
 *   双方 Elo → eloWinProb(主胜 vs 非主胜二分)→ 对比实际 + 市场同口径。仅 clubelo 覆盖(欧洲)的场。
 * 用法:node scripts/run-clubelo-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fetchClubEloSnapshot, normalizeClubKey, eloWinProb } from "../src/clubelo-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const TEST_FROM = "2025-01-01";
// 月度快照日期(覆盖 2025-01 ~ 2026-05)
const MONTHS = [];
for (const y of [2025, 2026]) for (let mo = 1; mo <= 12; mo++) {
  const d = `${y}-${String(mo).padStart(2, "0")}-01`;
  if (d >= "2025-01-01" && d <= "2026-06-01") MONTHS.push(d);
}

const res = await loadFootballDataMatches({ leagues: BIG5 });
const test = res.matches.filter((m) => m.homeGoals != null && m.date >= TEST_FROM && (m.oddsClose || m.odds));
console.log(`big-5 测试期(${TEST_FROM}+)${test.length} 场;抓 ${MONTHS.length} 个月度 Elo 快照...`);

const snaps = [];
for (const d of MONTHS) {
  const s = await fetchClubEloSnapshot(d);
  if (s.ok) snaps.push({ date: d, byClub: s.byClub });
}
snaps.sort((a, b) => (a.date < b.date ? -1 : 1));
console.log(`成功 ${snaps.length} 个快照\n`);

function eloAt(date, clubKey) {
  let best = null;
  for (const s of snaps) { if (s.date <= date && s.byClub.has(clubKey)) best = s.byClub.get(clubKey); else if (s.date > date) break; }
  return best?.elo ?? null;
}

let matched = 0, unmatched = 0;
let bElo = 0, lElo = 0, accElo = 0, bMkt = 0, lMkt = 0, accMkt = 0, n = 0;
const cl = (q) => Math.min(1 - EPS, Math.max(EPS, q));
for (const m of test) {
  const he = eloAt(m.date, normalizeClubKey(m.home));
  const ae = eloAt(m.date, normalizeClubKey(m.away));
  if (he == null || ae == null) { unmatched++; continue; }
  matched++;
  const y = m.homeGoals > m.awayGoals ? 1 : 0; // 主胜 vs 非主胜
  const pElo = eloWinProb(he, ae); // 含主场加成
  const prob = m.oddsClose || m.odds;
  const pMkt = prob.home; // 市场主胜隐含
  bElo += (pElo - y) ** 2; lElo += -Math.log(cl(y ? pElo : 1 - pElo)); if ((pElo >= 0.5) === (y === 1)) accElo++;
  bMkt += (pMkt - y) ** 2; lMkt += -Math.log(cl(y ? pMkt : 1 - pMkt)); if ((pMkt >= 0.5) === (y === 1)) accMkt++;
  n++;
}
console.log(`匹配 ${matched} 场 / 未匹配(队名对不上)${unmatched} 场 → 覆盖率 ${(matched / (matched + unmatched) * 100).toFixed(1)}%\n`);
console.log("主胜二分预测(越低越准):");
console.log(`  ClubElo:  Brier ${(bElo / n).toFixed(4)} | LogLoss ${(lElo / n).toFixed(4)} | 命中 ${(accElo / n * 100).toFixed(1)}%`);
console.log(`  市场赔率: Brier ${(bMkt / n).toFixed(4)} | LogLoss ${(lMkt / n).toFixed(4)} | 命中 ${(accMkt / n * 100).toFixed(1)}%`);
console.log(`\n诚实结论:Elo Brier ${bElo < bMkt ? "<" : ">"} 市场(${bElo < bMkt ? "优于" : "不及"});Elo 有无预测力看其 Brier 是否 < 0.25(随机)+命中是否 >50%。`);
console.log(`  ${(bElo / n) < 0.25 && (accElo / n) > 0.5 ? "→ Elo 有真实预测力,可作 DC 跨联赛先验/收缩锚(第三步);不及市场属正常(市场含更多信息)。" : "→ Elo 预测力弱,慎接。"}`);
