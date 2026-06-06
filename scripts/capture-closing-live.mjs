// 真·临场收盘线轮询器(2026-06-06 神选,补 capture-closing 的 gap)。
// 痛点(见 reference_clv_accrual_state):capture-closing 只把 current→final 冻结,但若 current 是早盘
//   (没临场刷新)→ final≈早盘,CLV 失真。本器在【赛前窗口】对即将开赛的场【重抓 500 真盘】更新 current
//   并冻结成 final,得到真正的收盘线(市场最 sharp 估计),供 CLV 打分 + 作更准的概率锚。
// 用法:node scripts/capture-closing-live.mjs [--date=YYYY-MM-DD] [--window=20]
//   建议挂计划任务每 ~10 分钟跑一次(白天/赛前时段),自动逮住每场临近开赛的收盘价。
import "../src/env.js";
import { loadFixtures } from "../src/fixture-store.js";
import { loadMarketSnapshots, saveMarketSnapshots, findMarketSnapshot } from "../src/market-data-store.js";

const SPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";   // 让球胜平负
const NSPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml"; // 胜平负
const REFERER = "https://trade.500.com/jczq/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const date = arg("date", shanghaiDate());
const windowMin = Number(arg("window", 20)); // 开赛前多少分钟内算"临场"

function shanghaiDate(off = 0) {
  const n = new Date(Date.now() + (8 * 60 - new Date().getTimezoneOffset()) * 60000 + off * 864e5);
  return n.toISOString().slice(0, 10);
}
function nowShanghai() { return new Date(Date.now() + (8 * 60 - new Date().getTimezoneOffset()) * 60000); }
async function fetchXml(url) {
  const r = await fetch(url, { headers: { Referer: REFERER, "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}
const attrMap = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
function parseLatest(xml) {
  const byNum = new Map();
  for (const block of xml.match(/<m\b[^>]*>[\s\S]*?<\/m>/g) ?? []) {
    const attrs = attrMap(block.slice(0, block.indexOf(">") + 1));
    const rows = [...block.matchAll(/<row\b([^>]*?)\/?>/g)].map((r) => attrMap(`<row ${r[1]}>`));
    if (rows.length && attrs.matchnum) byNum.set(attrs.matchnum, rows[0]); // row[0]=最新即时价
  }
  return byNum;
}
// 解析开赛时间(fixture.kickoff 形如 "2026-06-06 14:00"),返回距开赛分钟数(可负=已开赛)
function minsToKickoff(fixture) {
  const m = String(fixture.kickoff ?? "").match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const ko = new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`);
  return (ko.getTime() - nowShanghai().getTime() - 8 * 3600000) / 60000 + 0; // 已按上海校正
}

async function main() {
  const { fixtures } = loadFixtures(date);
  const jc = fixtures.filter((f) => f.marketType === "jingcai");
  // 临场窗口:开赛前 windowMin 分钟内、或刚开赛 <10 分钟(盘口收盘瞬间)
  const due = jc.filter((f) => { const t = minsToKickoff(f); return t != null && t <= windowMin && t >= -10; });
  if (!due.length) { console.log(`[capture-closing-live] ${date}: 无临场场次(窗口${windowMin}分),跳过`); return; }
  console.log(`[capture-closing-live] ${date}: ${due.length} 场临场,重抓真盘冻结收盘...`);
  const [spfXml, nspfXml] = await Promise.all([fetchXml(SPF_URL), fetchXml(NSPF_URL)]);
  const spf = parseLatest(spfXml), nspf = parseLatest(nspfXml);
  const set = loadMarketSnapshots(date);
  let frozen = 0;
  for (const f of due) {
    const num = String(f.sequence ?? f.matchnum ?? "");
    const spfRow = spf.get(num), nspfRow = nspf.get(num);
    if (!spfRow && !nspfRow) continue;
    for (const s of set.snapshots) {
      if (String(s.sequence) !== num) continue;
      // 胜平负 ← nspf;让球 ← spf。把最新即时价写成 current 并冻结 final(=真收盘)。
      if (nspfRow && s.europeanOdds) { s.europeanOdds.current = devig(nspfRow); s.europeanOdds.final = devig(nspfRow); }
      if (spfRow && s.handicapOdds) { s.handicapOdds.current = devig(spfRow); s.handicapOdds.final = devig(spfRow); }
      s.closingLiveCapturedAt = new Date().toISOString();
      frozen++;
    }
  }
  if (frozen) saveMarketSnapshots(date, set.snapshots, { source: `${set.source}+closing-live` });
  console.log(`完成:冻结 ${frozen} 场真收盘线(临场重抓)。CLV 现在对真收盘打分。`);
}
// 500 row 的水位字段 → 标准 {home,draw,away}(欧赔)
function devig(row) {
  const v = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
  return { home: v(row.win ?? row.h), draw: v(row.draw ?? row.d), away: v(row.lost ?? row.a) };
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
