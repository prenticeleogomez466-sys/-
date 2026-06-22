#!/usr/bin/env node
/**
 * 世界杯小组赛·当前真实积分 + 下一场胜/平/负情景分析(2026-06-22 用户令)。
 * 数据:真实赛果 wc-tournament-results.json(ESPN fifa.world 正赛抓取)+ groups.json(分组+中文名)。
 * 输出每组:当前积分榜 + 每队下一场对手 + 若胜/平/负各自积分与出线形势(真实推演,禁编)。
 * 诚实:小组赛进行中,具体淘汰赛对手依赖其它组结果未定,只给名次形势+下一场已知对手。
 */
import fs from "node:fs";
const G = JSON.parse(fs.readFileSync("D:/football-model-data/world-cup/2026/groups.json", "utf8"));
const R = JSON.parse(fs.readFileSync("D:/football-model-data/world-cup/2026/wc-tournament-results.json", "utf8"));
const zh = G.team_name_zh || {};
const groups = G.groups;

// ESPN名→groups.json规范名 别名
const ALIAS = { "South Korea": "Korea Republic", "Bosnia-Herzegovina": "Bosnia and Herzegovina", "Bosnia": "Bosnia and Herzegovina", "Türkiye": "Turkiye", "Turkey": "Turkiye", "Curaçao": "Curacao", "Congo DR": "DR Congo", "DR Congo": "DR Congo", "Cape Verde": "Cabo Verde", "Ivory Coast": "Côte d'Ivoire", "USA": "United States", "Czech Republic": "Czechia" };
const canon = (n) => { if (groups && Object.values(groups).flat().includes(n)) return n; if (ALIAS[n] && Object.values(groups).flat().includes(ALIAS[n])) return ALIAS[n]; // 模糊:去标点
  const flat = Object.values(groups).flat(); const hit = flat.find((t) => t.toLowerCase().replace(/[^a-z]/g, "") === n.toLowerCase().replace(/[^a-z]/g, "")); return hit || n; };
const Z = (n) => zh[n] || zh[canon(n)] || n;

// 队→组
const team2grp = {};
for (const [gk, ts] of Object.entries(groups)) for (const t of ts) team2grp[t] = gk;

// 只保留两队同组的对局(小组赛)
const grpMatches = {};
for (const m of R) {
  const h = canon(m.home), a = canon(m.away);
  const gh = team2grp[h], ga = team2grp[a];
  if (!gh || gh !== ga) continue; // 跨组=淘汰赛或非分组,跳过
  (grpMatches[gh] ||= []).push({ ...m, h, a });
}

function standings(gk) {
  const tbl = {};
  for (const t of groups[gk]) tbl[t] = { t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 };
  for (const m of (grpMatches[gk] || [])) {
    if (!m.completed || m.homeGoals == null || m.awayGoals == null) continue;
    const H = tbl[m.h], A = tbl[m.a]; if (!H || !A) continue;
    H.P++; A.P++; H.GF += m.homeGoals; H.GA += m.awayGoals; A.GF += m.awayGoals; A.GA += m.homeGoals;
    if (m.homeGoals > m.awayGoals) { H.W++; A.L++; H.Pts += 3; }
    else if (m.homeGoals < m.awayGoals) { A.W++; H.L++; A.Pts += 3; }
    else { H.D++; A.D++; H.Pts++; A.Pts++; }
  }
  return Object.values(tbl).sort((x, y) => y.Pts - x.Pts || (y.GF - y.GA) - (x.GF - x.GA) || y.GF - x.GF || Z(x.t).localeCompare(Z(y.t)));
}

const rankOf = (rows, t) => rows.findIndex((r) => r.t === t) + 1;
console.log("████ 世界杯小组赛·当前积分 + 下一场胜平负情景 (2026-06-22实时) ████");
console.log(`数据:ESPN正赛真实赛果 ${R.filter((m) => m.completed).length}场完赛/${R.length}场;每组取4队循环\n`);

