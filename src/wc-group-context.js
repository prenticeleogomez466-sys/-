// 世界杯【小组积分 + 面临问题】统一情景模块(2026-06-22 用户:每次分析都加进推荐表)。
// ════════════════════════════════════════════════════════════════════════════════════════
// 铁律 no-fallback:只用真实赛果(ESPN fifa.world 正赛,wc-tournament-results.json),绝不编造未踢场。
// 纯计算层(computeGroupContext / teamStandingLine / teamProblemLine)零 IO,可单测;
// loadWcGroupContext() 为薄 IO 加载器(读 groups.json + wc-tournament-results.json,英文名→中文)。
// 复用 wc-group-standings.groupTable / wc-qualification-scenario.finalRoundScenario(已建,2026-06-19)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { groupTable, remainingPairs } from "./wc-group-standings.js";
import { finalRoundScenario } from "./wc-qualification-scenario.js";

// ESPN displayName → groups.json 英文规范名(只补不同名的)
const ESPN_ALIAS = {
  "South Korea": "Korea Republic", "Bosnia-Herzegovina": "Bosnia and Herzegovina", Bosnia: "Bosnia and Herzegovina",
  "Türkiye": "Turkiye", Turkey: "Turkiye", "Curaçao": "Curacao", "Congo DR": "DR Congo", "Cape Verde": "Cabo Verde",
  "Ivory Coast": "Côte d'Ivoire", USA: "United States", "Czech Republic": "Czechia",
};

/**
 * 纯计算:由分组(中文队名)+真实赛果(中文队名)建12组积分榜+队→组索引+剩余场。
 * @param {{groupsZh:Record<string,string[]>, results:Array<{home,away,ga,gb}>}} inp  results 中文名·ga/gb=主/客进球
 */
export function computeGroupContext({ groupsZh, results }) {
  const byGroup = {}, teamGroup = {}, remTeam = {};
  for (const [g, teams] of Object.entries(groupsZh)) for (const t of teams) teamGroup[t] = g;
  for (const [g, teams] of Object.entries(groupsZh)) {
    const gm = results.filter((m) => teams.includes(m.home) && teams.includes(m.away) && m.ga != null && m.gb != null);
    const rem = remainingPairs(teams, gm);
    byGroup[g] = { teams, table: groupTable(teams, gm), playedN: gm.length, remPairs: rem };
    const rc = {}; for (const t of teams) rc[t] = 0;
    for (const [x, y] of rem) { rc[x]++; rc[y]++; }
    for (const t of teams) remTeam[t] = rc[t];
  }
  return { byGroup, teamGroup, remTeam };
}

/** 某队当前积分榜单行文字:'H组第1 · 2胜1平 · 进4失0净+4 · 7分'。无组/无数据→null。 */
export function teamStandingLine(ctx, teamZh) {
  const g = ctx.teamGroup[teamZh]; if (!g) return null;
  const tbl = ctx.byGroup[g].table; const i = tbl.findIndex((r) => r.team === teamZh); if (i < 0) return null;
  const r = tbl[i];
  return `${g}组第${i + 1} · ${r.w}胜${r.d}平${r.l}负 · 进${r.gf}失${r.ga}净${r.gd >= 0 ? "+" : ""}${r.gd} · ${r.pts}分`;
}

/**
 * 某队"面临的问题/出线形势"。末轮(剩1场)→精确穷举对手那一侧3结果给"胜/平/负→出线锁定/看末轮/出局";
 * 非末轮→给当前位次形势。已踢完→已出线/已淘汰/小组第N。纯文字,透明观察不改概率。
 */
