// 世界杯【小组积分榜 + 末轮胜/平/负→出线情景 + 逐场赛果/对战】结构化引擎(2026-06-25 建)。
// ════════════════════════════════════════════════════════════════════════════════════════
// 铁律 no-fallback:只用真实已结算赛果(wc-tournament-results.json·ESPN fifa.world 正赛抓取),
//   绝不编造未踢场比分。末轮(剩2场)出线=穷举另一场3种结果的真实推演,不是估值。
// 本模块是 scripts/wc-group-scenarios.mjs 的纯函数化复用层:CLI 打印与交付出表共用同一逻辑,
//   保证终端、xlsx 专表、手机页三处同源同口径。
//
// 排序口径:积分 → 净胜球 → 进球数(本快照层到进球数,够用且诚实;FIFA 同分还看相互战绩/纪律分)。
// 出线规则:每组前2直接出线 + 12 个小组第3名里成绩最好的8个出线(共32队进淘汰赛)。
//   单组内无法独判第三能否出线(要跨组比),故第三名只标"第3名(看最佳第三)"。

import fs from "node:fs";

const DATA_DIR = "D:/football-model-data/world-cup/2026";

// ESPN/赛程里出现的队名 → groups.json 规范名 别名表(与 wc-group-scenarios.mjs 一致)
const ALIAS = {
  "South Korea": "Korea Republic", "Bosnia-Herzegovina": "Bosnia and Herzegovina", "Bosnia": "Bosnia and Herzegovina",
  "Türkiye": "Turkiye", "Turkey": "Turkiye", "Curaçao": "Curacao", "Congo DR": "DR Congo", "DR Congo": "DR Congo",
  "Cape Verde": "Cabo Verde", "Ivory Coast": "Côte d'Ivoire", "USA": "United States", "Czech Republic": "Czechia"
};

function makeCanon(groups) {
  const flat = Object.values(groups).flat();
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
  return (n) => {
    if (flat.includes(n)) return n;
    if (ALIAS[n] && flat.includes(ALIAS[n])) return ALIAS[n];
    const hit = flat.find((t) => norm(t) === norm(n));
    return hit || n;
  };
}

/** 读真实数据(分组+赛果)。可注入路径便于测试。 */
export function loadWcRaw({ groupsPath = `${DATA_DIR}/groups.json`, resultsPath = `${DATA_DIR}/wc-tournament-results.json` } = {}) {
  const G = JSON.parse(fs.readFileSync(groupsPath, "utf8"));
  const R = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  return { G, R };
}

/** 一组积分榜(英文规范名内部用,展示名走 Z())。 */
function standings(teams, grpMatches, Z) {
  const tbl = {};
  for (const t of teams) tbl[t] = { t, name: Z(t), P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 };
  for (const m of grpMatches) {
    if (!m.completed || m.homeGoals == null || m.awayGoals == null) continue;
    const H = tbl[m.h], A = tbl[m.a];
    if (!H || !A) continue;
    H.P++; A.P++; H.GF += m.homeGoals; H.GA += m.awayGoals; A.GF += m.awayGoals; A.GA += m.homeGoals;
    if (m.homeGoals > m.awayGoals) { H.W++; A.L++; H.Pts += 3; }
    else if (m.homeGoals < m.awayGoals) { A.W++; H.L++; A.Pts += 3; }
    else { H.D++; A.D++; H.Pts++; A.Pts++; }
  }
  return Object.values(tbl)
    .map((r) => ({ ...r, GD: r.GF - r.GA }))
    .sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.name.localeCompare(y.name, "zh"));
}

/**
 * 计算全部 12 组的:当前积分榜 + 已踢赛果 + 剩余对阵 + 末轮(剩2场)逐队胜/平/负→出线推演。
 * @returns { asOf, completedCount, totalCount, groups:[{ key, played, complete, rows, results, upcoming, scenarios }] }
 *   rows:    [{ rank, team(英文), name(中文), P,W,D,L,GF,GA,GD,Pts }]
 *   results: [{ date, home(中), away(中), hg, ag }]  已踢的组内对阵(=对战数据/交锋)
 *   upcoming:[{ date, home(中), away(中) }]            未踢的组内对阵
 *   scenarios: 仅末轮(剩2场)给 [{ team(中), opp(中), date, win, draw, lose }];否则 null(只给积分形势)
 */
