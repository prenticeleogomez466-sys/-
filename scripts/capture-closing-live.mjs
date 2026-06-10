// 真·临场收盘线轮询器(2026-06-06 神选,补 capture-closing 的 gap)。
// 痛点(见 reference_clv_accrual_state):capture-closing 只把 current→final 冻结,但若 current 是早盘
//   (没临场刷新)→ final≈早盘,CLV 失真。本器在【赛前窗口】对即将开赛的场【重抓 500 真盘】更新 current
//   并冻结成 final,得到真正的收盘线(市场最 sharp 估计),供 CLV 打分 + 作更准的概率锚。
// 用法:node scripts/capture-closing-live.mjs [--date=YYYY-MM-DD] [--window=20]
//   建议挂计划任务每 ~10 分钟跑一次(白天/赛前时段),自动逮住每场临近开赛的收盘价。
import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures } from "../src/fixture-store.js";
import { loadMarketSnapshots, saveMarketSnapshots, findMarketSnapshot } from "../src/market-data-store.js";
import { orientRowMaps, swapGuardViolation, ORIENT_A_IS_1X2, ORIENT_UNCERTAIN } from "../src/spf-orientation.js";
import { shanghaiDateOf, minutesToKickoff } from "../src/kickoff-time.js";
import { nextCaptureState, assessCaptureHealth, CAPTURE_STATE_FILENAME } from "../src/closing-capture-health.js";
import { getDataDir } from "../src/paths.js";

// ⚠️ 两 XML 内容会互换,文件名不可信(06-09 真钱事故)——方向由 src/spf-orientation.js 离散度投票定向。
const SPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";
const NSPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml";
const REFERER = "https://trade.500.com/jczq/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
// 时区根修(缺陷#9,2026-06-10):旧 shanghaiDate()/nowShanghai() 按"机器=UTC"手算 +8h 偏移,
//   本机已是 UTC+8 → 双重 +8h(17:16 打出明天日期、minsToKickoff 恒差 24h,0 次真实捕获)。
//   一律改 epoch 绝对时间 + Intl 显式 Asia/Shanghai(src/kickoff-time.js),机器时区无关。
// 业务日(缺陷#10 同根):未显式 --date 时盯【今天+昨天】两个业务日文件——跨午夜开球
//   (世界杯 02:00/03:00 场)归前一业务日文件,且当日文件 03:01 才生成,只盯今天永远漏。
const dateArg = arg("date", null);
const bizDates = dateArg ? [dateArg] : [shanghaiDateOf(), shanghaiDateOf(Date.now(), -1)];
const windowMin = Number(arg("window", 20)); // 开赛前多少分钟内算"临场"
const statePath = join(getDataDir(), CAPTURE_STATE_FILENAME);

