#!/usr/bin/env node
/**
 * 回填 ESPN 历史首发阵型 + 赛果,用于验证 lineup 信号增益(leak-safe 回测的数据底座)。
 * ESPN summary 对历史完赛比赛仍保留 rosters[].formation(实测 2 个月前 6/6 保留)。
 * 用法:
 *   npm run backfill:formations -- --from 2026-01-01 --to 2026-05-31
 *   npm run backfill:formations -- --from 2026-03-01 --to 2026-05-31 --leagues jpn.1,kor.1,usa.1
 * 断点续抓:已抓 event 跳过(缓存按 eventId 去重)。缓存写 D:\football-model-data\formations\espn-formations.json(repo 外)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ESPN_LEAGUES, monthRanges } from "../src/espn-results-source.js";
import { normalizeEspnLineup } from "../src/lineup-source.js";
import { getDataSubdir } from "../src/paths.js";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

const args = process.argv.slice(2);
const getStr = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const from = getStr("--from") ?? "2026-01-01";
const to = getStr("--to") ?? new Date().toISOString().slice(0, 10);
const leagues = (getStr("--leagues") ?? Object.keys(ESPN_LEAGUES).join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const dir = getDataSubdir("formations");
mkdirSync(dir, { recursive: true });
const cachePath = join(dir, "espn-formations.json");
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : { records: {} };
const before = Object.keys(cache.records).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (iso) => iso.slice(0, 10);
const fromM = `${from.slice(0, 7)}`;
const toM = `${to.slice(0, 7)}`;

let added = 0, skipped = 0, noForm = 0;
for (const lg of leagues) {
  const ranges = monthRanges(`${fromM}-01`, `${toM}-01`);
  for (const range of ranges) {
    let sb;
    try {
      const r = await fetch(`${BASE}/${lg}/scoreboard?dates=${range}`, { headers: UA });
      if (!r.ok) continue;
      sb = await r.json();
    } catch { continue; }
    const done = (sb?.events ?? []).filter((e) => e?.status?.type?.completed);
    for (const ev of done) {
      const date = ymd(String(ev.date));
      if (date < from || date > to) continue;
      if (cache.records[ev.id]) { skipped++; continue; }
      const comp = ev.competitions?.[0];
      const cs = comp?.competitors ?? [];
      const home = cs.find((c) => c.homeAway === "home");
      const away = cs.find((c) => c.homeAway === "away");
      const hg = Number(home?.score), ag = Number(away?.score);
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      let lineup = null;
      try {
        const s = await (await fetch(`${BASE}/${lg}/summary?event=${ev.id}`, { headers: UA })).json();
        lineup = normalizeEspnLineup(s);
      } catch { /* skip */ }
      await sleep(120);
      const hF = lineup?.home?.formation, aF = lineup?.away?.formation;
      if (!hF || !aF) { noForm++; continue; }
      cache.records[ev.id] = {
        league: lg, date,
        homeTeam: home.team?.displayName, awayTeam: away.team?.displayName,
        homeFormation: hF, awayFormation: aF,
        homeGoals: hg, awayGoals: ag,
        result: hg > ag ? "home" : hg < ag ? "away" : "draw"
      };
      added++;
      if (added % 50 === 0) { writeFileSync(cachePath, JSON.stringify(cache, null, 0), "utf8"); process.stdout.write(`\r已抓 ${added} 场(${lg} ${range})...`); }
    }
  }
  console.log(`\n[${lg}] 累计 added ${added} / skipped ${skipped} / noForm ${noForm}`);
}
writeFileSync(cachePath, JSON.stringify(cache, null, 0), "utf8");
const after = Object.keys(cache.records).length;
console.log(`\n完成:新增 ${added} 场,缓存共 ${after} 场(此前 ${before})。写入 ${cachePath}`);
