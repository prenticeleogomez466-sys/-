/**
 * 历史 fixtures 回填器
 * ──────────────────────────────────────────────────
 * 从 openfootball + StatsBomb open-data 加载历史比赛 → 写入 fixture-store,
 * 给 DC / Pi / Massey / Colley / Bivariate / Hier / MCMC 提供训练样本.
 *
 * 注:fixture-store 按日期分文件,这里把不同源的同日比赛合并写入.
 *      跳过已存在的 fixture(避免覆盖 daily 抓取的实时数据).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, loadFixtures, saveFixtures } from "./fixture-store.js";
import { loadOpenFootballMatches } from "./openfootball-loader.js";
import { loadStatsbombSeasonForTraining } from "./statsbomb-loader.js";

/**
 * 回填指定时间窗口的历史数据.
 * @param {Object} opts
 *   leagues, seasons (openfootball)
 *   statsbombComps: [{ competitionId, seasonId }]
 *   limitDays: 最多回填多少日(default 365)
 */
export async function backfillHistorical(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const leagues = opts.leagues ?? ["en.1", "es.1", "de.1", "it.1", "fr.1"];
  const seasons = opts.seasons ?? ["2024-25", "2023-24"];
  const statsbombComps = opts.statsbombComps ?? [
    { competitionId: 43, seasonId: 3 },     // 2018 World Cup
    { competitionId: 43, seasonId: 106 },   // 2022 World Cup
    { competitionId: 16, seasonId: 4 }      // 2018-19 Champions League
  ];

  const summary = { openfootball: 0, statsbomb: 0, written: 0, skipped: 0 };
  const allMatches = [];

  // 1. OpenFootball
  if (opts.includeOpenfootball !== false) {
    const of = await loadOpenFootballMatches(leagues, seasons, { fetch: fetchImpl });
    if (of.ok) {
      summary.openfootball = of.matches.length;
      for (const m of of.matches) {
        allMatches.push({
          home: m.home,
          away: m.away,
          homeGoals: m.homeGoals,
          awayGoals: m.awayGoals,
          date: m.date,
          league: m.league,
          source: "openfootball"
        });
      }
    }
  }

  // 2. StatsBomb
  if (opts.includeStatsbomb !== false) {
    for (const { competitionId, seasonId } of statsbombComps) {
      try {
        const sb = await loadStatsbombSeasonForTraining(competitionId, seasonId, { fetch: fetchImpl });
        if (sb.ok) {
          summary.statsbomb += sb.trainingRows.length;
          for (const r of sb.trainingRows) {
            allMatches.push({ ...r, source: "statsbomb" });
          }
        }
      } catch { /* graceful skip */ }
    }
  }

  // 3. 按日期分组写入 fixture-store
  const byDate = new Map();
  for (const m of allMatches) {
    if (!m.date) continue;
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }

  for (const [date, matches] of byDate.entries()) {
    const existing = loadFixtures(date);
    // 已经有 daily 抓取的数据 → 跳过(避免覆盖)
    if (existing.fixtures.length > 0 && existing.source !== "historical-backfill") {
      summary.skipped += matches.length;
      continue;
    }
    const fixtures = matches.map((m, i) => ({
      id: `bf-${date}-${i}-${normalizeName(m.home)}-${normalizeName(m.away)}`,
      sequence: String(i + 1),
      date,
      homeTeam: m.home,
      awayTeam: m.away,
      competition: m.league,
      marketType: "historical",
      kickoff: `${date}T12:00:00+08:00`,
      result: { home: m.homeGoals, away: m.awayGoals },
      source: m.source
    }));
    saveFixtures(date, fixtures, { source: "historical-backfill" });
    summary.written += fixtures.length;
  }

  return summary;
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
}
