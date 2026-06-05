#!/usr/bin/env node
/**
 * 半场回填(第二 HT 源)—— API-Football v3 free 档(2026-06-05)。
 *
 * 背景:fd.org 只覆盖世界杯+五大+英冠+巴甲+欧冠,竞彩里挪超/瑞超/日职/解放者/国际赛(World Friendlies)
 *   等半场 fd.org 拿不到。API-Football free 档(100次/天)覆盖这些联赛的 score.halftime。
 *   ⚠️ free 档**只给最近日期**(约 today-2 ~ today+1),历史日期返回 "Free plans do not have access"
 *   → 本脚本只能补**最近 1-2 天**的小联赛半场(给每日复盘前向用);更早的历史属诚实缺口。
 *
 * 与 backfill-halftime-fdorg.mjs 互补:每日复盘链先跑 fdorg,再跑本脚本补 fdorg 漏的联赛。
 * 只写确有真实半场的场,匹配不上留缺(no-fabrication)。无 key 优雅跳过 exit 0。
 *
 * 用法:
 *   node scripts/backfill-halftime-apifootball.mjs            # 自动补 ledger 里最近缺半场的日期
 *   node scripts/backfill-halftime-apifootball.mjs --date 2026-06-04
 *   node scripts/backfill-halftime-apifootball.mjs --dry      # 只报告不写盘
 */
import "../src/env.js";
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { getExportDir } from "../src/paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.API_FOOTBALL_KEY || "";
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dateArg = (() => {
  const pre = args.find((a) => a.startsWith("--date="));
  if (pre) return pre.slice("--date=".length);
  const i = args.indexOf("--date");
  return i >= 0 ? args[i + 1] : null;
})();
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

if (!KEY) {
  console.log("⏭  未配置 API_FOOTBALL_KEY —— API-Football 半场回填跳过(不阻塞流水线)。");
  console.log("   拿 key:见 D:\\football-model-data\\apifootball-account.txt;写入:npm run sources:configure -- -ApiFootballKey \"KEY\"");
  process.exit(0);
}

// 国家队名 → 中文(与 fdorg 版一致,竞彩国际赛/友谊赛匹配用)
const NATION = {
  switzerland: "瑞士", jordan: "约旦", germany: "德国", finland: "芬兰",
  unitedstates: "美国", usa: "美国", senegal: "塞内加尔", brazil: "巴西", panama: "巴拿马",
  bulgaria: "保加利亚", montenegro: "黑山", norway: "挪威", sweden: "瑞典",
  turkey: "土耳其", turkiye: "土耳其", northmacedonia: "北马其顿", austria: "奥地利",
  tunisia: "突尼斯", colombia: "哥伦比亚", costarica: "哥斯达黎加", canada: "加拿大",
  uzbekistan: "乌兹别克斯坦", mexico: "墨西哥", australia: "澳大利亚", scotland: "苏格兰",
  curacao: "库拉索", southkorea: "韩国", korearepublic: "韩国", japan: "日本", iceland: "冰岛",
  nigeria: "尼日利亚", ecuador: "厄瓜多尔", saudiarabia: "沙特阿拉伯", iran: "伊朗", iraq: "伊拉克",
  gambia: "冈比亚", andorra: "安道尔", southafrica: "南非", nicaragua: "尼加拉瓜",
  bosniaherzegovina: "波黑", zimbabwe: "津巴布韦", india: "印度", jamaica: "牙买加",
  trinidadandtobago: "特立尼达和多巴哥", england: "英格兰", france: "法国", spain: "西班牙",
  italy: "意大利", portugal: "葡萄牙", netherlands: "荷兰", belgium: "比利时", croatia: "克罗地亚",
  argentina: "阿根廷", uruguay: "乌拉圭", chile: "智利", peru: "秘鲁", paraguay: "巴拉圭",
  poland: "波兰", denmark: "丹麦", serbia: "塞尔维亚", wales: "威尔士", ireland: "爱尔兰",
  morocco: "摩洛哥", egypt: "埃及", ghana: "加纳", cameroon: "喀麦隆", ivorycoast: "科特迪瓦",
  algeria: "阿尔及利亚", qatar: "卡塔尔", uae: "阿联酋", china: "中国", venezuela: "委内瑞拉",
  bolivia: "玻利维亚", honduras: "洪都拉斯", elsalvador: "萨尔瓦多", greece: "希腊",
  czechia: "捷克", czechrepublic: "捷克", hungary: "匈牙利", romania: "罗马尼亚", ukraine: "乌克兰",
  slovenia: "斯洛文尼亚", slovakia: "斯洛伐克", albania: "阿尔巴尼亚", israel: "以色列",
  newzealand: "新西兰", kosovo: "科索沃", luxembourg: "卢森堡", kazakhstan: "哈萨克斯坦",
};
function ck(name) { const c = canonicalTeamName(name); return NATION[c] ?? c; }
function teamLike(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  return false;
}
function shiftDay(iso, delta) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// API-Football v3:按单日拉所有联赛比赛(一次请求),带 score.halftime。
// free 档历史日期返回 errors.plan → 标记 noAccess 让调用方跳过。
async function fetchDate(date) {
  const url = `https://v3.football.api-sports.io/fixtures?date=${date}`;
  let r;
  try { r = await fetch(url, { headers: { "x-apisports-key": KEY } }); }
  catch (e) { console.warn(`  ⚠️ 网络错误 ${date}: ${e.message}`); return { rows: [], noAccess: false }; }
  if (r.status === 429) { console.warn("  ⚠️ 429 限流,稍候重试"); await new Promise((s) => setTimeout(s, 6500)); return fetchDate(date); }
  const j = await r.json().catch(() => ({}));
  const errs = j?.errors;
  const noAccess = errs && !Array.isArray(errs) && /do not have access/i.test(JSON.stringify(errs));
  const out = [];
  for (const f of j?.response ?? []) {
    if (f.fixture?.status?.short !== "FT") continue;
    const ht = f.score?.halftime;
    if (!ht || !Number.isFinite(ht.home) || !Number.isFinite(ht.away)) continue; // 只收真实半场
    out.push({
      home: f.teams?.home?.name ?? "", away: f.teams?.away?.name ?? "",
      halfHome: ht.home, halfAway: ht.away,
      ftHome: f.goals?.home ?? null, ftAway: f.goals?.away ?? null,
      competition: f.league?.name ?? "", utcDate: (f.fixture?.date ?? "").slice(0, 10),
    });
  }
  return { rows: out, noAccess };
}

