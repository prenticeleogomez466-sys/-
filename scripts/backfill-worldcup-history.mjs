#!/usr/bin/env node
/**
 * 历史世界杯赛果回填(OpenFootball 免费静态源,零授权、过夜可抓)。
 * 目的:库内国家队/世界杯样本仅 ~128 场,world-cup-priors 的海拔/淘汰赛/Elo 乘子
 *   长期"全是先验、无数据验证"(见 project-worldcup-evolution TODO)。回填历届真实
 *   世界杯赛果(含半场比分 ht + 球场 ground + 阶段 round)→ 世界杯专项回测可校准这些乘子,
 *   把金字塔闭环的"验证环"补到世界杯维度。
 *
 * 数据真实性(遵 feedback-no-fabrication-live-only):全部来自 OpenFootball 公开 JSON,
 *   逐场 team1/team2/score.ft/score.ht/group/round/ground 原样落盘;球队名经 team-aliases
 *   转中文 canonical,未覆盖的保留英文原名(不强转、不编造)。
 *
 * 用法: node scripts/backfill-worldcup-history.mjs [--years 2010,2014,2018,2022]
 */
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";

const BASE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master";
const DEFAULT_YEARS = [2006, 2010, 2014, 2018, 2022];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function inferStage(round, group) {
  const r = String(round || "").toLowerCase();
  if (group || /matchday|group/.test(r)) return "group";
  if (/round of 16|last 16|achtelfinale/.test(r)) return "r16";
  if (/quarter/.test(r)) return "qf";
  if (/semi/.test(r)) return "sf";
  if (/third|3rd|play-?off for third/.test(r)) return "third";
  if (/final/.test(r)) return "final";
  return "knockout";
}

function canon(name) {
  const c = canonicalTeamName(name);
  return c || name; // 未覆盖保留英文,不编造
}

async function fetchYear(year) {
  const url = `${BASE}/${year}/worldcup.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = [];
  for (const m of j.matches || []) {
    const ft = m.score?.ft;
    if (!Array.isArray(ft) || ft.length < 2) continue; // 无终场比分→跳过(不编造)
    if (!Number.isFinite(Number(ft[0])) || !Number.isFinite(Number(ft[1]))) continue;
    if (!m.team1 || !m.team2 || !m.date) continue;
    const ht = Array.isArray(m.score?.ht) ? m.score.ht : null;
    out.push({
      date: m.date,
      home: canon(m.team1),
      away: canon(m.team2),
      homeGoals: Number(ft[0]),
      awayGoals: Number(ft[1]),
      halfHome: ht && Number.isFinite(Number(ht[0])) ? Number(ht[0]) : null,
      halfAway: ht && Number.isFinite(Number(ht[1])) ? Number(ht[1]) : null,
      stage: inferStage(m.round, m.group),
      group: m.group ?? null,
      venue: m.ground ?? null,
      year,
    });
  }
  return out;
}

async function main() {
  const years = arg("--years", DEFAULT_YEARS.join(",")).split(",").map((s) => Number(s.trim())).filter(Boolean);
  const all = [];
  for (const y of years) {
    try {
      const ms = await fetchYear(y);
      console.log(`世界杯 ${y}: ${ms.length} 场`);
      all.push(...ms);
    } catch (e) {
      console.log(`世界杯 ${y}: 抓取失败 ${e.message}(跳过,不编造)`);
    }
  }
  // 去重 + 按日期分组
  const seen = new Set();
  const byDate = new Map();
  for (const m of all) {
    const key = `${m.date}|${m.home}|${m.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  let written = 0, skipped = 0;
  for (const [date, matches] of byDate.entries()) {
    const existing = loadFixtures(date);
    // 不覆盖真实 daily 抓取数据;允许覆盖自己(重跑幂等)。
    if (existing.fixtures.length > 0 && !["worldcup-history", "historical-backfill"].includes(existing.source)) {
      skipped += matches.length;
      continue;
    }
    const fixtures = matches.map((m, i) => ({
      id: `wc-${m.year}-${date}-${i}`,
      sequence: String(i + 1),
      date,
      homeTeam: m.home,
      awayTeam: m.away,
      competition: `世界杯${m.year}`,
      marketType: "historical",
      kickoff: `${date}T12:00:00+08:00`,
      // normalizeFixture 用字段白名单,自定义对象会被剥掉 → 把世界杯维度塞进保留字段:
      //   round=阶段、tags=[worldcup,wcYYYY,组]、notes=球场。competition 已含年份。
      round: m.stage,
      tags: ["worldcup", `wc${m.year}`, ...(m.group ? [m.group] : [])],
      notes: m.venue || "",
      result: { home: m.homeGoals, away: m.awayGoals, halfHome: m.halfHome, halfAway: m.halfAway },
      source: "worldcup-history",
    }));
    saveFixtures(date, fixtures, { source: "worldcup-history" });
    written += fixtures.length;
  }
  console.log(`\n回填完成: 写入 ${written} 场 / 跳过(已有真实数据)${skipped} 场 / 覆盖 ${byDate.size} 个比赛日`);
  // 阶段分布(供世界杯回测参考)
  const stages = {};
  for (const m of all) stages[m.stage] = (stages[m.stage] || 0) + 1;
  console.log("阶段分布:", JSON.stringify(stages));
  const withHt = all.filter((m) => m.halfHome != null).length;
  console.log(`含半场比分: ${withHt}/${all.length}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
