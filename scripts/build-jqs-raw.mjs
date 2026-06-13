#!/usr/bin/env node
/**
 * build-jqs-raw —— 抓 500 总进球原始赔率(pl_jqs_2.xml,s0..s7)写 market/jqs-raw-<date>.json,
 * 供 today-full-coverage 串关"总进球"腿用(store 只存 de-vig 概率,原始赔率须实抓)。
 * jqs XML 用内部 id,需 pl_spf_2.xml 的 id→matchnum 映射对齐竞彩编号。
 * 用法: node scripts/build-jqs-raw.mjs --date=2026-06-13
 * 缺数据=如实写空 matches(绝不兜底),退出码仍 0(总进球缺=该串关腿不出,不阻断主交付)。
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const readArg = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`) || x === `--${n}`); if (!a) return d; return a.includes("=") ? a.split("=")[1] : args[args.indexOf(a) + 1]; };
const DATE = readArg("date") || new Date().toISOString().slice(0, 10);
const SPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";
const JQS_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_jqs_2.xml";
const REFERER = "https://trade.500.com/jczq/";

async function fetchXml(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: REFERER }, signal: AbortSignal.timeout(40000) });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.text();
}

const id2seq = (spf) => {
  const map = {};
  for (const m of spf.matchAll(/<m\b([^>]*)>/g)) {
    const a = m[1];
    const id = (a.match(/id="([^"]*)"/) || [])[1];
    const num = (a.match(/matchnum="([^"]*)"/) || [])[1];
    if (id && num) map[id] = num;
  }
  return map;
};

try {
  const [spf, jqs] = await Promise.all([fetchXml(SPF_URL), fetchXml(JQS_URL)]);
  const map = id2seq(spf);
  const matches = {};
  for (const m of jqs.matchAll(/<m\b([^>]*)\/>/g)) {
    const a = m[1];
    const id = (a.match(/id="([^"]*)"/) || [])[1];
    const seq = map[id];
    if (!seq) continue;
    const odds = {};
    for (let i = 0; i <= 7; i++) {
      const v = (a.match(new RegExp(`s${i}="([^"]*)"`)) || [])[1];
      if (v) odds[i] = Number(v);
    }
    if (Object.keys(odds).length) matches[seq] = { odds };
  }
  const out = { fetchedAt: new Date().toISOString(), source: "trade.500.com pl_jqs_2.xml", date: DATE, matches };
  const p = `D:/football-model-data/market/jqs-raw-${DATE}.json`;
  writeFileSync(p, JSON.stringify(out, null, 1));
  console.log(`✅ jqs-raw 写出 ${Object.keys(matches).length} 场 → ${p}`);
} catch (e) {
  console.error(`⚠️ jqs-raw 抓取失败(总进球串关腿将缺,不兜底): ${e.message}`);
  process.exit(0);
}
