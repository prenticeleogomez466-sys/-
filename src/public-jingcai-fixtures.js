/**
 * 公开 jingcai fixtures 兜底源
 * ──────────────────────────────────────────────────
 * 当 sporttery / lottery.gov.cn 当日 jingcai (竞彩 5/9 场单关 + 让球胜平负) fetch failed
 * (典型场景:白天 WAF 高峰、机器无浏览器指纹),从 500.com 备份抓取。
 *
 * 设计:
 *   - 主源:trade.500.com /jczq/(GBK 编码,需要 TextDecoder('gbk') 解码)
 *   - 备源:网易彩票 sports.163.com/caipiao/match/football/jczq (UTF-8)
 *   - 提取:今日开球的 fixture 列表 + 主胜/平/客胜 SP
 *   - 输出 shape 跟 china-web-sources.js 兼容,可直接 syncOfficialFixtures
 *
 * 注:由于反爬 + 编码 + DOM 结构会变,这个模块对失败容忍度很高 ——
 * 任何源失败都返回空,不抛错;失败原因写入 sourceStatus 给上游审计。
 *
 * 启用开关:JINGCAI_PUBLIC_FALLBACK_ENABLED(默认 "1");可设 "0" 强制禁用。
 */

const FIVEHUNDRED_BASE = "https://trade.500.com/jczq/";
const NETEASE_BASE = "https://sports.163.com/caipiao/match/football/jczq";

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
};

/**
 * 抓今日 jingcai fixtures(单关/让球胜平负)。
 *
 * @param {string} date  YYYY-MM-DD,只接当日比赛
 * @param {Function} fetchImpl  fetch 实现
 * @param {Object} env  环境变量
 * @returns {{ ok, fixtures, sourceStatus, warning }}
 */
export async function fetchPublicJingcaiFixtures(date, fetchImpl, env = process.env) {
  if (env.JINGCAI_PUBLIC_FALLBACK_ENABLED === "0") {
    return { ok: false, fixtures: [], sourceStatus: [], warning: "JINGCAI_PUBLIC_FALLBACK_ENABLED=0" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, fixtures: [], sourceStatus: [], warning: "fetch 不可用" };
  }

  const sourceStatus = [];
  const aggregated = [];

  // 主源:500.com
  try {
    const rows = await fetchFiveHundredJingcai(date, fetchImpl);
    aggregated.push(...rows);
    sourceStatus.push({ id: "500-jczq", ok: rows.length > 0, fixtures: rows.length });
  } catch (error) {
    sourceStatus.push({ id: "500-jczq", ok: false, error: error.message });
  }

  // 备源:网易彩票(只在 500 没拿到时跑)
  if (aggregated.length === 0) {
    try {
      const rows = await fetchNeteaseJingcai(date, fetchImpl);
      aggregated.push(...rows);
      sourceStatus.push({ id: "netease-caipiao", ok: rows.length > 0, fixtures: rows.length });
    } catch (error) {
      sourceStatus.push({ id: "netease-caipiao", ok: false, error: error.message });
    }
  }

  return {
    ok: aggregated.length > 0,
    fixtures: dedupeFixtures(aggregated),
    sourceStatus,
    warning: aggregated.length === 0 ? "公开 jingcai 兜底源全部失败,需要手动提供或等 sporttery 恢复" : null
  };
}

// ───── 500.com /jczq/ ─────