export function computeWcScenarios(opts = {}) {
  const { G, R } = opts.raw ?? loadWcRaw(opts);
  const groups = G.groups;
  const zh = G.team_name_zh || {};
  const canon = makeCanon(groups);
  const Z = (n) => zh[n] || zh[canon(n)] || n;

  const team2grp = {};
  for (const [gk, ts] of Object.entries(groups)) for (const t of ts) team2grp[t] = gk;

  // 只保留两队同组的对局(=小组赛),跨组=淘汰赛/占位,跳过
  const grpMatches = {};
  for (const m of R) {
    const h = canon(m.home), a = canon(m.away);
    const gh = team2grp[h], ga = team2grp[a];
    if (!gh || gh !== ga) continue;
    (grpMatches[gh] ||= []).push({ ...m, h, a });
  }

  const completedAll = R.filter((m) => m.completed);
  const asOf = completedAll.map((m) => m.date).sort().slice(-1)[0] ?? null;

  const out = { asOf, completedCount: completedAll.length, totalCount: R.length, groups: [] };

  for (const gk of Object.keys(groups)) {
    const ms = grpMatches[gk] || [];
    const rows = standings(groups[gk], ms, Z).map((r, i) => ({ ...r, rank: i + 1 }));
    const played = ms.filter((m) => m.completed).length;
    const results = ms.filter((m) => m.completed).map((m) => ({ date: m.date, home: Z(m.h), away: Z(m.a), hg: m.homeGoals, ag: m.awayGoals }));
    const upcomingAll = ms.filter((m) => !m.completed);
    // 去重剩余对局
    const rem = []; const seen = new Set();
    for (const m of upcomingAll) { const k = [m.h, m.a].sort().join("|"); if (seen.has(k)) continue; seen.add(k); rem.push(m); }
    const upcoming = rem.map((m) => ({ date: m.date, home: Z(m.h), away: Z(m.a) }));

    let scenarios = null;
    if (rem.length === 2) scenarios = lastRoundScenarios(groups[gk], rows, rem, Z);

    out.groups.push({ key: gk, played, complete: rem.length === 0, rows, results, upcoming, scenarios });
  }
  return out;
}

/** 末轮(每队各剩1场·全组剩2场):穷举另一场3种结果,判每队胜/平/负后的出线归属。 */
function lastRoundScenarios(teams, rows, rem, Z) {
  const base = {}; for (const r of rows) base[r.t] = { Pts: r.Pts, GD: r.GD, GF: r.GF };
  const apply = (m, o) => { // o: H(主胜)/D(平)/A(客胜)
    const d = { [m.h]: { dp: 0, dgd: 0, dgf: 0 }, [m.a]: { dp: 0, dgd: 0, dgf: 0 } };
    if (o === "H") { d[m.h].dp = 3; d[m.h].dgd = 1; d[m.h].dgf = 1; d[m.a].dgd = -1; }
    else if (o === "A") { d[m.a].dp = 3; d[m.a].dgd = 1; d[m.a].dgf = 1; d[m.h].dgd = -1; }
    else { d[m.h].dp = 1; d[m.a].dp = 1; }
    return d;
  };
  const [m1, m2] = rem;
  const outs = ["H", "D", "A"];
  const teamMatch = {}; for (const t of teams) teamMatch[t] = rem.find((m) => m.h === t || m.a === t);
  const qc = {}; for (const t of teams) qc[t] = {}; // qc[team][胜/平/负] = {q,t3,n}
  for (const o1 of outs) for (const o2 of outs) {
    const fin = {}; for (const t of teams) fin[t] = { t, Pts: base[t].Pts, GD: base[t].GD, GF: base[t].GF };
    for (const [m, o] of [[m1, o1], [m2, o2]]) {
      const d = apply(m, o);
      for (const t of Object.keys(d)) { fin[t].Pts += d[t].dp; fin[t].GD += d[t].dgd; fin[t].GF += d[t].dgf; }
    }
    const rank = Object.values(fin).sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF);
    const top2 = new Set([rank[0].t, rank[1].t]);
    const third = rank[2].t;
    for (const t of teams) {
      const myM = teamMatch[t]; const myO = myM === m1 ? o1 : o2;
      const lbl = (myM.h === t) ? (myO === "H" ? "胜" : myO === "D" ? "平" : "负") : (myO === "A" ? "胜" : myO === "D" ? "平" : "负");
      const q = qc[t][lbl] || { q: 0, t3: 0, n: 0 }; q.n++;
      if (top2.has(t)) q.q++; else if (third === t) q.t3++;
      qc[t][lbl] = q;
    }
  }
  const verdict = (t, lbl) => {
    const q = qc[t][lbl]; if (!q) return "—";
    if (q.q === q.n) return "✅出线锁定";
    if (q.q === 0 && q.t3 === 0) return "❌出局";
    if (q.q === 0 && q.t3 > 0) return "第3名(看最佳第三)";
    return `出线${q.q}/${q.n}(看另一场)`;
  };
  return rows.map((r) => {
    const t = r.t; const myM = teamMatch[t]; const opp = myM.h === t ? myM.a : myM.h;
    return { team: Z(t), opp: Z(opp), date: myM.date, win: verdict(t, "胜"), draw: verdict(t, "平"), lose: verdict(t, "负") };
  });
}

/**
 * 给定一批"主中文名 vs 客中文名"的对阵,返回 { "主 vs 客": 末轮出线一句话 } 映射,
 * 供竞彩完整逐场行内嵌(只对仍在末轮争夺的世界杯场命中;已收官/非末轮返回空)。
 */
export function buildWcQualByMatch(scen) {
  const map = {};
  for (const g of scen.groups) {
    if (!g.scenarios) continue;
    const byTeam = {}; for (const s of g.scenarios) byTeam[s.team] = s;
    // 该组末轮的两场对阵
    for (const u of g.upcoming) {
      const hs = byTeam[u.home], as = byTeam[u.away];
      if (!hs || !as) continue;
      const line = `🎟️末轮出线｜${u.home}:胜→${hs.win}·平→${hs.draw}·负→${hs.lose} ‖ ${u.away}:胜→${as.win}·平→${as.draw}·负→${as.lose}`;
      map[`${u.home} vs ${u.away}`] = line;
      map[`${u.away} vs ${u.home}`] = line;
    }
  }
  return map;
}
