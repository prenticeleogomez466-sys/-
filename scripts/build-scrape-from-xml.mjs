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

const feedA = parseMatches(readFileSync(spfPath, "utf8"));   // 文件名 --spf(内容不可信)
const feedB = parseMatches(readFileSync(nspfPath, "utf8"));  // 文件名 --nspf(内容不可信)

// 2026-06-09 修关键对调 bug:500 的 pl_spf_2 / pl_nspf_2 两个 XML 内容会互换(命名不可信)。
//   若硬按文件名假设 spf=1X2,会把胜平负与让球赔率喂反(如匈牙利 1X2 1.17 大热被当让球 →
//   europeanOdds 拿到让球值 → 主推从主胜翻成客胜,全表错)。今天实测正是 pl_spf=让球、pl_nspf=1X2。
//   改为**数据驱动自动定向**(不靠脆弱命名假设,500 翻回去也自适应):悬殊/大热场 1X2 三项赔率的
//   离散度(max/min)远大于让球盘(匈牙利 1X2 1.17/5.35/11.5 比≈9.8 vs 让-2 3.11/3.36/1.96 比≈1.7),
//   逐场比两 feed 离散度投票,多数票判哪个 feed 是 1X2;平票/无样本保守按文件名(feedA=1X2)。
const tripleRatio = (row) => {
  if (!row) return null;
  const v = [+row.win, +row.draw, +row.lost].filter((x) => x > 0);
  return v.length === 3 ? Math.max(...v) / Math.min(...v) : null;
};
let voteA = 0, voteB = 0;
for (const seq of feedA.keys()) {
  const a = tripleRatio(feedA.get(seq)?.current), b = tripleRatio(feedB.get(seq)?.current);
  if (a == null || b == null) continue;
  if (a > b * 1.3) voteA++;        // feedA 更离散 → feedA 是 1X2
  else if (b > a * 1.3) voteB++;   // feedB 更离散 → feedB 是 1X2
}
const aIs1x2 = voteA >= voteB;     // 平票保守按文件名(--spf=1X2)
const spf = aIs1x2 ? feedA : feedB;    // spf 变量名沿用 = 1X2(胜平负)feed
const nspf = aIs1x2 ? feedB : feedA;   // nspf = 让球胜平负 feed
console.log(`[orient] 1X2 feed = ${aIs1x2 ? "--spf(pl_spf)" : "--nspf(pl_nspf)"}  (离散度投票 A=${voteA} / B=${voteB})`);

// jingcai-ingest-wc-singles(2026-06-08):去掉"最早赛日单批锚定"。改为纳入全部在售场次,只剔赛日早于业务日的场。
// 2026-06-09:遍历两 feed **并集**(只卖让球的悬殊场只在让球 feed 出现,如阿根廷vs冰岛 → 必须保留并标 1X2 未开售)。
const _metaOf = (seq) => spf.get(seq)?.meta ?? nspf.get(seq)?.meta ?? null;
const _allSeqs = new Set([...spf.keys(), ...nspf.keys()]);
const _dateOf = (seq) => _metaOf(seq)?.date?.match?.(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
const _bizDate = (date && String(date).match(/\d{4}-\d{2}-\d{2}/)?.[0])
  || [..._allSeqs].map(_dateOf).filter(Boolean).sort()[0]
  || "0000-00-00";
const seqs = [..._allSeqs].filter((s) => { const d = _dateOf(s); return !d || d >= _bizDate; }).sort();

function buildRows(phase) {
  const rows = [];
  for (const seq of seqs) {
    const meta = _metaOf(seq);
    if (!meta) continue;
    const e = spf.get(seq)?.[phase] ?? null;   // 1X2(胜平负)
    const h = nspf.get(seq)?.[phase] ?? null;  // 让球胜平负
    if (!e && !h) continue;
    const league = meta.league;
    const kickoff = `${meta.date.slice(5)}`;   // MM-DD(XML 无开赛时刻)
    const teamCell = `${meta.home} VS ${meta.away}`;
    // 只卖让球的悬殊场(1X2 未开售):用"未开售"标记 + 让球三项,匹配 parseOdds 的 /未开/ 分支(euro=null)。
    const oddsCell = (!e && h)
      ? `未开售 ${h.win} ${h.draw} ${h.lost}`
      : [e?.win ?? "", e?.draw ?? "", e?.lost ?? "", h?.win ?? "", h?.draw ?? "", h?.lost ?? ""].join(" ");
    const handicapCell = hcap[meta.home] ?? hcap[seq] ?? hcap[`${meta.home} VS ${meta.away}`] ?? "";
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
