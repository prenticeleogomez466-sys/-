#!/usr/bin/env node
/**
 * 联赛「超级计算机」— 对标 Opta:整季蒙特卡洛 → 每队 夺冠/欧冠区/欧战区/降级 概率。
 * 评级 = ClubElo(clubelo.com 免费 API,按国家+顶级联赛 Level 过滤出真实当前阵容+Elo)。
 * 引擎见 src/league-simulator.js。赛季前(无剩余赛程)默认跑双循环全赛程;赛季中可扩展传 currentTable+剩余赛程。
 *
 * 用法:node scripts/run-league-supercomputer.mjs --league eng [--date 2026-06-02] [--n 10000] [--json] [--xlsx]
 *   联赛代码:eng(英超) esp(西甲) ita(意甲) ger(德甲) fra(法甲)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { fetchClubEloSnapshot } from "../src/clubelo-loader.js";
import { runLeagueMonteCarlo } from "../src/league-simulator.js";

const argv = process.argv.slice(2);
const argStr = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const argNum = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };

// 联赛 → ClubElo 国家码 + 规模(欧冠区/欧战区/降级席位)
const LEAGUES = {
  eng: { country: "ENG", zh: "英超", size: 20, euroSpots: 5, europaCut: 7, relegationSpots: 3 },
  esp: { country: "ESP", zh: "西甲", size: 20, euroSpots: 5, europaCut: 7, relegationSpots: 3 },
  ita: { country: "ITA", zh: "意甲", size: 20, euroSpots: 5, europaCut: 7, relegationSpots: 3 },
  ger: { country: "GER", zh: "德甲", size: 18, euroSpots: 4, europaCut: 6, relegationSpots: 2 },
  fra: { country: "FRA", zh: "法甲", size: 18, euroSpots: 4, europaCut: 6, relegationSpots: 3 },
};

const code = (argStr("--league", "eng") || "eng").toLowerCase();
const L = LEAGUES[code];
if (!L) { console.error("未知联赛代码,支持:", Object.keys(LEAGUES).join("/")); process.exit(1); }
const DATE = argStr("--date", new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()));
const N = argNum("--n", 10000);
const SEED = argNum("--seed", 20260801);

// 代理 env 会干扰 http 抓取(见记忆 lottery-fetch-proxy),先清空
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];

// 自动回退:ClubElo 在休赛期/未来日期返回空 → 向前找最近有数据的快照(逐月回溯,最多 24 个月)
async function snapshotWithFallback(startDate) {
  let snap = await fetchClubEloSnapshot(startDate);
  if (snap.ok && snap.rows.length) return { snap, usedDate: startDate };
  const d = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < 24; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    const dd = d.toISOString().slice(0, 10);
    snap = await fetchClubEloSnapshot(dd);
    if (snap.ok && snap.rows.length) return { snap, usedDate: dd };
  }
  return { snap: null, usedDate: null };
}

const { snap, usedDate } = await snapshotWithFallback(DATE);
if (!snap) { console.error("ClubElo 24个月内均无数据,检查网络/代理"); process.exit(1); }
if (usedDate !== DATE) console.warn(`⚠️ ClubElo ${DATE} 无数据(休赛期/未来),自动回退到最近快照 ${usedDate}(=该赛季实际阵容+Elo)。`);

// 取该国顶级联赛(Level 1)的球队,按 Elo 取前 size 支(=当季在顶级的阵容)
const pool = snap.rows
  .filter((r) => r.country === L.country && (r.level === 1 || r.level === null))
  .sort((a, b) => b.elo - a.elo);
const roster = pool.slice(0, L.size);
if (roster.length < L.size) {
  console.warn(`⚠️ ClubElo ${L.country} Level1 仅匹配 ${roster.length}/${L.size} 队(日期 ${DATE} 可能在休赛期换季空窗),用现有 ${roster.length} 队继续。`);
}
const teams = roster.map((r) => r.club);
const eloMap = Object.fromEntries(roster.map((r) => [r.club, r.elo]));
const eloOf = (t) => eloMap[t] ?? 1500;

const res = runLeagueMonteCarlo(teams, eloOf, {
  euroSpots: L.euroSpots, europaCut: L.europaCut, relegationSpots: L.relegationSpots,
  homeAdv: 65, lambdaTotal: 2.7,
}, N, SEED);

const pc = (x) => (x * 100).toFixed(1) + "%";
console.log(`=== ${L.zh} 超级计算机(N=${N} 蒙特卡洛, ClubElo@${usedDate}, 引擎=league-simulator)===`);
console.log(`双循环全赛季模拟 · 评级=ClubElo(免费) · 欧冠区前${L.euroSpots}/欧战区前${L.europaCut}/降级后${L.relegationSpots}`);
console.log("\n名次 球队                Elo   均分  夺冠   欧冠区  欧战区  降级");
res.teams.forEach((r, i) => {
  console.log(`${String(i + 1).padEnd(3)} ${r.team.padEnd(20)} ${String(Math.round(r.elo)).padEnd(5)} ${r.avgPts.toFixed(1).padStart(5)} ${pc(r.champion).padStart(6)} ${pc(r.euroUcl).padStart(6)} ${pc(r.euro).padStart(6)} ${pc(r.relegation).padStart(6)}`);
});
console.log(`\n审计:夺冠和=${pc(res.audit.champSum)}(≈100%) | 欧冠区和=${res.audit.uclSum.toFixed(1)}(=${L.euroSpots}) | 降级和=${res.audit.relSum.toFixed(1)}(=${L.relegationSpots}) | 闸门=${res.audit.ok ? "✓通过" : "✗"}`);
console.log("⚠️ 诚实边界:赛季前从0跑双循环(无主客赛程顺序/伤停);排名用 积分→净胜球→进球→Elo(各联赛相互战绩细则未逐一实现);命中率上限不变。");

if (argv.includes("--json")) {
  const p = join(getExportDir(), `league-supercomputer-${code}.json`);
  writeFileSync(p, JSON.stringify({ league: L.zh, date: DATE, n: N, seed: SEED, audit: res.audit, teams: res.teams }, null, 1));
  console.log("已写 JSON:", p);
}
if (argv.includes("--xlsx")) {
  const header = ["名次", "球队", "Elo", "均分", "夺冠%", "欧冠区%", "欧战区%", "降级%"];
  const data = res.teams.map((r, i) => [i + 1, r.team, Math.round(r.elo), +r.avgPts.toFixed(1), +(r.champion * 100).toFixed(1), +(r.euroUcl * 100).toFixed(1), +(r.euro * 100).toFixed(1), +(r.relegation * 100).toFixed(1)]);
  const tmp = join(getExportDir(), `_league_${code}_rows.json`);
  writeFileSync(tmp, JSON.stringify({ header, data }), "utf8");
  const out = join(getExportDir(), `神选-${L.zh}超算-2026.xlsx`);
  const py = `
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
d=json.load(open(r"${tmp.replace(/\\/g, "\\\\")}",encoding="utf-8"))
wb=Workbook();ws=wb.active;ws.title="${L.zh}超算"
ws.append(d["header"])
for c in ws[1]: c.font=Font(bold=True,color="FFFFFF");c.fill=PatternFill("solid",fgColor="1F4E78");c.alignment=Alignment(horizontal="center")
for row in d["data"]: ws.append(row)
for i,w in enumerate([5,22,7,7,8,9,9,8],1): ws.column_dimensions[chr(64+i)].width=w
ws.freeze_panes="A2"
wb.save(r"${out.replace(/\\/g, "\\\\")}");print("XLSX:",r"${out.replace(/\\/g, "\\\\")}")
`;
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python", ["-c", py], { encoding: "utf8" });
  console.log((r.stdout || "").trim() || `xlsx 失败:${r.stderr}`);
}
