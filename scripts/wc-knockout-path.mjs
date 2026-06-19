#!/usr/bin/env node
/**
 * 世界杯【名次→淘汰赛路径】分析(2026-06-19 建)——回答:小组若第几出线会碰谁?想碰谁、不想碰谁?
 * ════════════════════════════════════════════════════════════════════════════════════════
 * 铁律 no-fallback:已踢场只用 fixture-store 真实赛果(绝不编造);未踢场用真实分组+Elo 条件蒙特卡洛预测(正当预测非泄漏)。
 * 方法:
 *   1) 真实赛果重建 12 组当前积分榜(src/wc-group-standings)。
 *   2) 条件 MC:每组 6 个对阵,已踢→注入真实比分,未踢→sampleScoreline(与超算同分布:NB(8)+venue+host)。
 *      每次模拟解出 1A..1L / 2A..2L / 最佳8第三,按 FIFA 官方 bracket.json(R32 位次+第三名分配表)解析每个位次的 R32 对手。
 *   3) 跨 N 次模拟 tally:P(每队第1/第2/出线) + 各组"位次第1/第2"的 R32 对手分布 + 该位次所在半区/象限的最强威胁。
 *   4) 出"若第1碰谁 / 若第2碰谁 / 想碰(对手弱) / 不想碰(对手强)"。
 * 用法: node scripts/wc-knockout-path.mjs [--n 20000] [--seed 20260619]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { teamPrior, groupVenueMults, marketWeOf } from "../src/world-cup-priors.js";
import { sampleScoreline, rankGroup, mulberry32 } from "../src/tournament-simulator.js";
import { groupTable, allGroupPairs, remainingPairs } from "../src/wc-group-standings.js";
import { loadFixtures } from "../src/fixture-store.js";

const argNum = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = argNum("--n", 20000);
const SEED = argNum("--seed", 20260619);
const HOSTS = new Set(["美国", "加拿大", "墨西哥"]);

const dir = join(getDataSubdir("world-cup"), "2026");
const gdoc = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
const bracket = JSON.parse(readFileSync(join(dir, "bracket.json"), "utf8"));
const zh = gdoc.team_name_zh || {};
// 用中文队名建组(生产口径)
const groups = {};
for (const [g, ens] of Object.entries(gdoc.groups)) groups[g] = ens.map((e) => zh[e] || e);
const GLETTERS = Object.keys(groups);

// 队名别名(fixture-store 写法 → groups.json 规范中文)
const ALIAS = { "刚果(金)": "刚果民主共和国", "刚果（金）": "刚果民主共和国" };
const norm = (t) => ALIAS[t] || t;

// ── Elo(缺则按组内均值代理,诚实标注,不编造具体值) ──
const elo = {}; const missing = [];
for (const teams of Object.values(groups)) for (const t of teams) {
  const tp = teamPrior(t);
  if (tp?.elo) elo[t] = tp.elo; else { elo[t] = null; missing.push(t); }
}
for (const teams of Object.values(groups)) {
  const have = teams.map((t) => elo[t]).filter(Boolean);
  const avg = have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : 1500;
  for (const t of teams) if (elo[t] == null) elo[t] = avg;
}
const eloOf = (t) => elo[t] ?? 1500;
if (missing.length) console.log(`⚠ 缺 Elo(按组内均值代理): ${missing.join("、")}`);

// ── 真实已踢 WC 赛果(fixture-store,跨彩种去重,只取已结算) ──
function loadPlayed() {
  const byPair = new Map();
  for (let d = 11; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    let fx; try { fx = loadFixtures(date); } catch { continue; }
    for (const f of (fx?.fixtures || [])) {
      if (!/世界杯|world/i.test(f.competition || "")) continue;
      const h = norm(f.homeTeam), a = norm(f.awayTeam);
      if (f.result?.home == null || f.result?.away == null) continue;
      const key = [h, a].sort((x, y) => x.localeCompare(y, "zh")).join("|");
      byPair.set(key, { home: h, away: a, ga: f.result.home, gb: f.result.away }); // 后写覆盖(同场多彩种一致)
    }
  }
  return byPair; // key→{home,away,ga,gb}
}
const playedByPair = loadPlayed();
const pk = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh")).join("|");

// 每组的已踢真实赛果列表(供积分榜)
const playedByGroup = {};
for (const [g, teams] of Object.entries(groups)) {
  playedByGroup[g] = [];
  for (const [a, b] of allGroupPairs(teams)) {
    const m = playedByPair.get(pk(a, b));
    if (m) playedByGroup[g].push(m);
  }
}

// ── R32 位次→所在 r32 赛号 / 象限 / 半区 ──
// 象限(每个 QF 由 4 场 r32 喂入): Q1{73,74,75,77} Q2{76,78,79,80} Q3{81,82,83,84} Q4{85,86,87,88}
const QUARTERS = { Q1: [73, 74, 75, 77], Q2: [76, 78, 79, 80], Q3: [81, 82, 83, 84], Q4: [85, 86, 87, 88] };
const matchQuarter = {};
for (const [q, ms] of Object.entries(QUARTERS)) for (const m of ms) matchQuarter[m] = q;
const quarterHalf = { Q1: "上半区", Q2: "上半区", Q3: "下半区", Q4: "下半区" };
// 位次 slot("1A"/"2A"/"T@1A") 出现在哪个 r32 赛号
const slotMatch = {};
for (const m of bracket.r32) { slotMatch[m.home] = m.m; slotMatch[m.away] = m.m; }

// 解析单次模拟的 R32 对手:slotTeam(位次→队), thirdAssign(本次第三名分配)
function resolveR32(winners, runners, thirds, bestThirdGroupsKey) {
  const assign = bracket.thirdPlaceTable[bestThirdGroupsKey]; // {"1A":"E",...} winner-of-A 碰 来自该组字母的第三
  const thirdByGroup = {}; for (const t of thirds) thirdByGroup[t.group] = t.team;
  const slotTeam = (slot) => {
    if (slot.startsWith("T@")) { // "T@1A" → A 组头名的第三名对手
      const winSlot = slot.slice(2); // "1A"
      const grpLetter = assign?.[winSlot];
      return grpLetter ? thirdByGroup[grpLetter] : null;
    }
    const rank = slot[0], g = slot.slice(1);
    return rank === "1" ? winners[g] : runners[g];
  };
  const oppOfSlot = {}; // slot → 对手队名
  for (const mm of bracket.r32) {
    const ht = slotTeam(mm.home), at = slotTeam(mm.away);
    if (mm.home && at) oppOfSlot[mm.home] = at;
    if (mm.away && ht) oppOfSlot[mm.away] = ht;
  }
  return { slotTeam, oppOfSlot };
}

// ── 条件蒙特卡洛 ──
const gvm = groupVenueMults();
const ctxBase = { lambdaTotal: 2.54, nbSize: 8, marketAlpha: 0.65 };
const rng = mulberry32(SEED);

const P1 = {}, P2 = {}, PADV = {}; // 队→次数
for (const teams of Object.values(groups)) for (const t of teams) { P1[t] = 0; P2[t] = 0; PADV[t] = 0; }
// 位次"1g"/"2g" 的 R32 对手分布: oppDist["1A"] = Map(对手队→次数)
const oppDist = {}; const oppEloSum = {}; const quarterTopSum = {};
for (const g of GLETTERS) for (const r of ["1", "2"]) { oppDist[r + g] = new Map(); oppEloSum[r + g] = 0; quarterTopSum[r + g] = 0; }

for (let s = 0; s < N; s++) {
  const winners = {}, runners = {}, thirdsArr = [];
  for (const [g, teams] of Object.entries(groups)) {
    // 6 对阵:已踢注真实,未踢采样
    const matches = [];
    let pairIdx = 0;
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const A = teams[i], B = teams[j];
      const played = playedByPair.get(pk(A, B));
      const vm = gvm?.[g]?.[pairIdx] ?? undefined; pairIdx++;
      if (played) {
        // 真实比分,按真实主客记入(rankGroup 只看进球)
        matches.push({ home: played.home, away: played.away, ga: played.ga, gb: played.gb });
      } else {
        let ha = 0; if (HOSTS.has(A)) ha += 35; if (HOSTS.has(B)) ha -= 35;
        const mwe = marketWeOf ? marketWeOf(A, B) : undefined;
        const { a, b } = sampleScoreline(eloOf(A), eloOf(B), { ...ctxBase, homeAdv: ha, venueMult: vm, marketWe: mwe ?? undefined }, rng);
        matches.push({ home: A, away: B, ga: a, gb: b });
      }
    }
    const ranked = rankGroup(teams, matches, eloOf);
    winners[g] = ranked[0]; runners[g] = ranked[1];
    P1[ranked[0]]++; P2[ranked[1]]++;
    // 第三名带 pts/gd/gf
    const pts = {}, gd = {}, gf = {}; for (const t of teams) { pts[t] = 0; gd[t] = 0; gf[t] = 0; }
    for (const m of matches) {
      if (m.ga > m.gb) pts[m.home] += 3; else if (m.ga < m.gb) pts[m.away] += 3; else { pts[m.home]++; pts[m.away]++; }
      gd[m.home] += m.ga - m.gb; gd[m.away] += m.gb - m.ga; gf[m.home] += m.ga; gf[m.away] += m.gb;
    }
    const t3 = ranked[2];
    thirdsArr.push({ team: t3, group: g, pts: pts[t3], gd: gd[t3], gf: gf[t3] });
  }
  // 最佳 8 第三
  const sortedThirds = [...thirdsArr].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || eloOf(b.team) - eloOf(a.team));
  const best8 = sortedThirds.slice(0, 8);
  for (const x of best8) PADV[x.team]++;
  for (const g of GLETTERS) { PADV[winners[g]]++; PADV[runners[g]]++; }
  const key = best8.map((x) => x.group).sort().join(",");
  if (!bracket.thirdPlaceTable[key]) continue; // 极端 tie 致非法键→跳过该次(诚实丢弃,不编造)
  const { oppOfSlot, slotTeam } = resolveR32(winners, runners, best8, key);
  // tally 各位次对手 + 象限最强威胁
  for (const g of GLETTERS) for (const r of ["1", "2"]) {
    const slot = r + g; const opp = oppOfSlot[slot]; if (!opp) continue;
    oppDist[slot].set(opp, (oppDist[slot].get(opp) || 0) + 1);
    oppEloSum[slot] += eloOf(opp);
    // 本象限内除自己外最强 Elo
    const q = matchQuarter[slotMatch[slot]];
    let top = 0;
    for (const mno of QUARTERS[q]) {
      const mm = bracket.r32.find((x) => x.m === mno);
      for (const sl of [mm.home, mm.away]) {
        const tt = slotTeam(sl); if (!tt) continue;
        if (sl === slot) continue;
        if (eloOf(tt) > top) top = eloOf(tt);
      }
    }
    quarterTopSum[slot] += top;
  }
}

// ── 报告 ──
const pctN = (c) => (c / N * 100);
const fmtPct = (c) => pctN(c).toFixed(0) + "%";
const modalOpp = (slot, k = 3) => [...oppDist[slot].entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
  .map(([t, c]) => `${t}${Math.round(c / N * 100)}%`).join("、");

console.log(`\n══════════ 2026 世界杯·名次→淘汰赛路径分析 (条件MC N=${N}, seed=${SEED}) ══════════`);
console.log(`数据:已踢 ${playedByPair.size} 场真实赛果注入;未踢按真实分组+Elo 模拟。半区:上=Q1/Q2 下=Q3/Q4。`);

// xlsx/json 收集
const standRows = [["组", "队", "积分", "球差", "进球", "已踢", "出线%", "第1%", "第2%"]];
const pathRows = [["组", "名次", "半区/象限", "R32大概率对手(占比)", "对手均强Elo", "象限最强威胁Elo", "路径裁决"]];
const jsonOut = { generatedAt: null, date: null, model: "wc-knockout-path", N, seed: SEED, playedCount: playedByPair.size, groups: {} };

for (const g of GLETTERS) {
  const teams = groups[g];
  const table = groupTable(teams, playedByGroup[g]);
  const rem = remainingPairs(teams, playedByGroup[g]).length;
  console.log(`\n──── ${g} 组  (已踢 ${playedByGroup[g].length}/6，剩 ${rem} 场) ────`);
  console.log(" 队              积分 球差 进球  出线%  第1%  第2%");
  for (const r of table) {
    console.log(
      ` ${r.team.padEnd(12)} ${String(r.pts).padStart(3)} ${String(r.gd >= 0 ? "+" + r.gd : r.gd).padStart(4)} ${String(r.gf).padStart(4)}` +
      `   ${fmtPct(PADV[r.team]).padStart(4)} ${fmtPct(P1[r.team]).padStart(5)} ${fmtPct(P2[r.team]).padStart(5)}`
    );
    standRows.push([g, r.team, r.pts, (r.gd >= 0 ? "+" + r.gd : r.gd), r.gf, r.pld, fmtPct(PADV[r.team]), fmtPct(P1[r.team]), fmtPct(P2[r.team])]);
  }
  const slot1 = "1" + g, slot2 = "2" + g;
  const q1 = matchQuarter[slotMatch[slot1]], q2 = matchQuarter[slotMatch[slot2]];
  const oppElo1 = Math.round(oppEloSum[slot1] / N), oppElo2 = Math.round(oppEloSum[slot2] / N);
  const qTop1 = Math.round(quarterTopSum[slot1] / N), qTop2 = Math.round(quarterTopSum[slot2] / N);
  const easier = oppElo1 + qTop1 < oppElo2 + qTop2 ? "第1名" : "第2名";
  console.log(`  ▸ 第1名(${slot1}, ${quarterHalf[q1]}/${q1}): R32 大概率碰 → ${modalOpp(slot1)}`);
  console.log(`     对手均强 Elo≈${oppElo1}，象限内最强威胁 Elo≈${qTop1}`);
  console.log(`  ▸ 第2名(${slot2}, ${quarterHalf[q2]}/${q2}): R32 大概率碰 → ${modalOpp(slot2)}`);
  console.log(`     对手均强 Elo≈${oppElo2}，象限内最强威胁 Elo≈${qTop2}`);
  console.log(`  ⇒ 路径更轻(对手+象限威胁更弱)= 争${easier}；想碰弱旅则力争${easier}，想躲强队同理。`);
  pathRows.push([g, "第1名", `${quarterHalf[q1]}/${q1}`, modalOpp(slot1), oppElo1, qTop1, `路径更轻=争${easier}`]);
  pathRows.push([g, "第2名", `${quarterHalf[q2]}/${q2}`, modalOpp(slot2), oppElo2, qTop2, easier === "第2名" ? "↞更轻半区" : "对手更强,尽量避免"]);
  jsonOut.groups[g] = {
    table: table.map((r) => ({ team: r.team, pts: r.pts, gd: r.gd, gf: r.gf, pld: r.pld, advance: +pctN(PADV[r.team]).toFixed(1), p1: +pctN(P1[r.team]).toFixed(1), p2: +pctN(P2[r.team]).toFixed(1) })),
    pos1: { half: quarterHalf[q1], quarter: q1, oppTop: modalOpp(slot1), oppElo: oppElo1, quarterTopElo: qTop1 },
    pos2: { half: quarterHalf[q2], quarter: q2, oppTop: modalOpp(slot2), oppElo: oppElo2, quarterTopElo: qTop2 },
    easierPath: easier,
  };
}
console.log(`\n注:第三名对手依"哪8个第三出线"动态变化(FIFA Annex C),以上为 MC 概率分布;末轮赛果一变路径即变。`);

// ── 写盘:xlsx(桌面稳定子文件夹)+ json(exports),默认出,--no-xlsx 关 ──
if (!process.argv.includes("--no-xlsx")) {
  const { writeXlsxWorkbook } = await import("../src/xlsx-writer.js");
  const { getExportDir } = await import("../src/paths.js");
  const { homedir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  jsonOut.generatedAt = new Date().toISOString(); jsonOut.date = today;
  const noteRows = [["世界杯·名次→淘汰赛路径分析"], [`生成 ${today}·条件MC N=${N}·已踢${playedByPair.size}场真实赛果注入,未踢按真实分组+Elo模拟`],
    ["口径"], ["· 名次→R32对手/半区=FIFA官方bracket.json确定性结构(第三名按Annex C 495组合动态)"],
    ["· 出线/第1/第2%=条件蒙特卡洛(已踢真实+未踢预测),非编造"],
    ["· 路径裁决=比较第1/第2名的R32对手均强Elo+所在象限最强威胁,谁更弱=路径更轻"],
    ["· 末轮赛果一变路径即变;第三名对手随哪8个第三出线浮动"]];
  const deskDir = pjoin(homedir(), "Desktop", "足球推荐", "世界杯");
  if (!existsSync(deskDir)) mkdirSync(deskDir, { recursive: true });
  const xlsxPath = pjoin(deskDir, `神选-世界杯名次路径-${today}.xlsx`);
  writeXlsxWorkbook(xlsxPath, [
    { name: "当前积分+出线概率", rows: standRows },
    { name: "名次→淘汰赛路径", rows: pathRows },
    { name: "说明", rows: noteRows },
  ]);
  const jsonPath = pjoin(getExportDir(), "worldcup-knockout-path.json");
  writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 1));
  console.log(`\n✅ xlsx → ${xlsxPath}`);
  console.log(`✅ json → ${jsonPath}`);
}