function loadCaptureState() {
  try { return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null; } catch { return null; }
}
function persistHealth({ eligibleCount, frozenCount }) {
  const state = nextCaptureState(loadCaptureState(), { eligibleCount, frozenCount });
  try { writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8"); } catch (e) { console.error(`⚠️ 捕获状态文件写入失败:${e.message}`); }
  const health = assessCaptureHealth(state);
  if (health.red) {
    console.error(`🔴 收盘捕获红灯:${health.reason}(状态文件 ${statePath})`);
    if (!process.exitCode) process.exitCode = 1; // 红灯必须非零退出,计划任务面板可见
  }
  return health;
}
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
async function main() {
  // 距开赛分钟(src/kickoff-time.js minutesToKickoff):纯 epoch 差 + 显式 +08:00,
  //   kickoff 无显式 HH:mm → null(摄入链拿不到开球时刻的场如实跳过并打⚠️,绝不猜)。
  const nowMs = Date.now();
  const dueByDate = new Map(); // 业务日 → 该日文件里的临场场次(快照按业务日分文件,必须分日落盘)
  const noTime = [];
  const seenDue = new Set(); // 同一场可能同时出现在今天+昨天两个业务日文件(在售窗口重叠),只计一次
  let totalJc = 0;
  for (const d of bizDates) {
    const jc = loadFixtures(d).fixtures.filter((f) => f.marketType === "jingcai");
    totalJc += jc.length;
    for (const f of jc) {
      const t = minutesToKickoff(f, nowMs);
      if (t === null) { noTime.push(`${d}#${f.sequence ?? "?"} ${f.homeTeam} vs ${f.awayTeam}(kickoff="${f.kickoff ?? ""}")`); continue; }
      // 临场窗口:开赛前 windowMin 分钟内、或刚开赛 <10 分钟(盘口收盘瞬间)
      if (t <= windowMin && t >= -10) {
        if (!dueByDate.has(d)) dueByDate.set(d, []);
        dueByDate.get(d).push(f);
        seenDue.add(`${f.sequence ?? ""}|${f.kickoff ?? ""}|${f.homeTeam}|${f.awayTeam}`);
      }
    }
  }
  if (noTime.length) {
    const head = noTime.slice(0, 6);
    const more = noTime.length > head.length ? `\n  …等共 ${noTime.length} 场` : "";
    console.error(`⚠️ ${noTime.length} 场 kickoff 无开球时刻(HH:mm),无法判临场,跳过(摄入链需补时刻):\n  ` + head.join("\n  ") + more);
  }
  const eligibleCount = seenDue.size;
  if (!eligibleCount) {
    console.log(`[capture-closing-live] ${bizDates.join("+")}: 无临场场次(窗口${windowMin}分,共${totalJc}场竞彩),跳过`);
    persistHealth({ eligibleCount: 0, frozenCount: 0 });
    return;
  }
  console.log(`[capture-closing-live] ${bizDates.join("+")}: ${eligibleCount} 场临场,重抓真盘冻结收盘...`);
  const [spfXml, nspfXml] = await Promise.all([fetchXml(SPF_URL), fetchXml(NSPF_URL)]);
  const feedA = parseLatest(spfXml), feedB = parseLatest(nspfXml);
  // 方向定向(缺陷#3,2026-06-10):旧代码按文件名硬解析(euro←nspf/让球←spf),互换日会把喂反的
  //   赔率冻结成"真收盘线"毒化 CLV 与概率锚。改接共享离散度投票;uncertain = 方向不可证 → 阻断不写。
  const orient = orientRowMaps(feedA, feedB);
  if (orient.orientation === ORIENT_UNCERTAIN) {
    console.error(`⚠️ spf/nspf 方向离散度投票不确定(A=${orient.voteA} / B=${orient.voteB},样本${orient.sampled})——方向不可证,阻断收盘冻结,请人工复核两份 XML`);
    process.exitCode = 2;
    persistHealth({ eligibleCount, frozenCount: 0 });
    return;
  }
  const euroRows = orient.orientation === ORIENT_A_IS_1X2 ? feedA : feedB; // 胜平负(1X2)
  const hcRows = orient.orientation === ORIENT_A_IS_1X2 ? feedB : feedA;   // 让球胜平负
  console.log(`[orient] 1X2 feed = ${orient.orientation === ORIENT_A_IS_1X2 ? "pl_spf" : "pl_nspf"}(离散度投票 A=${orient.voteA} / B=${orient.voteB},样本${orient.sampled})`);
  let frozenMatches = 0;
  const swapViolations = [];
  const toSave = []; // [date, set] —— 互换守护通过后统一落盘(可疑则全部不写)
  for (const [d, due] of dueByDate) {
    const set = loadMarketSnapshots(d);
    let dirty = false;
    for (const f of due) {
      const num = String(f.sequence ?? f.matchnum ?? "");
      const euroRow = euroRows.get(num), hcRow = hcRows.get(num);
      if (!euroRow && !hcRow) continue;
      // 逐场互换残留守护(缺陷#13):定向后该场两套赔率仍可疑 → 记违例,统一阻断(绝不冻结可疑收盘线)。
      // 2026-06-10 洞1:此链拿不到竞彩让球线,统一用真互换形态阈值 ×5(06-09 事故实测比值≈5.8-6.5,
      //   均势整数线误报≈2.3-3.5)——误报代价=整轮收盘冻结被阻断,远大于残留漏网(feed 级投票仍兜底)。
      const violation = swapGuardViolation(
        euroRow ? { current: devig(euroRow) } : null,
        hcRow ? { current: devig(hcRow) } : null,
        { factor: 5 }
      );
      if (violation) { swapViolations.push(`${num} ${f.homeTeam ?? ""} vs ${f.awayTeam ?? ""}: ${violation}`); continue; }
      let touched = false;
      for (const s of set.snapshots) {
        if (String(s.sequence) !== num) continue;
        // 把最新即时价写成 current 并冻结 final(=真收盘)。
        if (euroRow && s.europeanOdds) { s.europeanOdds.current = devig(euroRow); s.europeanOdds.final = devig(euroRow); }
        if (hcRow && s.handicapOdds) { s.handicapOdds.current = devig(hcRow); s.handicapOdds.final = devig(hcRow); }
        s.closingLiveCapturedAt = new Date().toISOString();
        touched = true; dirty = true;
      }
      if (touched) frozenMatches++;
    }
    if (dirty) toSave.push([d, set]);
  }
  if (swapViolations.length) {
    console.error(`⛔ 互换残留守护命中 ${swapViolations.length} 场,方向可疑,本轮不落盘:\n  ` + swapViolations.join("\n  "));
    process.exitCode = 2;
    persistHealth({ eligibleCount, frozenCount: 0 });
    return;
  }
  for (const [d, set] of toSave) saveMarketSnapshots(d, set.snapshots, { source: `${set.source}+closing-live` });
  console.log(`完成:冻结 ${frozenMatches} 场真收盘线(临场重抓,业务日 ${bizDates.join("+")})。CLV 现在对真收盘打分。`);
  persistHealth({ eligibleCount, frozenCount: frozenMatches });
}
// 500 row 的水位字段 → 标准 {home,draw,away}(欧赔)
function devig(row) {
  const v = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
  return { home: v(row.win ?? row.h), draw: v(row.draw ?? row.d), away: v(row.lost ?? row.a) };
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
