#!/usr/bin/env node
/**
 * 半全场"睁眼"——用 football-data.org v4 免费档回填真实半场比分(2026-06-04)。
 *
 * 背景:复盘里半全场玩法实战命中 0%,根因=免费赛果源不带半场比分(诊断已确认:
 *   ESPN soccer scoreboard linescores 0/9 全空;TheSportsDB intHomeScoreHT 多为空;
 *   Sofascore API/浏览器均被 Cloudflare 403)。实测唯一稳定、免费、纯 Node、适合无人值守
 *   计划任务的 HT 源 = football-data.org v4(score.halfTime),覆盖 2026 世界杯 + 五大联赛 +
 *   英冠 + 巴甲 + 欧冠 + 欧洲杯。免费 token(注册即得,不花钱)。
 *
 * 与 backfill-results.mjs(ESPN 全场赛果)互补:本脚本只补"已结算但缺半场"的场的 halfHome/halfAway,
 *   口径与 recap 一致(canonicalTeamName 桥接中文 fixture)。只写确有真实半场的场,匹配不上留缺(no-fabrication)。
 *
 * 用法:
 *   FOOTBALL_DATA_ORG_TOKEN=xxx node scripts/backfill-halftime-fdorg.mjs --dry      # 只报告
 *   node scripts/backfill-halftime-fdorg.mjs                                        # 实写(token 从 local.env)
 *   node scripts/backfill-halftime-fdorg.mjs --date 2026-06-11                      # 指定单日
 * 无 token 时优雅跳过并打印获取指引(exit 0),不报错、不阻塞日报流水线。
 */
import "../src/env.js";
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { getExportDir } from "../src/paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.FOOTBALL_DATA_ORG_TOKEN || process.env.FOOTBALL_DATA_API_TOKEN || "";
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dateArg = (() => {
  const pre = args.find((a) => a.startsWith("--date="));
  if (pre) return pre.slice("--date=".length);
  const i = args.indexOf("--date");
  return i >= 0 ? args[i + 1] : null;
})();
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

if (!TOKEN) {
  console.log("⏭  未配置 FOOTBALL_DATA_ORG_TOKEN —— 半场回填跳过(不阻塞流水线)。");
  console.log("   启用方法(免费,一次性):");
  console.log("   1) 打开 https://www.football-data.org/client/register 用邮箱注册,拿到 API token");
  console.log("   2) 在 D:\\football-model-data\\local.env 末尾加一行:FOOTBALL_DATA_ORG_TOKEN=你的token");
  console.log("   3) 重跑本脚本即可回填世界杯+五大联赛等的半场比分,半全场玩法即可结算/学习。");
  process.exit(0);
}

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

// football-data.org v4:一次拉日期区间所有(免费档)联赛的比赛,带 score.halfTime。
async function fetchRange(dateFrom, dateTo) {
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const r = await fetch(url, { headers: { "X-Auth-Token": TOKEN } });
  if (r.status === 429) { console.warn("  ⚠️ 429 限流(免费档10次/分),稍候重试"); await new Promise((s) => setTimeout(s, 6500)); return fetchRange(dateFrom, dateTo); }
  if (!r.ok) { console.warn(`  ⚠️ football-data.org HTTP ${r.status}`); return []; }
  const j = await r.json();
  const out = [];
  for (const m of j?.matches ?? []) {
    if (m.status !== "FINISHED") continue;
    const ht = m.score?.halfTime;
    if (!ht || !Number.isFinite(ht.home) || !Number.isFinite(ht.away)) continue; // 只收真实半场
    out.push({
      home: m.homeTeam?.name ?? m.homeTeam?.shortName ?? "",
      away: m.awayTeam?.name ?? m.awayTeam?.shortName ?? "",
      halfHome: ht.home, halfAway: ht.away,
      ftHome: m.score?.fullTime?.home ?? null, ftAway: m.score?.fullTime?.away ?? null,
      competition: m.competition?.name ?? "", utcDate: (m.utcDate ?? "").slice(0, 10),
    });
  }
  return out;
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
    // 已结算(有全场赛果)但缺半场的场 → 才需补 HT
    const settled = r.actualStatus === "settled" || (r.actual && r.actual !== "");
    if (settled && r.date && r.date < todayIso) set.add(r.date);
  }
  return [...set].sort();
}

const dates = dateArg ? [dateArg] : pendingDates();
if (!dates.length) { console.log("无需补半场的过去日期。"); process.exit(0); }

console.log(`半场回填日期(${dates.length}):${dates.join(", ")}${dry ? "  [DRY-RUN 不写盘]" : ""}\n`);

let grandFilled = 0, grandMiss = 0;
for (const date of dates) {
  const store = loadFixtures(date);
  const fixtures = store.fixtures;
  // 只处理"有全场 result 但缺半场"的场
  const need = fixtures.filter((f) => f.result && !(Number.isFinite(f.result.halfHome) && Number.isFinite(f.result.halfAway)));
  if (!need.length) { console.log(`${date}: 无缺半场的已结算场,跳过`); continue; }

  // 竞彩业务日常早于实际开赛 1-2 天 → 拉 ±2 天区间
  const raw = await fetchRange(shiftDay(date, -2), shiftDay(date, 2));
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
  console.log(`${date}: 缺半场 ${need.length} → 命中补 ${filled}(fd.org 池 ${raw.length} 场),仍缺 ${need.length - filled}`);
  if (!dry && filled > 0) saveFixtures(date, updated, { source: "fdorg-halftime-backfill", allowEmpty: false });
}

console.log(`\n合计:补半场 ${grandFilled} 场,仍缺 ${grandMiss} 场。`);
console.log(grandFilled > 0 ? "下一步:重跑 recap:daily 即可结算半全场玩法、闭合学习。" : "本批未补到(免费档不覆盖这些联赛/日期,属诚实缺口)。");
