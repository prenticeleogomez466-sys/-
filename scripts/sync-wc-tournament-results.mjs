#!/usr/bin/env node
/**
 * 抓世界杯正赛(fifa.world)真实赛果+赛程(2026-06-22)。
 * 现有 sync-wc-national-results 只抓友谊/预选(窗口到6/11),不含正赛本身→小组赛积分缺。
 * 本脚本补正赛:ESPN fifa.world scoreboard 6/11→7/19,落 wc-tournament-results.json(完赛+待赛)。
 * 免费无key。供 wc-group-scenarios.mjs 算当前积分+出线情景。
 */
import fs from "node:fs";
const OUT = "D:/football-model-data/world-cup/2026/wc-tournament-results.json";
const dates = [];
for (let m = 6; m <= 7; m++) for (let d = 1; d <= 31; d++) { if (m === 6 && d < 11) continue; if (m === 7 && d > 19) continue; dates.push(`2026${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`); }
const out = [];
for (const d of dates) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${d}`);
    if (!r.ok) continue;
    const j = await r.json();
    for (const e of (j.events || [])) {
      const comp = e.competitions && e.competitions[0]; if (!comp) continue;
      const cs = comp.competitors || [];
      const home = cs.find((c) => c.homeAway === "home") || cs[0], away = cs.find((c) => c.homeAway === "away") || cs[1];
      if (!home || !away) continue;
      const st = e.status && e.status.type;
      out.push({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, name: e.name,
        home: home.team.displayName, away: away.team.displayName,
        homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation,
        homeGoals: home.score != null && home.score !== "" ? Number(home.score) : null,
        awayGoals: away.score != null && away.score !== "" ? Number(away.score) : null,
        completed: !!(st && st.completed), state: st && st.name,
        note: (comp.notes && comp.notes[0] && comp.notes[0].headline) || null,
      });
    }
  } catch (e) { console.error(d, "ERR", e.message); }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const done = out.filter((m) => m.completed).length;
console.log(`✅ 写 ${OUT}: ${out.length}场(完赛${done}·待赛${out.length - done}),最新完赛日 ${out.filter((m) => m.completed).map((m) => m.date).sort().at(-1) || "—"}`);