for (const gk of Object.keys(groups)) {
  const rows = standings(gk);
  const played = (grpMatches[gk] || []).filter((m) => m.completed).length;
  console.log(`━━━━━ ${gk}组 (已踢${played}/6场) ━━━━━`);
  console.log("名次 队伍        赛 胜平负  进失  净   积分");
  rows.forEach((r, i) => console.log(` ${i + 1}  ${Z(r.t).padEnd(8)} ${r.P}  ${r.W}-${r.D}-${r.L}  ${r.GF}-${r.GA}  ${(r.GF - r.GA >= 0 ? "+" : "") + (r.GF - r.GA)}   ${r.Pts}`));
  // 每队下一场
  const upcoming = (grpMatches[gk] || []).filter((m) => !m.completed);
  if (!upcoming.length) { console.log("  ✅ 本组小组赛已全部结束\n"); continue; }
  // 去重剩余对局
  const rem = []; const seen = new Set();
  for (const m of upcoming) { const k = [m.h, m.a].sort().join("|"); if (seen.has(k)) continue; seen.add(k); rem.push(m); }

  // 末轮(剩2场·4队各剩1场)→ 穷举9种组合算出线
  const base = {}; for (const r of rows) base[r.t] = { Pts: r.Pts, GD: r.GF - r.GA, GF: r.GF };
  if (rem.length === 2) {
    const apply = (m, o) => { // o: H/D/A
      const d = { [m.h]: { dp: 0, dgd: 0, dgf: 0 }, [m.a]: { dp: 0, dgd: 0, dgf: 0 } };
      if (o === "H") { d[m.h].dp = 3; d[m.h].dgd = 1; d[m.h].dgf = 1; d[m.a].dgd = -1; }
      else if (o === "A") { d[m.a].dp = 3; d[m.a].dgd = 1; d[m.a].dgf = 1; d[m.h].dgd = -1; }
      else { d[m.h].dp = 1; d[m.a].dp = 1; }
      return d;
    };
    const [m1, m2] = rem;
    const outs = ["H", "D", "A"];
    // 每队 → 它在自己那场的结果 → 在另一场3种结果下出线次数
    const teamMatch = {}; for (const t of groups[gk]) teamMatch[t] = rem.find((m) => m.h === t || m.a === t);
    const qualifyCount = {}; // qualifyCount[team][selfResultLabel] = {q:出线次数, total:3}
    for (const t of groups[gk]) qualifyCount[t] = {};
    for (const o1 of outs) for (const o2 of outs) {
      const fin = {}; for (const t of groups[gk]) fin[t] = { t, Pts: base[t].Pts, GD: base[t].GD, GF: base[t].GF };
      for (const [m, o] of [[m1, o1], [m2, o2]]) { const d = apply(m, o); for (const t of Object.keys(d)) { fin[t].Pts += d[t].dp; fin[t].GD += d[t].dgd; fin[t].GF += d[t].dgf; } }
      const rank = Object.values(fin).sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF);
      const top2 = new Set([rank[0].t, rank[1].t]);
      const third = rank[2].t;
      for (const t of groups[gk]) {
        const myM = teamMatch[t]; const myO = myM === m1 ? o1 : o2;
        const lbl = (myM.h === t) ? (myO === "H" ? "胜" : myO === "D" ? "平" : "负") : (myO === "A" ? "胜" : myO === "D" ? "平" : "负");
        const q = qualifyCount[t][lbl] || { q: 0, t3: 0, n: 0 }; q.n++; if (top2.has(t)) q.q++; else if (third === t) q.t3++; qualifyCount[t][lbl] = q;
      }
    }
    console.log("  ── 末轮 胜/平/负 → 出线推演(穷举另一场3种结果)──");
    for (const t of rows.map((r) => r.t)) {
      const myM = teamMatch[t]; const opp = myM.h === t ? myM.a : myM.h;
      const verdict = (lbl) => { const q = qualifyCount[t][lbl]; if (!q) return "—"; if (q.q === q.n) return "✅出线锁定"; if (q.q === 0 && q.t3 === 0) return "❌出局"; if (q.q === 0 && q.t3 > 0) return `第3名(看最佳第三)`; return `出线${q.q}/${q.n}(看另一场)`; };
      console.log(`  • ${Z(t)} 末轮 vs ${Z(opp)} [${myM.date}]:  胜→${verdict("胜")} ｜ 平→${verdict("平")} ｜ 负→${verdict("负")}`);
    }
  } else {
    for (const m of rem) { const ph = base[m.h].Pts, pa = base[m.a].Pts; console.log(`  • ${Z(m.h)}(${ph}分) vs ${Z(m.a)}(${pa}分) [${m.date}]: ${Z(m.h)}胜→${ph + 3}/平→${ph + 1}/负→${ph} · ${Z(m.a)}胜→${pa + 3}/平→${pa + 1}/负→${pa}`); }
  }
  console.log("");
}
console.log("出线规则:每组前2直接出线,12个小组第3名里成绩最好的8个也出线(共32队进淘汰赛)。");
console.log("⚠️ 具体淘汰赛(R32)对手依赖全部小组最终名次+最佳第三名排序,小组赛未踢完前无法确定;本表给当前积分与下一场各结果后的积分形势,出线/淘汰随之推。");
