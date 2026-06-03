/**
 * 竞彩抓取一键准备(供 jingcai:daily 前置 / 计划任务):
 *   1. node fetch 500 XML(pl_spf 让0欧赔 + pl_nspf 让球胜平负,带初赔→即时变化)
 *   2. playwright(系统 Chrome)抓 jczq 页面 DOM 的官方让球数
 *   3. build-scrape-from-xml 合成 jingcai-scrape-<date>.json(注入让球数)
 * 全程纯 node + 系统 Chrome,无人值守可跑。让球数抓不到则降级为空(line=0),不中断。
 *
 * 用法: node scripts/jingcai-prepare.mjs [--date YYYY-MM-DD]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

const TMP = "D:/Temp/claude";
mkdirSync(TMP, { recursive: true });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SPF = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";
const NSPF = "https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml";

async function fetchXml(url, file) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://trade.500.com/jczq/" } });
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  const t = await r.text();
  writeFileSync(file, t, "utf8");
  return (t.match(/<m\b/g) || []).length;
}

const spfFile = `${TMP}/jc-spf.xml`, nspfFile = `${TMP}/jc-nspf.xml`, hcapFile = `${TMP}/jc-handicap.json`;

console.log(`[1/3] fetch 500 XML …`);
const nSpf = await fetchXml(SPF, spfFile);
await fetchXml(NSPF, nspfFile);
console.log(`      spf 含 ${nSpf} 场`);

console.log(`[2/3] 抓官方让球数(系统 Chrome)…`);
const hc = spawnSync("node", ["scripts/scrape-jingcai-handicap.mjs", "--out", hcapFile], { encoding: "utf8" });
if (hc.status !== 0) { console.warn("      ⚠️ 让球数抓取失败,降级为空(line=0):", (hc.stderr || "").slice(0, 120)); writeFileSync(hcapFile, "{}", "utf8"); }
else { const m = (hc.stdout.match(/"count":\s*(\d+)/) || [])[1]; console.log(`      抓到 ${m ?? "?"} 场让球数`); }

console.log(`[3/3] build scrape …`);
const b = spawnSync("node", ["scripts/build-scrape-from-xml.mjs", "--date", date, "--spf", spfFile, "--nspf", nspfFile, "--handicap", hcapFile], { encoding: "utf8" });
process.stdout.write(b.stdout || "");
if (b.status !== 0) { console.error("build 失败:", b.stderr); process.exit(1); }
console.log("✅ jingcai-prepare 完成,可跑 jingcai:daily");