export function teamProblemLine(ctx, teamZh) {
  const g = ctx.teamGroup[teamZh]; if (!g) return null;
  const gx = ctx.byGroup[g]; const tbl = gx.table; const teams = gx.teams;
  const rem = ctx.remTeam[teamZh];
  if (rem === 0) {
    const pos = tbl.findIndex((r) => r.team === teamZh) + 1;
    return pos <= 2 ? `已踢完·小组第${pos}(前2直接出线)` : `已踢完·小组第${pos}(需看最佳第三名)`;
  }
  // 找该队剩余对手(末轮取唯一)
  const myRem = gx.remPairs.filter((p) => p.includes(teamZh)).map((p) => (p[0] === teamZh ? p[1] : p[0]));
  if (rem === 1 && gx.playedN >= 4) {
    // 末轮:穷举"另一场"3结果(另一场=本组另两队的对决)
    const opp = myRem[0];
    const others = teams.filter((t) => t !== teamZh && t !== opp);
    const otherMatch = others.length === 2 ? others : null;
    const sc = finalRoundScenario(tbl, teamZh, opp, 2); // {win,draw,lose} 自身结果→是否稳出线(不含另一场)
    // 自身胜/平/负 后,穷举另一场3结果统计出线次数(精确)
    const base = {}; for (const r of tbl) base[r.team] = { team: r.team, pts: r.pts, gd: r.gd, gf: r.gf };
    const apply = (st, A, B) => { const d = { [A]: { p: 0, gd: 0, gf: 0 }, [B]: { p: 0, gd: 0, gf: 0 } }; if (st === "W") { d[A] = { p: 3, gd: 1, gf: 1 }; d[B].gd = -1; } else if (st === "L") { d[B] = { p: 3, gd: 1, gf: 1 }; d[A].gd = -1; } else { d[A].p = 1; d[B].p = 1; } return d; };
    const verdict = (selfSt) => {
      if (!otherMatch) return sc?.[selfSt === "W" ? "win" : selfSt === "D" ? "draw" : "lose"]?.qualifies ? "出线" : "看末轮";
      let q = 0, third = 0;
      for (const oSt of ["W", "D", "L"]) {
        const fin = {}; for (const t of teams) fin[t] = { team: t, pts: base[t].pts, gd: base[t].gd, gf: base[t].gf };
        for (const [st, A, B] of [[selfSt, teamZh, opp], [oSt, otherMatch[0], otherMatch[1]]]) { const dd = apply(st, A, B); for (const t of Object.keys(dd)) { fin[t].pts += dd[t].p; fin[t].gd += dd[t].gd; fin[t].gf += dd[t].gf; } }
        const rank = Object.values(fin).sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf);
        if (rank[0].team === teamZh || rank[1].team === teamZh) q++; else if (rank[2].team === teamZh) third++;
      }
      return q === 3 ? "✅出线锁定" : q === 0 && third === 0 ? "❌出局" : q === 0 ? "第3名(看最佳第三)" : `出线${q}/3(看另一场)`;
    };
    return `末轮vs${opp}:胜→${verdict("W")}｜平→${verdict("D")}｜负→${verdict("L")}`;
  }
  // 非末轮(还剩2场)
  const pos = tbl.findIndex((r) => r.team === teamZh) + 1;
  return `还剩${rem}场·当前小组第${pos}(踢完${gx.playedN}/6场)·下一场vs${myRem.join("/")}`;
}

/** 一场比赛的双队情景 cell(供推荐表)。 */
export function matchGroupCell(ctx, homeZh, awayZh) {
  const parts = [];
  for (const t of [homeZh, awayZh]) {
    const s = teamStandingLine(ctx, t), p = teamProblemLine(ctx, t);
    if (s) parts.push(`${t}:${s}${p ? "｜" + p : ""}`);
  }
  return parts.length ? parts.join("\n") : null;
}

/** IO:读 groups.json + wc-tournament-results.json(真实ESPN正赛)→ context。无结果文件→results空(标缺不编)。 */
export function loadWcGroupContext() {
  const dir = join(getDataSubdir("world-cup"), "2026");
  const gdoc = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
  const zh = gdoc.team_name_zh || {};
  const groupsZh = {}; for (const [g, ens] of Object.entries(gdoc.groups)) groupsZh[g] = ens.map((e) => zh[e] || e);
  const canonEn = (n) => { const flat = Object.values(gdoc.groups).flat(); if (flat.includes(n)) return n; if (ESPN_ALIAS[n] && flat.includes(ESPN_ALIAS[n])) return ESPN_ALIAS[n]; const hit = flat.find((t) => t.toLowerCase().replace(/[^a-z]/g, "") === n.toLowerCase().replace(/[^a-z]/g, "")); return hit || n; };
  let raw = [];
  try { raw = JSON.parse(readFileSync(join(dir, "wc-tournament-results.json"), "utf8")); } catch { raw = []; }
  const results = [];
  for (const m of raw) {
    if (!m.completed || m.homeGoals == null || m.awayGoals == null) continue;
    const h = zh[canonEn(m.home)] || m.home, a = zh[canonEn(m.away)] || m.away;
    results.push({ home: h, away: a, ga: m.homeGoals, gb: m.awayGoals });
  }
  return { ...computeGroupContext({ groupsZh, results }), resultsN: results.length };
}
