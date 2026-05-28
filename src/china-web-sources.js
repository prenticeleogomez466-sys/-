import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataSubdir, getExportDir } from "./paths.js";
import { loadFixtures, saveFixtures } from "./fixture-store.js";
import { loadMarketSnapshots, saveMarketSnapshots } from "./market-data-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const registryPath = getDataSubdir("china-web-sources.json");
const chinaWebDir = getDataSubdir("china-web");
const exportDir = getExportDir();

const REQUEST_HEADERS = {
  "User-Agent": "football-ai-copilot/china-web-source-reader",
  Accept: "application/json,text/html,application/xhtml+xml"
};

// webapi.sporttery.cn 的 WAF 偶尔会对裸 Node 流量返回 HTTP 567 反爬挑战页。
// 用户可以从浏览器开发者工具复制一段已通过挑战的 Cookie 串
// 并放到 D:\football-model-data\local.env 里:
//   WEBAPI_SPORTTERY_COOKIE=cookie1=value1; cookie2=value2
// 抓取时就会带上,直到 cookie 过期或 WAF 策略变化。
// 同样支持 LOTTERY_GOV_CN_COOKIE(站点同源,有时会用不同 cookie)。
// 同时把 UA / Origin 配成最近版 Chrome,降低被直接 reset 的概率。
function jingcaiRequestHeaders() {
  const headers = {
    "User-Agent": process.env.WEBAPI_SPORTTERY_USER_AGENT
      ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Origin: "https://www.lottery.gov.cn",
    Referer: "https://www.lottery.gov.cn/jc/jsq/zqspf/",
  };
  const cookie = [process.env.WEBAPI_SPORTTERY_COOKIE, process.env.LOTTERY_GOV_CN_COOKIE].filter(Boolean).join("; ");
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export async function readChinaWebSources(date, options = {}) {
  const normalizedDate = safeDate(date);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch，无法读取中国公开网页源");

  const registry = loadChinaWebSourceRegistry();
  const startedAt = new Date().toISOString();
  const sourceStatus = [];

  const jingcai = await readJingcaiSource(normalizedDate, fetchImpl, {
    withHistories: options.withHistories !== false,
    sourceStatus
  });
  const bulletins = await readJingcaiBulletins(normalizedDate, fetchImpl, sourceStatus);
  const shengfucai = await readShengfucaiSource(normalizedDate, fetchImpl, sourceStatus);

  const fixtureSync = options.syncFixtures ? syncOfficialFixtures(normalizedDate, jingcai.fixtures, shengfucai.fixtures) : null;
  const marketSync = options.syncFixtures ? syncOfficialMarket(normalizedDate, jingcai.marketSnapshots) : null;

  const result = {
    date: normalizedDate,
    ok: sourceStatus.some((source) => source.id === "lottery-gov-cn-jc-calculator" && source.ok) &&
      sourceStatus.some((source) => source.id === "sporttery-cn-ctzc-announcement" && source.ok),
    startedAt,
    generatedAt: new Date().toISOString(),
    registry,
    sourceStatus,
    summary: {
      jingcaiMatches: jingcai.fixtures.length,
      jingcaiMarketSnapshots: jingcai.marketSnapshots.length,
      jingcaiOddsHistoryMatches: jingcai.matches.filter((match) => match.historyStatus?.had || match.historyStatus?.hhad).length,
      shengfucaiIssue: shengfucai.selectedIssue?.issue ?? null,
      shengfucaiMatches: shengfucai.fixtures.length,
      bulletins: bulletins.rows.length,
      fixtureSynced: Boolean(fixtureSync?.saved),
      marketSynced: Boolean(marketSync?.saved)
    },
    jingcai,
    bulletins,
    shengfucai,
    fixtureSync,
    marketSync,
    warnings: buildWarnings(jingcai, shengfucai, sourceStatus)
  };

  if (options.save !== false) writeChinaWebAnalysis(result);
  return result;
}

export function loadChinaWebSourceRegistry() {
  if (!existsSync(registryPath)) return { policy: "", sources: [] };
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

function syncOfficialFixtures(date, jingcaiFixtures, shengfucaiFixtures) {
  const fixtures = [...jingcaiFixtures, ...shengfucaiFixtures];
  const saved = saveFixtures(date, fixtures, { source: "china-official-web:sporttery+lottery-gov-cn" });
  return { saved: true, fixtures: fixtures.length, path: join(getDataSubdir("fixtures"), `${date}.json`) };
}

function syncOfficialMarket(date, marketSnapshots) {
  const previous = loadMarketSnapshots(date).snapshots;
  const merged = mergeMarketSnapshots(previous, marketSnapshots);
  const saved = saveMarketSnapshots(date, merged, { source: "china-official-web:jczq-calculator" });
  return { saved: true, previous: previous.length, imported: marketSnapshots.length, snapshots: merged.length, path: join(getDataSubdir("market"), `${date}.json`) };
}

async function readJingcaiSource(date, fetchImpl, options) {
  const source = {
    id: "lottery-gov-cn-jc-calculator",
    name: "中国体彩网竞彩足球计算器",
    pageUrl: "https://www.lottery.gov.cn/jc/jsq/zqspf/",
    apiUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c"
  };
  const fetchedAt = new Date().toISOString();
  const jingcaiHeaders = jingcaiRequestHeaders();
  try {
    const payload = await fetchJson(fetchImpl, source.apiUrl, jingcaiHeaders);
    const matchInfoList = Array.isArray(payload.value?.matchInfoList) ? payload.value.matchInfoList : [];
    const rawMatches = matchInfoList.flatMap((day) => Array.isArray(day.subMatchList) ? day.subMatchList : []);
    const matchesForDate = rawMatches.filter((match) => safeDateOrNull(match.businessDate) === date);
    const historyByMatchId = new Map();

    if (options.withHistories) {
      for (const match of matchesForDate) {
        historyByMatchId.set(String(match.matchId), await readJingcaiHistories(fetchImpl, source.pageUrl, match.matchId, jingcaiHeaders));
      }
    }

    const matches = matchesForDate.map((match, index) => normalizeJingcaiMatch(match, date, index, historyByMatchId.get(String(match.matchId))));
    const marketSnapshots = matches.map((match) => match.marketSnapshot).filter(Boolean);
    const fixtures = matches.map((match) => match.fixture);

    options.sourceStatus.push({
      ...source,
      ok: payload.errorCode === "0",
      fetchedAt,
      lastUpdateTime: payload.value?.lastUpdateTime ?? null,
      rawMatches: rawMatches.length,
      dateMatches: matchesForDate.length,
      marketSnapshots: marketSnapshots.length
    });

    return {
      source,
      ok: payload.errorCode === "0",
      withHistories: options.withHistories,
      lastUpdateTime: payload.value?.lastUpdateTime ?? null,
      totalCount: payload.value?.totalCount ?? rawMatches.length,
      matches,
      fixtures,
      marketSnapshots
    };
  } catch (error) {
    options.sourceStatus.push({ ...source, ok: false, fetchedAt, error: error.message });
    return { source, ok: false, lastUpdateTime: null, totalCount: 0, matches: [], fixtures: [], marketSnapshots: [], error: error.message };
  }
}

async function readJingcaiHistories(fetchImpl, referer, matchId) {
  const histories = {};
  for (const poolCode of ["had", "hhad"]) {
    const url = `https://webapi.sporttery.cn/gateway/uniform/football/getOddsHistoryV1.qry?matchId=${encodeURIComponent(matchId)}&poolCode=${poolCode}`;
    try {
      const payload = await fetchJson(fetchImpl, url, { Referer: referer, ...REQUEST_HEADERS });
      histories[poolCode] = Array.isArray(payload.value?.[`${poolCode}List`]) ? payload.value[`${poolCode}List`] : [];
    } catch (error) {
      histories[poolCode] = [];
      histories[`${poolCode}Error`] = error.message;
    }
  }
  return histories;
}

async function readJingcaiBulletins(date, fetchImpl, sourceStatus) {
  const source = {
    id: "sporttery-cn-jc-bulletin",
    name: "竞彩网赛事公告",
    pageUrl: "https://www.sporttery.cn/ssgg/",
    apiUrl: "https://webapi.sporttery.cn/gateway/jc/common/gmBulletin.qry?page=1&pageSize=50&isShowHis=1"
  };
  const fetchedAt = new Date().toISOString();
  try {
    const payload = await fetchJson(fetchImpl, source.apiUrl, { Referer: source.pageUrl, ...REQUEST_HEADERS });
    const rows = (Array.isArray(payload.value?.data) ? payload.value.data : [])
      .filter((row) => isBulletinForDate(row, date))
      .map((row) => ({
        id: row.bulletinId,
        subject: row.bulletinSubject,
        content: row.bulletinContent,
        startTime: row.bulletinStarttime,
        endTime: row.bulletinEndtime
      }));
    sourceStatus.push({ ...source, ok: payload.errorCode === "0", fetchedAt, rows: rows.length });
    return { source, ok: payload.errorCode === "0", rows };
  } catch (error) {
    sourceStatus.push({ ...source, ok: false, fetchedAt, error: error.message });
    return { source, ok: false, rows: [], error: error.message };
  }
}

async function readShengfucaiSource(date, fetchImpl, sourceStatus) {
  const source = {
    id: "sporttery-cn-ctzc-announcement",
    name: "竞彩网传统足彩公告",
    pageUrl: "https://www.sporttery.cn/ctzc/zcgg/"
  };
  const fetchedAt = new Date().toISOString();
  try {
    const listHtml = await fetchText(fetchImpl, source.pageUrl, { ...REQUEST_HEADERS });
    const links = extractScheduleAnnouncementLinks(listHtml, source.pageUrl)
      .sort((left, right) => scoreAnnouncementForDate(right, date) - scoreAnnouncementForDate(left, date))
      .slice(0, 5);

    const parsedArticles = [];
    for (const link of links) {
      try {
        const html = await fetchText(fetchImpl, link.url, { Referer: source.pageUrl, ...REQUEST_HEADERS });
        parsedArticles.push(parseTraditionalFootballArticle(html, link.url, link.title));
      } catch (error) {
        parsedArticles.push({ url: link.url, title: link.title, ok: false, issues: [], error: error.message });
      }
    }

    const selectedIssue = selectShengfucaiIssue(parsedArticles.flatMap((article) => article.issues), date);
    const fixtures = selectedIssue ? selectedIssue.matches.map((match) => mapShengfucaiFixture(match, selectedIssue, date)) : [];
    sourceStatus.push({
      ...source,
      ok: Boolean(selectedIssue),
      fetchedAt,
      articleCandidates: links.length,
      parsedArticles: parsedArticles.length,
      selectedIssue: selectedIssue?.issue ?? null,
      fixtures: fixtures.length
    });

    return { source, ok: Boolean(selectedIssue), links, articles: parsedArticles, selectedIssue, fixtures };
  } catch (error) {
    sourceStatus.push({ ...source, ok: false, fetchedAt, error: error.message });
    return { source, ok: false, links: [], articles: [], selectedIssue: null, fixtures: [], error: error.message };
  }
}

function normalizeJingcaiMatch(match, date, index, histories = {}) {
  const sequence = String(match.matchNumStr ?? match.matchNum ?? index + 1);
  const homeTeam = String(match.homeTeamAbbName ?? match.homeTeamAllName ?? match.homeTeamName ?? "").trim();
  const awayTeam = String(match.awayTeamAbbName ?? match.awayTeamAllName ?? match.awayTeamName ?? "").trim();
  const matchDate = safeDateOrNull(match.matchDate) ?? date;
  const matchTime = String(match.matchTime ?? "").replace(/:00$/, "");
  const fixtureId = `jc-${date}-${safeName(sequence)}-${safeName(homeTeam)}-${safeName(awayTeam)}`;
  const hadHistory = histories.had ?? [];
  const hhadHistory = histories.hhad ?? [];
  const hadInitial = outcomeFromOddsRow(hadHistory.at(-1) ?? match.had);
  const hadCurrent = outcomeFromOddsRow(hadHistory.at(0) ?? match.had);
  const hhadInitial = outcomeFromOddsRow(hhadHistory.at(-1) ?? match.hhad);
  const hhadCurrent = outcomeFromOddsRow(hhadHistory.at(0) ?? match.hhad);
  const oddsUpdatedAt = latestOddsTime([hadHistory.at(0), hhadHistory.at(0), match.had, match.hhad]);
  const collectedAt = new Date().toISOString();
  const scoreTop = topScoreOdds(match.crs);
  const halfFullTop = topHalfFullOdds(match.hafu);

  return {
    matchId: match.matchId,
    sequence,
    businessDate: date,
    matchDate,
    matchTime,
    competition: match.leagueName ?? match.leagueAbbName ?? "",
    homeTeam,
    awayTeam,
    officialOdds: {
      had: normalizeOfficialOdds(match.had),
      hhad: normalizeOfficialOdds(match.hhad),
      scoreTop,
      halfFullTop
    },
    historyStatus: {
      had: hadHistory.length > 0,
      hhad: hhadHistory.length > 0,
      hadPoints: hadHistory.length,
      hhadPoints: hhadHistory.length,
      oddsUpdatedAt
    },
    fixture: {
      id: fixtureId,
      date,
      sequence,
      kickoff: `${matchDate} ${matchTime}`.trim(),
      competition: match.leagueName ?? match.leagueAbbName ?? "竞彩足球",
      homeTeam,
      awayTeam,
      marketType: "jingcai",
      tags: ["竞彩足球", "中国竞彩网官方"],
      source: "lottery.gov.cn/jc/jsq/zqspf",
      officialStatus: "official-web",
      officialFixtureId: match.matchId ?? null,
      notes: `官方业务日期=${date}; 比赛日期=${matchDate}; 赛事编号=${sequence}`
    },
    marketSnapshot: hadInitial || hadCurrent || hhadInitial || hhadCurrent ? {
      date,
      fixtureId,
      sequence,
      competition: match.leagueName ?? match.leagueAbbName ?? "",
      homeTeam,
      awayTeam,
      collectedAt,
      europeanOdds: hadInitial || hadCurrent ? { initial: hadInitial, current: hadCurrent } : null,
      handicapOdds: hhadInitial || hhadCurrent ? { initial: hhadInitial, current: hhadCurrent } : null,
      scoreOdds: scoreTop.length ? { top: scoreTop } : null,
      halfFullOdds: halfFullTop.length ? { top: halfFullTop } : null,
      source: "中国体彩网竞彩足球计算器"
    } : null
  };
}

function parseTraditionalFootballArticle(html, url, fallbackTitle) {
  const title = extractTitle(html) || fallbackTitle;
  const rows = extractTableRows(html);
  const issueMetadata = extractIssueMetadata(html);
  const groups = new Map();
  let currentIssue = null;
  let currentLeague = null;

  for (const originalCells of rows) {
    const cells = originalCells.filter(Boolean);
    if (!cells.length) continue;
    let cursor = 0;
    if (isIssue(cells[cursor])) {
      currentIssue = cells[cursor];
      currentLeague = null;
      cursor += 1;
    }
    if (!currentIssue) continue;
    if (!isIntegerString(cells[cursor])) {
      currentLeague = cells[cursor] ?? currentLeague;
      cursor += 1;
    }
    const sequence = cells[cursor];
    const homeTeam = cells[cursor + 1];
    const awayTeam = cells[cursor + 2];
    const matchDate = safeDateOrNull(cells[cursor + 3]);
    if (!isIntegerString(sequence) || !homeTeam || !awayTeam || !matchDate) continue;
    const sequenceNumber = Number(sequence);
    if (sequenceNumber < 1 || sequenceNumber > 14) continue;
    if (!groups.has(currentIssue)) groups.set(currentIssue, []);
    groups.get(currentIssue).push({
      issue: currentIssue,
      sequence: sequenceNumber,
      competition: currentLeague ?? "",
      homeTeam,
      awayTeam,
      matchDate
    });
  }

  const issues = [...groups.entries()]
    .map(([issue, matches]) => ({
      issue,
      url,
      title,
      ...(issueMetadata.get(issue) ?? {}),
      matches: dedupeIssueMatches(matches).sort((left, right) => left.sequence - right.sequence)
    }))
    .filter((issue) => issue.matches.length === 14);

  return { url, title, ok: issues.length > 0, issues };
}

function selectShengfucaiIssue(issues, date) {
  return [...issues].sort((left, right) => scoreIssue(right, date) - scoreIssue(left, date))[0] ?? null;
}

function scoreIssue(issue, date) {
  const issueNumber = Number(String(issue.issue).match(/\d+/)?.[0] ?? 0);
  const saleWindowScore = scoreSaleWindow(issue, date);
  if (saleWindowScore > 0) return saleWindowScore + issueNumber / 100000;
  const hasTargetDate = issue.matches.some((match) => match.matchDate === date);
  const hasNearDate = issue.matches.some((match) => daysBetween(date, match.matchDate) >= 0 && daysBetween(date, match.matchDate) <= 1);
  return (hasTargetDate ? 100000 : 0) + (hasNearDate ? 10000 : 0) + issueNumber;
}

function mapShengfucaiFixture(match, issue, date) {
  return {
    id: `sf-${String(issue.issue).match(/\d+/)?.[0] ?? "unknown"}-${String(match.sequence).padStart(2, "0")}-${safeName(match.homeTeam)}-${safeName(match.awayTeam)}`,
    date,
    sequence: String(match.sequence),
    kickoff: match.matchDate,
    competition: match.competition || "14场胜负彩",
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    marketType: "shengfucai",
    tags: ["14场胜负彩", "中国竞彩网官方"],
    source: issue.url,
    officialStatus: "official-web",
    officialFixtureId: `${issue.issue}-${match.sequence}`,
    notes: `官方期号=${issue.issue}; 开售=${issue.saleStart ?? "未知"}; 停售=${issue.saleStop ?? "未知"}; 比赛日期=${match.matchDate}; 14场主输出胜平负/胆双选全选，比分和半全场必须从已定胜平负派生`
  };
}

function writeChinaWebAnalysis(result) {
  mkdirSync(chinaWebDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  const rawPath = join(chinaWebDir, `${result.date}.json`);
  const jsonPath = join(exportDir, `china-web-source-analysis-${result.date}.json`);
  const markdownPath = join(exportDir, `china-web-source-analysis-${result.date}.md`);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(rawPath, payload, "utf8");
  writeFileSync(jsonPath, payload, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
  return { rawPath, jsonPath, markdownPath };
}

function renderMarkdown(result) {
  const statusRows = result.sourceStatus.map((source) =>
    `| ${source.name} | ${source.ok ? "通过" : "失败"} | ${source.dateMatches ?? source.fixtures ?? source.rows ?? source.rawMatches ?? 0} | ${source.error ?? source.lastUpdateTime ?? source.selectedIssue ?? ""} |`
  );
  const jingcaiRows = result.jingcai.matches.map((match) =>
    `| ${match.sequence} | ${match.competition} | ${match.homeTeam} vs ${match.awayTeam} | ${match.matchDate} ${match.matchTime} | ${formatOutcome(match.officialOdds.had)} | ${formatOutcome(match.officialOdds.hhad)} | ${match.historyStatus.hadPoints}/${match.historyStatus.hhadPoints} |`
  );
  const shengfucaiRows = (result.shengfucai.selectedIssue?.matches ?? []).map((match) =>
    `| ${match.sequence} | ${match.competition} | ${match.homeTeam} vs ${match.awayTeam} | ${match.matchDate} |`
  );
  return [
    `# 中国网站数据源分析 ${result.date}`,
    "",
    `生成时间：${result.generatedAt}`,
    `总状态：${result.ok ? "通过" : "未通过"}`,
    "",
    "## 数据源状态",
    "| 数据源 | 状态 | 读取数量 | 关键时间/期号 |",
    "|---|---:|---:|---|",
    ...statusRows,
    "",
    "## 竞彩足球官方读取",
    `- 场次数：${result.summary.jingcaiMatches}`,
    `- 市场快照：${result.summary.jingcaiMarketSnapshots}`,
    `- 官方最后更新时间：${result.jingcai.lastUpdateTime ?? "未知"}`,
    "",
    "| 编号 | 赛事 | 对阵 | 开赛 | 胜平负 | 让球胜平负 | 历史点数 |",
    "|---|---|---|---|---|---|---:|",
    ...jingcaiRows,
    "",
    "## 14场胜负彩官方读取",
    `- 期号：${result.shengfucai.selectedIssue?.issue ?? "未识别"}`,
    `- 开售：${result.shengfucai.selectedIssue?.saleStart ?? "未识别"}`,
    `- 停售：${result.shengfucai.selectedIssue?.saleStop ?? "未识别"}`,
    `- 场次数：${result.summary.shengfucaiMatches}`,
    `- 公告：${result.shengfucai.selectedIssue?.title ?? "未识别"}`,
    "",
    "| 序号 | 赛事 | 对阵 | 比赛日期 |",
    "|---:|---|---|---|",
    ...shengfucaiRows,
    "",
    "## 审核结论",
    ...result.warnings.map((warning) => `- ${warning}`),
    ""
  ].join("\n");
}

function extractIssueMetadata(html) {
  const text = cleanText(html);
  const metadata = new Map();
  const pattern = /(第\d+期)[\s\S]{0,1500}?开售时间：(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+停售时间：(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+开奖日期：(\d{4}-\d{2}-\d{2})/g;
  let match;
  while ((match = pattern.exec(text))) {
    const issue = match[1];
    if (metadata.has(issue)) continue;
    metadata.set(issue, {
      saleStart: toShanghaiIso(match[2], match[3]),
      saleStop: toShanghaiIso(match[4], match[5]),
      drawDate: match[6]
    });
  }
  return metadata;
}

function scoreSaleWindow(issue, date) {
  if (!issue.saleStart || !issue.saleStop) return 0;
  const target = new Date(`${date}T03:00:00+08:00`);
  const saleStart = new Date(issue.saleStart);
  const saleStop = new Date(issue.saleStop);
  if ([target, saleStart, saleStop].some((value) => Number.isNaN(value.getTime()))) return 0;
  if (target >= saleStart && target <= saleStop) {
    const hoursUntilStop = Math.max(0, (saleStop - target) / 3600000);
    return 300000 - Math.min(hoursUntilStop, 99999);
  }
  if (target < saleStart) {
    const hoursUntilStart = Math.max(0, (saleStart - target) / 3600000);
    return 200000 - Math.min(hoursUntilStart, 99999);
  }
  return 0;
}

function buildWarnings(jingcai, shengfucai, sourceStatus) {
  const warnings = [];
  if (!jingcai.fixtures.length) warnings.push("竞彩足球未读取到官方当日业务场次，正式推荐必须阻断或降级。");
  if (!shengfucai.fixtures.length) warnings.push("14场胜负彩未识别到完整 14 场，正式推荐必须阻断或降级。");
  if (jingcai.fixtures.length && jingcai.marketSnapshots.length !== jingcai.fixtures.length) warnings.push("竞彩足球赔率快照未覆盖全部官方场次。");
  if (jingcai.withHistories && jingcai.matches.some((match) => !match.historyStatus.had || !match.historyStatus.hhad)) warnings.push("部分竞彩比赛缺少胜平负/让球胜平负赔率历史，只能使用即时赔率。");
  if (sourceStatus.some((source) => !source.ok)) warnings.push("存在中国公开源读取失败，日报生成前需要审核 sourceStatus。");
  warnings.push("14场只用于胜平负、胆/双选/全选分析，不生成比分和半全场。");
  warnings.push("未把 500.com 作为默认源，避免安全拦截导致无人值守任务误判。");
  return warnings;
}

function extractScheduleAnnouncementLinks(html, baseUrl) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      url: resolveUrl(match[1], baseUrl),
      title: cleanText(match[2])
    }))
    .filter((link) => link.url && /\/ctzc\/zcgg\/\d+\/\d+\.html$/.test(link.url) && /奖期竞猜场次安排/.test(link.title));
}

function scoreAnnouncementForDate(link, date) {
  const rangeScore = announcementCoversDate(link.title, date) ? 100000 : 0;
  const hrefDate = Number(link.url.match(/\/(\d{8})\//)?.[1] ?? 0);
  return rangeScore + hrefDate;
}

function announcementCoversDate(title, date) {
  const target = new Date(`${date}T00:00:00+08:00`);
  const year = target.getFullYear();
  const match = String(title).match(/(\d{1,2})月(\d{1,2})日-(?:(\d{1,2})月)?(\d{1,2})日/);
  if (!match) return false;
  const startMonth = Number(match[1]);
  const startDay = Number(match[2]);
  const endMonth = Number(match[3] ?? match[1]);
  const endDay = Number(match[4]);
  const start = new Date(`${year}-${pad2(startMonth)}-${pad2(startDay)}T00:00:00+08:00`);
  const end = new Date(`${year}-${pad2(endMonth)}-${pad2(endDay)}T23:59:59+08:00`);
  return target >= start && target <= end;
}

function extractTableRows(html) {
  return [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((row) => [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanText(cell[1])))
    .filter((cells) => cells.length);
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const response = await fetchWithRetry(fetchImpl, url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

async function fetchText(fetchImpl, url, headers = {}) {
  const response = await fetchWithRetry(fetchImpl, url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  return text;
}

async function fetchWithRetry(fetchImpl, url, options = {}) {
  const attempts = Number(process.env.CHINA_SOURCE_RETRY_ATTEMPTS ?? 3);
  const timeoutMs = Number(process.env.CHINA_SOURCE_TIMEOUT_MS ?? 12000);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(String(url), { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok || attempt === attempts || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === attempts) break;
    }
    await sleep(300 * attempt);
  }
  throw lastError ?? new Error(`请求失败：${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOfficialOdds(value = {}) {
  const outcome = outcomeFromOddsRow(value);
  if (!outcome) return null;
  return {
    ...outcome,
    goalLine: value.goalLine ?? value.goalLineValue ?? "",
    updateTime: combineDateTime(value.updateDate, value.updateTime)
  };
}

function outcomeFromOddsRow(value = {}) {
  const home = Number(value.h ?? value.home);
  const draw = Number(value.d ?? value.draw);
  const away = Number(value.a ?? value.away);
  return [home, draw, away].every((item) => Number.isFinite(item) && item > 1) ? { home, draw, away } : null;
}

function topScoreOdds(value = {}, limit = 5) {
  return Object.entries(value ?? {})
    .map(([key, odds]) => {
      const match = key.match(/^s(\d{2})s(\d{2})$/);
      const price = Number(odds);
      if (!match || !Number.isFinite(price) || price <= 1) return null;
      return { score: `${Number(match[1])}-${Number(match[2])}`, odds: price };
    })
    .filter(Boolean)
    .sort((left, right) => left.odds - right.odds)
    .slice(0, limit);
}

function topHalfFullOdds(value = {}, limit = 5) {
  const labels = { h: "胜", d: "平", a: "负" };
  return Object.entries(value ?? {})
    .map(([key, odds]) => {
      const match = key.match(/^([hda])([hda])$/);
      const price = Number(odds);
      if (!match || !Number.isFinite(price) || price <= 1) return null;
      return { halfFull: `${labels[match[1]]}${labels[match[2]]}`, odds: price };
    })
    .filter(Boolean)
    .sort((left, right) => left.odds - right.odds)
    .slice(0, limit);
}

function latestOddsTime(rows) {
  return rows.map((row) => combineDateTime(row?.updateDate, row?.updateTime)).filter(Boolean).sort().at(-1);
}

function combineDateTime(date, time) {
  if (!date || !time) return null;
  const normalizedTime = String(time).length === 5 ? `${time}:00` : String(time);
  const parsed = new Date(`${date}T${normalizedTime}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toShanghaiIso(date, time) {
  const parsed = new Date(`${date}T${time}:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatOutcome(value) {
  if (!value) return "缺";
  const line = value.goalLine ? `(${value.goalLine}) ` : "";
  return `${line}胜${value.home}/平${value.draw}/负${value.away}`;
}

function mergeMarketSnapshots(previous, next) {
  const map = new Map(previous.map((snapshot) => [marketKey(snapshot), snapshot]));
  for (const snapshot of next) map.set(marketKey(snapshot), { ...(map.get(marketKey(snapshot)) ?? {}), ...snapshot });
  return [...map.values()];
}

function marketKey(snapshot) {
  return snapshot.fixtureId || `${normalizeName(snapshot.homeTeam)}-${normalizeName(snapshot.awayTeam)}`;
}

function dedupeIssueMatches(matches) {
  const map = new Map();
  for (const match of matches) map.set(String(match.sequence), match);
  return [...map.values()];
}

function isBulletinForDate(row, date) {
  const monthDay = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  return String(row.bulletinStarttime ?? "").startsWith(date) ||
    String(row.bulletinEndtime ?? "").startsWith(date) ||
    String(row.bulletinSubject ?? "").includes(monthDay) ||
    String(row.bulletinContent ?? "").includes(monthDay);
}

function resolveUrl(value, baseUrl) {
  if (!value || value.startsWith("javascript:")) return null;
  if (value.startsWith("//")) return `https:${value}`;
  return new URL(value, baseUrl).toString();
}

function cleanText(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function extractTitle(html) {
  return cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function isIssue(value) {
  return /^第\d+期$/.test(String(value ?? ""));
}

function isIntegerString(value) {
  return /^\d+$/.test(String(value ?? ""));
}

function safeDate(value) {
  const date = safeDateOrNull(value);
  if (!date) throw new Error(`无效日期：${value}`);
  return date;
}

function safeDateOrNull(value) {
  return String(value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function daysBetween(left, right) {
  const leftDate = new Date(`${left}T00:00:00+08:00`);
  const rightDate = new Date(`${right}T00:00:00+08:00`);
  return Math.round((rightDate - leftDate) / 86400000);
}

function safeName(value) {
  return normalizeName(value).replace(/^-+|-+$/g, "").slice(0, 56) || "unknown";
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