function nearest(list, targetIso) {
  if (!targetIso || list.length <= 1) return list[0];
  const t = Date.parse(targetIso + "T00:00:00Z");
  return list.slice().sort((a, b) => Math.abs(Date.parse(a.utcDate + "T00:00:00Z") - t) - Math.abs(Date.parse(b.utcDate + "T00:00:00Z") - t))[0];
}
function findMatch(pool, canonHome, canonAway, targetIso) {
  const strict = pool.filter((m) => teamLike(canonHome, m.ch) && teamLike(canonAway, m.ca));
  if (strict.length) return nearest(strict, targetIso);
  const byHome = pool.filter((m) => teamLike(canonHome, m.ch));
  if (byHome.length === 1) return byHome[0];
  const byAway = pool.filter((m) => teamLike(canonAway, m.ca));
  if (byAway.length === 1) return byAway[0];
  return null;
}

function pendingDates() {
  const led = JSON.parse(readFileSync(join(getExportDir(), "recommendation-ledger.json"), "utf8"));
  const set = new Set();
  for (const r of led) {
    const settled = r.actualStatus === "settled" || (r.actual && r.actual !== "");
    if (settled && r.date && r.date < todayIso) set.add(r.date);
  }
  // free 档只给最近日期 → 只尝试 today-3 起(更早必被拒,省请求)。按新→旧排,先补最近。
  const floor = shiftDay(todayIso, -3);
  return [...set].filter((d) => d >= floor).sort().reverse();
}

const dates = dateArg ? [dateArg] : pendingDates();
if (!dates.length) { console.log("无最近可补半场的日期(API-Football free 档仅近 ~3 天;更早历史属硬限缺口)。"); process.exit(0); }

console.log(`API-Football 半场回填日期(${dates.length}):${dates.join(", ")}${dry ? "  [DRY-RUN 不写盘]" : ""}\n`);

let grandFilled = 0, grandMiss = 0;
for (const date of dates) {
  const store = loadFixtures(date);
  const fixtures = store.fixtures;
  const need = fixtures.filter((f) => f.result && !(Number.isFinite(f.result.halfHome) && Number.isFinite(f.result.halfAway)));
  if (!need.length) { console.log(`${date}: 无缺半场的已结算场,跳过`); continue; }

  // 竞彩业务日常早于实际开赛 → 拉本日 + ±1 天(都在 free 窗口内才有数据)
  let raw = [];
  let noAccessAll = true;
  for (const d of [date, shiftDay(date, 1), shiftDay(date, -1)]) {
    const { rows, noAccess } = await fetchDate(d);
    if (!noAccess) noAccessAll = false;
    raw = raw.concat(rows);
  }
  if (noAccessAll) { console.log(`${date}: ⏭ free 档无此日期访问权(历史硬限),跳过`); continue; }
  const pool = raw.map((m) => ({ ...m, ch: ck(m.home), ca: ck(m.away) }));

  let filled = 0;
  const updated = fixtures.map((f) => {
    if (!f.result || (Number.isFinite(f.result.halfHome) && Number.isFinite(f.result.halfAway))) return f;
    const hit = findMatch(pool, ck(f.homeTeam), ck(f.awayTeam), f.date ?? date);
    if (!hit) return f;
    filled++;
    return { ...f, result: { ...f.result, halfHome: hit.halfHome, halfAway: hit.halfAway } };
  });

  grandFilled += filled;
  grandMiss += need.length - filled;
  console.log(`${date}: 缺半场 ${need.length} → 命中补 ${filled}(API-Football 池 ${raw.length} 场),仍缺 ${need.length - filled}`);
  if (!dry && filled > 0) saveFixtures(date, updated, { source: "apifootball-halftime-backfill", allowEmpty: false });
}

console.log(`\n合计:补半场 ${grandFilled} 场,仍缺 ${grandMiss} 场。`);
console.log(grandFilled > 0 ? "下一步:重跑 recap:daily 结算半全场。" : "本批未补到(free 档日期窗口/联赛不覆盖,属诚实缺口)。");
