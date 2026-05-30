// 500.com 竞彩兜底注入器
// 背景:官方源(lottery.gov.cn / sporttery.cn / webapi.sporttery.cn)在本机被反爬封锁
//   - lottery.gov.cn 返回 HTTP 567(WAF 反爬挑战)
//   - sporttery.cn / webapi.sporttery.cn TLS 握手被直接拒绝(SEC_E_INVALID_TOKEN)
// 导致 readChinaWebSources 抓不到当日竞彩,实时源闸门硬挂、无人值守流水线天天空跑。
//
// 本脚本用 500.com 公开静态赔率 XML(已验证 HTTP 200、内容 UTF-8)兜底抓取当日竞彩:
//   - 胜平负:https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml
//   - 让球胜平负:https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml
// 解析成与 china-web-sources 官方读取相同的 fixture / marketSnapshot 形状,写入 store,
// 供 prediction-engine 以"市场推断 λ"产出竞彩推荐。
// 来源诚实标记为 500.com-fallback(不冒充官方源)。
//
// 用法:node scripts/ingest-500-jingcai-fallback.mjs --date=2026-05-30

import "../src/env.js";
import { saveFixtures, loadFixtures } from "../src/fixture-store.js";
import { saveMarketSnapshots, loadMarketSnapshots } from "../src/market-data-store.js";
import { scopeJingcaiFixtures } from "../src/jingcai-business-day.js";

const SPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml";
const NSPF_URL = "https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml";
const REFERER = "https://trade.500.com/jczq/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  const [spfXml, nspfXml] = await Promise.all([fetchXml(SPF_URL), fetchXml(NSPF_URL)]);
  const spf = parseMatches(spfXml);
  const nspf = parseMatches(nspfXml);

  // 业务批次 = 竞彩编号系列(6xxx=本批/周六单,7xxx=下一批),与 kickoff 日期无关:
  //   同一张竞彩单里晚场会跨到次日凌晨开球(如 6014 欧冠决赛/6015 国际赛 kickoff 在 date+1),
  //   旧逻辑 `m.date === date` 把它们漏掉(15 场只抓到 13)。改为:先取当日场次定位本批系列,
  //   再纳入该系列全部场次(含次日凌晨开球的同批场)。修复 2026-05-30。
  const seriesOf = (m) => String(m.matchnum ?? "").slice(0, -3);
  const datedToday = spf.filter((m) => m.date === date);
  if (!datedToday.length) {
    console.log(JSON.stringify({ ok: false, date, reason: "500 源当日无竞彩场次", spfTotal: spf.length }, null, 2));
    return;
  }
  const todaySeries = new Set(datedToday.map(seriesOf).filter(Boolean));
  const todays = spf.filter((m) => todaySeries.has(seriesOf(m)));

  const nspfByNum = new Map(nspf.map((m) => [m.matchnum, m]));
  const collectedAt = new Date().toISOString();
  const fixtures = [];
  const snapshots = [];

  for (const m of todays) {
    const fixtureId = `jc500-${date}-${m.matchnum}-${safeName(m.home)}-${safeName(m.away)}`;
    const euro = oddsSet(m, "win", "draw", "lost");          // 胜平负 = 欧赔
    const handicap = (() => {
      const h = nspfByNum.get(m.matchnum);
      return h ? oddsSet(h, "win", "draw", "lost") : null;   // 让球胜平负
    })();
    const goalLine = nspfByNum.get(m.matchnum)?.latest?.goalline ?? "";

    fixtures.push({
      id: fixtureId,
      date,
      sequence: m.matchnum,
      kickoff: `${m.date} ${m.matchtime ?? ""}`.trim(),
      competition: m.league || "竞彩足球",
      homeTeam: m.home,
      awayTeam: m.away,
      marketType: "jingcai",
      tags: ["竞彩足球", "500.com兜底"],
      source: "500.com-jczq-fallback",
      officialStatus: "fallback-500",
      officialFixtureId: m.id ?? null,
      notes: `500.com 兜底(官方源被反爬封锁);业务日期=${date};编号=${m.matchnum}`
    });

    snapshots.push({
      date,
      fixtureId,
      sequence: m.matchnum,
      marketType: "jingcai",
      competition: m.league || "竞彩足球",
      homeTeam: m.home,
      awayTeam: m.away,
      collectedAt,
      europeanOdds: euro,
      handicapOdds: handicap,
      source: "500.com-jczq-fallback"
    });
  }

  // 合并既有 fixture(保留官方 14 场/其它源),只替换 500 兜底竞彩 —— 不破坏官方数据。
  const keepFixtures = loadFixtures(date).fixtures.filter((f) => f.source !== "500.com-jczq-fallback");
  const mergedSource = keepFixtures.length
    ? `merged:${[...new Set(keepFixtures.map((f) => f.source).filter(Boolean))].join("+")}+500.com-jczq-fallback`
    : "500.com-jczq-fallback";
  // 按业务日覆盖式落盘:对合并后的竞彩限当日 + 跨源去重(周六 vs 6001 重复 / 周日次日),
  // 避免反复兜底把场次越叠越多(17→35→48)。14 场/其它源原样保留。
  const scopedFixtures = scopeJingcaiFixtures(date, [...keepFixtures, ...fixtures]);
  const fixturesSaved = saveFixtures(date, scopedFixtures, { source: mergedSource });
  // 合并既有快照(不破坏其它源),再保存
  const previous = loadMarketSnapshots(date).snapshots.filter((s) => s.source !== "500.com-jczq-fallback");
  const marketSaved = saveMarketSnapshots(date, [...previous, ...snapshots], { source: mergedSource });

  console.log(JSON.stringify({
    ok: true,
    date,
    fixtures: fixturesSaved.fixtures.length,
    snapshots: snapshots.length,
    fixturePath: `data/fixtures/${date}.json`,
    marketPath: marketSaved.path,
    sample: todays.map((m) => `${m.matchnum} ${m.league} ${m.home} vs ${m.away} 胜平负=${m.latest.win}/${m.latest.draw}/${m.latest.lost}`)
  }, null, 2));
}

async function fetchXml(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Referer: REFERER, Accept: "application/xml,text/xml,*/*" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`);
  const buf = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder("utf-8").decode(buf);
}

function parseMatches(xml) {
  const matches = [];
  for (const block of xml.match(/<m\b[^>]*>[\s\S]*?<\/m>/g) ?? []) {
    const head = block.slice(0, block.indexOf(">") + 1);
    const attrs = attrMap(head);
    const rows = [...block.matchAll(/<row\b([^>]*?)\/?>/g)].map((r) => attrMap(`<row ${r[1]}>`));
    if (!rows.length) continue;
    // 500 XML row 顺序:索引 0 = 最新即赔,末尾 = 最早开盘
    matches.push({
      id: attrs.id,
      matchnum: attrs.matchnum,
      date: (attrs.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? attrs.date,
      matchtime: attrs.matchtime,
      league: attrs.league,
      home: attrs.home,
      away: attrs.away,
      latest: rows[0],
      opening: rows[rows.length - 1],
      rows
    });
  }
  return matches;
}

function oddsSet(match, hKey, dKey, aKey) {
  const toRow = (r) => {
    const home = Number(r?.[hKey]); const draw = Number(r?.[dKey]); const away = Number(r?.[aKey]);
    return [home, draw, away].every((v) => Number.isFinite(v) && v > 1) ? { home, draw, away } : null;
  };
  const current = toRow(match.latest);
  const initial = toRow(match.opening) ?? current;
  if (!current && !initial) return null;
  return { initial, current };
}

function attrMap(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

function safeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

function readArg(name) {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
