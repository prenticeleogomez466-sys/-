#!/usr/bin/env node
/**
 * 世界杯单场大小球(totals)真实盘口同步 —— 补齐 0609 论证的免费缺口:
 * "大小球WC单场=The Odds API totals(加markets即得)"(reference_match_coverage_fillable_sources_2026-06-09)。
 * 此前大小球列只有模型概率无市场锚;本步拉真实 totals 盘(优先 Pinnacle/Betfair,否则首家),
 * 比例法 de-vig 成 P(大球),落 match-totals.json 供生成器/世界杯模型做市场锚。
 * 遵 no-fabrication:拉不到=保留旧档并如实标注 stale;某场无盘=不写该场,不臆造。
 * 用法: node scripts/sync-wc-totals.mjs [--dry]
 */
import "../src/env.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchOddsApiRotating } from "../src/odds-api-rotation.js";

const DRY = process.argv.includes("--dry");
const OUT = "D:/football-model-data/world-cup/2026/match-totals.json";

const rot = await fetchOddsApiRotating(
  (key) => `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds?apiKey=${key}&regions=eu,uk,us&markets=totals&oddsFormat=decimal`,
  { timeoutMs: 40000 },
);
if (!rot.ok) {
  console.log(`拉取失败(${rot.error}) → ${existsSync(OUT) ? "保留旧档(stale,如实标注)" : "无档可退,本次无 totals"}`);
  process.exit(0); // 可选源,不红整条链;新鲜度由消费方/探针看 updatedAt 决断
}
const events = await rot.response.json();
const fixtures = [];
for (const ev of events) {
  // 选最锐盘源:Pinnacle > Betfair 交易所 > 首家
  const bks = ev.bookmakers ?? [];
  const bk = bks.find((b) => /pinnacle/i.test(b.key)) ?? bks.find((b) => /betfair/i.test(b.key)) ?? bks[0];
  const totals = bk?.markets?.find((m) => m.key === "totals");
  if (!totals?.outcomes?.length) continue;
  // 按盘口线分组,取主线(离 2.5 最近;同距取盘水最均衡的)
  const byLine = new Map();
  for (const o of totals.outcomes) {
    const line = Number(o.point);
    if (!byLine.has(line)) byLine.set(line, {});
    byLine.get(line)[o.name === "Over" ? "over" : "under"] = Number(o.price);
  }
  const lines = [...byLine.entries()].filter(([, v]) => v.over > 1.01 && v.under > 1.01);
  if (!lines.length) continue;
  lines.sort((a, b) => Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5) || Math.abs(a[1].over - a[1].under) - Math.abs(b[1].over - b[1].under));
  const [line, odds] = lines[0];
  const io = 1 / odds.over, iu = 1 / odds.under;
  fixtures.push({
    home: ev.home_team, away: ev.away_team, commenceTime: ev.commence_time,
    book: bk.key, line,
    over: odds.over, under: odds.under,
    pOver: Number((io / (io + iu)).toFixed(4)), // 比例法de-vig(Power已证伪勿换,见0607裁决)
    overround: Number((io + iu).toFixed(4)),
    allLines: lines.map(([l, v]) => ({ line: l, over: v.over, under: v.under })),
  });
}
const doc = {
  updatedAt: new Date().toISOString(),
  source: "The Odds API soccer_fifa_world_cup totals(Pinnacle>Betfair>首家,8key池轮换)",
  remaining: rot.remaining ?? null,
  count: fixtures.length,
  fixtures,
};
if (DRY) console.log(JSON.stringify(doc, null, 1).slice(0, 2000));
else { writeFileSync(OUT, JSON.stringify(doc, null, 1)); console.log(`✅ ${fixtures.length}场 totals 已落 ${OUT}(剩余配额${rot.remaining ?? "?"}${rot.keyIndex > 0 ? `,key#${rot.keyIndex + 1}` : ""})`); }
for (const f of fixtures.slice(0, 6)) console.log(`  ${f.home} v ${f.away} 主线${f.line} 大${f.over}/小${f.under} P(大)=${(f.pOver * 100).toFixed(1)}% [${f.book}]`);
