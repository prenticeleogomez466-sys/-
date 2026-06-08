/**
 * 从 trade.500.com 干净 XML(pl_spf_2 欧赔让0 + pl_nspf_2 让球胜平负)构造
 * jingcai-scrape-<date>.json(两次捕获:初赔=最早 updatetime,即时=最新 row[0])。
 * 只取周六单(matchnum 以 6 开头),排除周日(7xxx)。
 * 用法:node scripts/build-scrape-from-xml.mjs --date 2026-05-30 --spf spf_tmp.xml --nspf nspf_tmp.xml
 */
import { readFileSync, writeFileSync } from "node:fs";
import { scrapeFilePath } from "../src/jingcai-fivehundred-stage.js";

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const date = readArg("--date");
const spfPath = readArg("--spf", "spf_tmp.xml");
const nspfPath = readArg("--nspf", "nspf_tmp.xml");
// 官方让球数(handicapCell,如 "0 -1")由 500 jczq 页面 DOM 抓取注入:{主队名 或 matchnum: "0 -1"}。
// XML 不含让球数 → 不注入则 handicapCell 留空、line 默认 0(旧行为)。
const hcapPath = readArg("--handicap", null);
const hcap = hcapPath ? JSON.parse(readFileSync(hcapPath, "utf8")) : {};

function parseMatches(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<m\b([^>]*)>([\s\S]*?)<\/m>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = p[2];
    const rows = [];
    for (const r of m[2].matchAll(/<row\b([^>]*)\/>/g)) {
      const ra = {};
      for (const p of r[1].matchAll(/([\w-]+)="([^"]*)"/g)) ra[p[1]] = p[2];
      rows.push(ra);
    }
    // row[0] = 最新(即时);末行 = 开盘(初赔)
    out.set(a.matchnum, { meta: a, current: rows[0], opening: rows[rows.length - 1] });
  }
  return out;
}

const spf = parseMatches(readFileSync(spfPath, "utf8"));
const nspf = parseMatches(readFileSync(nspfPath, "utf8"));

// jingcai-ingest-wc-singles(2026-06-08):去掉"最早赛日单批锚定"(与 ingest-500-fallback 同 bug)。
//   500 pl_spf_2.xml 只列"当前在售"竞彩 → 在售 = feed 全部场次。旧逻辑只取最早赛日那批,会把世界杯
//   长预售期(matchnum 跨多系列、kickoff 跨多日)的单场(如 4001 墨西哥vs南非)整批丢弃。
//   改为纳入全部在售场次,只剔赛日严格早于业务日(已结束)的场。
const _dateOf = (seq) => spf.get(seq)?.meta?.date?.match?.(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
const _bizDate = (date && String(date).match(/\d{4}-\d{2}-\d{2}/)?.[0])
  || [...spf.keys()].map(_dateOf).filter(Boolean).sort()[0]
  || "0000-00-00";
const seqs = [...spf.keys()].filter((s) => { const d = _dateOf(s); return !d || d >= _bizDate; }).sort();

function buildRows(phase) {
  const rows = [];
  for (const seq of seqs) {
    const s = spf.get(seq);
    const n = nspf.get(seq);
    const e = s ? s[phase] : null;             // 欧赔让0
    const h = n ? n[phase] : null;             // 让球胜平负
    if (!e) continue;
    const league = s.meta.league;
    const kickoff = `${s.meta.date.slice(5)}`; // MM-DD(XML 无开赛时刻)
    const teamCell = `${s.meta.home} VS ${s.meta.away}`;
    const oddsCell = [e.win, e.draw, e.lost, h?.win ?? "", h?.draw ?? "", h?.lost ?? ""].join(" ");
    const handicapCell = hcap[s.meta.home] ?? hcap[seq] ?? hcap[`${s.meta.home} VS ${s.meta.away}`] ?? "";
    rows.push([seq, league, kickoff, teamCell, handicapCell, oddsCell]);
  }
  return rows;
}

// 取真实时间戳:用 SPF 各场 row 的 updatetime 极值作为捕获时间
const allTimes = [];
for (const seq of seqs) {
  const s = spf.get(seq);
  if (s?.current?.updatetime) allTimes.push(s.current.updatetime);
  if (s?.opening?.updatetime) allTimes.push(s.opening.updatetime);
}
allTimes.sort();
const openingAt = (allTimes[0] ?? `${date} 09:00:00`).replace(" ", "T") + "+08:00";
const currentAt = (allTimes[allTimes.length - 1] ?? `${date} 20:00:00`).replace(" ", "T") + "+08:00";

const payload = {
  date,
  source: "trade.500.com newxml pl_spf_2 + pl_nspf_2 (live fetch)",
  captures: [
    { collectedAt: openingAt, rows: buildRows("opening") },
    { collectedAt: currentAt, rows: buildRows("current") },
  ],
  asian: {},
};

const path = scrapeFilePath(date);
writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ date, matches: seqs.length, openingAt, currentAt, path }, null, 2));
