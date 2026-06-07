#!/usr/bin/env node
/**
 * 全数据源健康体检 —— 真发请求逐源实测,按"内容深度"判定,而非只看 HTTP 200。
 * 输出 JSON 到 stdout 供 xlsx 装配。每源:
 *   label: 实测 | 推断 | 存疑   (对应 ✅/🔶/⚠️)
 *   status: pass | empty | blocked | fail
 *   httpCode / evidence(真实内容计数) / detail / latencyMs
 * 一次性脚本,可随时重跑。免 key 源直接抓;带 key 源读 local.env 注入。
 */
import { readLocalEnv } from "../src/source-credentials.js";

const env = { ...process.env, ...readLocalEnv() };
const today = new Date().toISOString().slice(0, 10);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function hit(url, { headers = {}, timeout = 15000, raw = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal });
    const latencyMs = Date.now() - t0;
    const text = await r.text();
    let json = null;
    if (!raw) { try { json = JSON.parse(text); } catch {} }
    return { ok: r.ok, code: r.status, latencyMs, text, json };
  } catch (e) {
    return { ok: false, code: 0, latencyMs: Date.now() - t0, text: "", json: null, err: e.name === "AbortError" ? `超时>${timeout}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function gbk(buf) { return new TextDecoder("gb18030").decode(buf); }
async function hitGbk(url, opt = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeout ?? 15000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...(opt.headers || {}) }, signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, code: r.status, latencyMs: Date.now() - t0, text: gbk(buf) };
  } catch (e) {
    return { ok: false, code: 0, latencyMs: Date.now() - t0, text: "", err: e.name === "AbortError" ? "超时" : e.message };
  } finally { clearTimeout(timer); }
}

// 每个探针返回 {label, status, evidence, detail, httpCode, latencyMs}
const PROBES = [
  // ── 官方竞彩源(每日真钱管线命脉)──
  { name: "体彩 sporttery 竞彩计算器", cat: "官方竞彩", signal: "竞彩fixture+胜平负+让球+比分+半全场", run: async () => {
      const u = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c";
      const r = await hit(u, { headers: { Referer: "https://www.sporttery.cn/" } });
      const matches = r.json?.value?.matchInfoList?.reduce?.((s, d) => s + (d.subMatchList?.length || d.matchList?.length || 0), 0)
        ?? (Array.isArray(r.json?.value?.matchInfoList) ? r.json.value.matchInfoList.length : 0);
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      if (matches > 0) return { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: matches, detail: `返回 ${matches} 场竞彩` };
      return { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "200 但 matchInfoList 空(接口结构变或风控)" };
    } },
  { name: "体彩 sporttery 赛事公告", cat: "官方竞彩", signal: "开售/停售时间", run: async () => {
      const u = "https://webapi.sporttery.cn/gateway/jc/common/gmBulletin.qry?page=1&pageSize=50&isShowHis=1";
      const r = await hit(u, { headers: { Referer: "https://www.sporttery.cn/" } });
      const n = r.json?.value?.length ?? r.json?.value?.content?.length ?? 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      return n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 条公告` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "200 但公告空" };
    } },
  { name: "500.com 竞彩亚盘索引(trade)", cat: "官方竞彩", signal: "竞彩亚盘 fid 映射", run: async () => {
      const r = await hitGbk(`https://trade.500.com/jczq/?date=${today}`);
      const ids = [...r.text.matchAll(/data-fixtureid="(\d+)"/g)].length;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      return ids > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: ids, detail: `${ids} 场竞彩 fixtureid` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "页面无 fixtureid(当日无赛或改版)" };
    } },

  // ── 带凭据 API 源(深度:不止 200,要真有当日内容)──
  { name: "The Odds API", cat: "API赔率", signal: "欧赔/让球(五大联赛 sharp 共识)", run: async () => {
      if (!env.ODDS_API_KEY) return { label: "存疑", status: "fail", detail: "未配 ODDS_API_KEY" };
      const r = await hit(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds?apiKey=${env.ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
      const remain = r.text && undefined; // header below
      const n = Array.isArray(r.json) ? r.json.length : 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: `${r.code}: ${String(r.text).slice(0,80)}` };
      return { label: "实测", status: n > 0 ? "pass" : "empty", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: n > 0 ? `EPL 返回 ${n} 场带赔` : "200 但当前无 EPL 赛事(休赛期正常)" };
    } },
  { name: "API-Football", cat: "API赔率", signal: "fixture/result/odds + 配额", run: async () => {
      if (!env.API_FOOTBALL_KEY) return { label: "存疑", status: "fail", detail: "未配 API_FOOTBALL_KEY" };
      const r = await hit("https://v3.football.api-sports.io/status", { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } });
      const used = r.json?.response?.requests?.current, lim = r.json?.response?.requests?.limit_day;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: `${r.code}: ${String(r.text).slice(0,80)}` };
      const acct = r.json?.response?.account ? "账户活跃" : "";
      return { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: lim, detail: `${acct} 配额 ${used ?? "?"}/${lim ?? "?"} 次/日` };
    } },
  { name: "football-data.org", cat: "API赔率", signal: "赛程/赛果(部分赛前赔)", run: async () => {
      if (!env.FOOTBALL_DATA_ORG_TOKEN) return { label: "存疑", status: "fail", detail: "未配 token" };
      const r = await hit("https://api.football-data.org/v4/competitions", { headers: { "X-Auth-Token": env.FOOTBALL_DATA_ORG_TOKEN } });
      const n = r.json?.count ?? r.json?.competitions?.length ?? 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: `${r.code}: ${String(r.text).slice(0,80)}` };
      return { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 个可用赛事` };
    } },
  { name: "football-data.co.uk CSV", cat: "API赔率", signal: "历史赛果+历史赔率(20联赛)", run: async () => {
      const season = (() => { const [y,m]=today.split("-").map(Number); const s=m>=7?y:y-1; return `${String(s).slice(-2)}${String(s+1).slice(-2)}`; })();
      const r = await hit(`https://www.football-data.co.uk/mmz4281/${season}/E0.csv`, { raw: true });
      const lines = r.ok ? r.text.split(/\r?\n/).filter(Boolean).length : 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      return lines > 1
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: lines - 1, detail: `E0(英超)季 ${season} 共 ${lines-1} 行赛果赔率` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "CSV 空" };
    } },

  // ── 免 key 公共源 ──
  { name: "ClubElo 评级", cat: "评级/特征", signal: "球队 Elo/强度", run: async () => {
      const r = await hit(`http://api.clubelo.com/${today}`, { raw: true });
      const lines = r.ok ? r.text.split(/\r?\n/).filter(Boolean).length : 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      return lines > 1
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: lines - 1, detail: `${lines-1} 支球队 Elo` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "空" };
    } },
  { name: "Open-Meteo 天气", cat: "评级/特征", signal: "世界杯场馆温度/海拔→λ", run: async () => {
      const g = await hit("https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1");
      const lat = g.json?.results?.[0]?.latitude, lon = g.json?.results?.[0]?.longitude;
      if (!g.ok || lat == null) return { label: "存疑", status: "fail", httpCode: g.code, latencyMs: g.latencyMs, detail: "geocoding 失败" };
      const f = await hit(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m`);
      const pts = f.json?.hourly?.temperature_2m?.length ?? 0;
      return f.ok && pts > 0
        ? { label: "实测", status: "pass", httpCode: f.code, latencyMs: g.latencyMs + f.latencyMs, evidence: pts, detail: `geocoding+forecast 通,${pts} 小时温度点` }
        : { label: "存疑", status: "fail", httpCode: f.code, latencyMs: f.latencyMs, detail: "forecast 失败" };
    } },
  { name: "GDELT 新闻检索", cat: "评级/特征", signal: "球队动机/新闻信号", run: async () => {
      const r = await hit("https://api.gdeltproject.org/api/v2/doc/doc?query=football%20match&mode=artlist&format=json&maxrecords=5");
      const n = r.json?.articles?.length ?? 0;
      if (!r.ok) return { label: "存疑", status: "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
      return n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 条新闻` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "200 但无文章(查询窄)" };
    } },
  { name: "OpenLigaDB(德甲)", cat: "免key赛果", signal: "德语区赛程/赛果", run: async () => {
      const r = await hit("https://api.openligadb.de/getmatchdata/bl1/2024");
      const n = Array.isArray(r.json) ? r.json.length : 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 场赛果` }
        : { label: "存疑", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || (r.ok ? "空" : `HTTP ${r.code}`) };
    } },
  { name: "ESPN scoreboard(eng.1)", cat: "免key赛果", signal: "国际赛/赛果/冗余欧赔", run: async () => {
      const r = await hit("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard");
      const n = r.json?.events?.length ?? 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 场赛事` }
        : { label: "推断", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.ok ? "当前无赛事(休赛期)" : (r.err || `HTTP ${r.code}`) };
    } },
  { name: "FPL bootstrap(英超伤停)", cat: "免key伤停", signal: "injury(仅英超)", run: async () => {
      const r = await hit("https://fantasy.premierleague.com/api/bootstrap-static/");
      const inj = (r.json?.elements ?? []).filter((p) => ["i","d","s"].includes(p.status)).length;
      return r.ok && inj > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: inj, detail: `${inj} 名伤停/疑似/停赛(仅英超)` }
        : { label: "存疑", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || (r.ok ? "无伤停" : `HTTP ${r.code}`) };
    } },
  { name: "StatsBomb Open Data", cat: "历史训练", signal: "历史事件级 xG(精选赛事)", run: async () => {
      const r = await hit("https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json");
      const n = Array.isArray(r.json) ? r.json.length : 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 个赛季事件包(历史精选,不滚动)` }
        : { label: "存疑", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
    } },
  { name: "openfootball GitHub", cat: "历史训练", signal: "历史赛程/赛果 JSON", run: async () => {
      const r = await hit("https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json");
      const n = r.json?.matches?.length ?? 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `英超 24-25 共 ${n} 场` }
        : { label: "存疑", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || `HTTP ${r.code}` };
    } },
  { name: "ScoreBat 视频/资讯", cat: "历史训练", signal: "比赛视频/资讯上下文", run: async () => {
      const r = await hit("https://www.scorebat.com/video-api/v3/");
      const n = r.json?.response?.length ?? 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 条视频资讯` }
        : { label: "推断", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.err || (r.ok ? "空" : `HTTP ${r.code}`) };
    } },

  // ── 已知反爬/空壳(验证现状)──
  { name: "Understat(xG)", cat: "反爬验证", signal: "俱乐部 xG", run: async () => {
      const r = await hit("https://understat.com/league/EPL/2024", { raw: true });
      const has = typeof r.text === "string" && r.text.includes("datesData");
      return r.ok && has
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, detail: "含 xG JSON(需 dump 解析)" }
        : { label: "存疑", status: "blocked", httpCode: r.code, latencyMs: r.latencyMs, detail: "反爬空壳/无 datesData(需浏览器会话)" };
    } },
  { name: "ESPN injuries(eng.1)", cat: "反爬验证", signal: "五大联赛伤停", run: async () => {
      const r = await hit("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries");
      const tot = Array.isArray(r.json?.injuries) ? r.json.injuries.reduce((s,t)=>s+(t.injuries?.length||0),0) : 0;
      return tot > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: tot, detail: `${tot} 条` }
        : { label: "存疑", status: "empty", httpCode: r.code, latencyMs: r.latencyMs, detail: "ESPN 足球 injuries feed 不喂数据(已知)" };
    } },
  { name: "TheSportsDB free(key=3)", cat: "反爬验证", signal: "赛程/首发", run: async () => {
      const r = await hit("https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4328");
      const n = r.json?.events?.length ?? 0;
      return r.ok && n > 0
        ? { label: "实测", status: "pass", httpCode: r.code, latencyMs: r.latencyMs, evidence: n, detail: `${n} 场赛程(首发多付费档)` }
        : { label: "存疑", status: r.ok ? "empty" : "fail", httpCode: r.code, latencyMs: r.latencyMs, detail: r.ok ? "无赛程(免费档限流/休赛)" : `HTTP ${r.code}` };
    } }
];