async function fetchFiveHundredJingcai(date, fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, FIVEHUNDRED_BASE, {
    headers: { ...DEFAULT_HEADERS, "Referer": "https://www.500.com/" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buf = await response.arrayBuffer();
  // 500.com 是 GBK 编码
  const html = new TextDecoder("gbk").decode(buf);
  return parseFiveHundredJingcaiHtml(html, date);
}

// 500.com HTML 结构(2026 状态):
//   <table id="jingcai" class="redbox">
//     <tr class="bet_item" rel="比赛id">
//       <td class="event">[联赛名]</td>
//       <td class="time">YYYY-MM-DD HH:MM</td>
//       <td class="team">主队 VS 客队</td>
//       <td class="odds_3">主胜SP</td>
//       <td class="odds_1">平局SP</td>
//       <td class="odds_0">客胜SP</td>
//     </tr>
//     ...
//   </table>
//
// 实际 DOM 会随站点改版调整。这里用宽松正则,提取每行所有需要的字段,
// 任何提取不到的字段视为该场无效跳过。
export function parseFiveHundredJingcaiHtml(html, date) {
  const fixtures = [];
  // 用宽松 row pattern:开球时间含日期 → 日期匹配
  const dateForMatch = String(date).replace(/-/g, "");
  // 多种已知 DOM 变体:tr 类含 "bet_item" / "match_row" / class="data" 等
  const rowRegex = /<tr[^>]*(?:bet_item|match_row|class="data")[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const datetime = extractCellText(rowHtml, ["time", "date", "kickoff"]);
    if (!datetime) continue;
    // 只接今日的比赛
    if (!datetime.includes(date) && !datetime.includes(dateForMatch)) continue;
    const competition = extractCellText(rowHtml, ["event", "league", "competition"]) || "未知联赛";
    const teamCell = extractCellText(rowHtml, ["team", "match", "vs"]);
    if (!teamCell) continue;
    const [home, away] = splitTeams(teamCell);
    if (!home || !away) continue;
    const oddsHome = Number(extractCellText(rowHtml, ["odds_3", "odds-home", "spf-3"]));
    const oddsDraw = Number(extractCellText(rowHtml, ["odds_1", "odds-draw", "spf-1"]));
    const oddsAway = Number(extractCellText(rowHtml, ["odds_0", "odds-away", "spf-0"]));
    fixtures.push({
      date,
      kickoff: datetime,
      competition,
      homeTeam: home,
      awayTeam: away,
      marketType: "jingcai",
      sequence: String(fixtures.length + 1),
      id: `jc-${date}-${home}-${away}`.replace(/\s+/g, ""),
      odds: {
        home: Number.isFinite(oddsHome) && oddsHome > 1 ? oddsHome : null,
        draw: Number.isFinite(oddsDraw) && oddsDraw > 1 ? oddsDraw : null,
        away: Number.isFinite(oddsAway) && oddsAway > 1 ? oddsAway : null
      },
      source: "500.com /jczq/"
    });
  }
  return fixtures;
}

// ───── 网易彩票 jczq ─────

async function fetchNeteaseJingcai(date, fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, NETEASE_BASE, {
    headers: { ...DEFAULT_HEADERS, "Referer": "https://sports.163.com/caipiao/" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // 网易是 UTF-8
  const html = await response.text();
  return parseNeteaseJingcaiHtml(html, date);
}

// 网易彩票 jczq 页面也是 JS 动态加载比较多,常见可解析路径是页内嵌入的 JSON:
//   <script>window.MATCH_DATA = {"matches":[{"competition":"...","home":"...","away":"...","time":"...","spf":{...}}, ...]}</script>
// 失败时返回空数组。
export function parseNeteaseJingcaiHtml(html, date) {
  const fixtures = [];
  const dataMatch = html.match(/window\.MATCH_DATA\s*=\s*(\{[\s\S]*?\});/);
  if (!dataMatch) return fixtures;
  try {
    const data = JSON.parse(dataMatch[1]);
    const matches = Array.isArray(data.matches) ? data.matches : [];
    for (const m of matches) {
      const time = String(m.time ?? m.kickoff ?? "");
      if (!time.includes(date)) continue;
      const home = String(m.home ?? m.homeTeam ?? "");
      const away = String(m.away ?? m.awayTeam ?? "");
      if (!home || !away) continue;
      fixtures.push({
        date,
        kickoff: time,
        competition: String(m.competition ?? m.league ?? "未知联赛"),
        homeTeam: home,
        awayTeam: away,
        marketType: "jingcai",
        sequence: String(fixtures.length + 1),
        id: `jc-${date}-${home}-${away}`.replace(/\s+/g, ""),
        odds: {
          home: Number(m.spf?.home ?? m.odds?.home ?? null) || null,
          draw: Number(m.spf?.draw ?? m.odds?.draw ?? null) || null,
          away: Number(m.spf?.away ?? m.odds?.away ?? null) || null
        },
        source: "163.com/caipiao"
      });
    }
  } catch {
    // JSON 解析失败时静默返回已收集的(可能为空)
  }
  return fixtures;
}

// ───── 工具 ─────

function extractCellText(rowHtml, classNames) {
  for (const className of classNames) {
    const pattern = new RegExp(`<t[dh][^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</t[dh]>`, "i");
    const m = rowHtml.match(pattern);
    if (m) return cleanText(m[1]);
  }
  return "";
}

function cleanText(html) {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTeams(cell) {
  // "主队 VS 客队" / "主队 vs 客队" / "主队-客队"
  const sep = /\s*(?:VS|vs|对|-)\s*/;
  const parts = cell.split(sep);
  if (parts.length < 2) return [null, null];
  return [parts[0].trim(), parts.slice(1).join(" ").trim()];
}

function dedupeFixtures(fixtures) {
  const seen = new Set();
  const out = [];
  for (const f of fixtures) {
    const key = `${f.homeTeam}__${f.awayTeam}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