const results = [];
for (const p of PROBES) {
  let out;
  try { out = await p.run(); }
  catch (e) { out = { label: "存疑", status: "fail", detail: `探针异常: ${e.message}` }; }
  results.push({ name: p.name, cat: p.cat, signal: p.signal, ...out });
  const icon = { 实测: "✅", 推断: "🔶", 存疑: "⚠️" }[out.label] || "❓";
  process.stderr.write(`${icon} ${p.name.padEnd(28)} ${out.status.padEnd(7)} ${out.detail || ""}\n`);
}
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir, getExportDir } from "../src/paths.js";

const payload = { probedAt: new Date().toISOString(), date: today, results };

// 稳定归档目录(exports 根每日 16:01 被清空,故落 data 子目录)+ 与上次对比告警。
const archiveDir = getDataSubdir("source-health");
mkdirSync(archiveDir, { recursive: true });

// 取上一份归档做对比(按文件名日期排序,排除今天)。
let previous = null;
try {
  const files = readdirSync(archiveDir).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `health-${today}.json`).sort();
  if (files.length) previous = JSON.parse(readFileSync(join(archiveDir, files[files.length - 1]), "utf8"));
} catch {}

const prevByName = new Map((previous?.results ?? []).map((r) => [r.name, r.label]));
const regressions = [];   // 实测→存疑(变坏)
const recoveries = [];    // 存疑→实测(恢复)
for (const r of results) {
  const before = prevByName.get(r.name);
  if (!before) continue;
  if (before === "实测" && r.label === "存疑") regressions.push(r.name);
  if (before === "存疑" && r.label === "实测") recoveries.push(r.name);
}

const ok = results.filter((r) => r.label === "实测").length;
const weak = results.length - ok;
payload.summary = { total: results.length, ok, weak };
payload.delta = previous ? { since: previous.date, regressions, recoveries } : null;

// 落盘:稳定归档(带日期)+ exports 即时快照(供 health 链路读取)。
writeFileSync(join(archiveDir, `health-${today}.json`), JSON.stringify(payload, null, 2), "utf8");
mkdirSync(getExportDir(), { recursive: true });
writeFileSync(join(getExportDir(), "health-probe-result.json"), JSON.stringify(payload, null, 2), "utf8");

process.stderr.write(`\n体检小结:✅实测 ${ok} / ⚠️存疑 ${weak}（共 ${results.length}）\n`);
if (previous) {
  if (regressions.length) process.stderr.write(`🔴 较 ${previous.date} 变坏(实测→存疑): ${regressions.join("、")}\n`);
  if (recoveries.length) process.stderr.write(`🟢 较 ${previous.date} 恢复(存疑→实测): ${recoveries.join("、")}\n`);
  if (!regressions.length && !recoveries.length) process.stderr.write(`➖ 较 ${previous.date} 无变化\n`);
}
console.log(JSON.stringify(payload, null, 2));
