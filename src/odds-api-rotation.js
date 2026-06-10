// The Odds API 免费层配额治理(缺陷#11,2026-06-10)。
//
// 背景:免费层 500 credits/月,2026-06-10 实测 remaining=1(~07-04 重置),主链
//   crawlTheOddsApi 未包 try/catch → 401 直接把整个 crawlMarketData 打崩(任务 0x1)。
// 三件套(全免费,绝不接付费):
//   1) 多免费 key 轮换:从 env/local.env(src/env.js 已加载)读 key 列表,
//      ODDS_API_KEY + ODDS_API_KEYS=key1,key2 + ODDS_API_KEY_2..ODDS_API_KEY_9;
//      401(无效/配额尽)/429(限流)自动切下一个 key。
//   2) 市场分级省配额:世界杯窗口(2026-06-11~07-19)只拉 h2h+totals(1X2+大小球,
//      正是世界杯推荐要的),且默认只拉 soccer_fifa_world_cup 一个 sport
//      (欧洲俱乐部赛季 6/11-7/19 休赛;竞彩俱乐部盘主源是 500.com,不靠这里)
//      —— 调用次数 7→1/轮,配额省 ~85%。平时保持 h2h,spreads + 俱乐部联赛列表。
//      ODDS_API_SPORTS / ODDS_API_MARKETS 显式配置时永远优先。
//   3) 配额尽 = 优雅降级不编数据:轮换全军覆没时返回结构化 quotaExhausted,调用方
//      把"外盘缺失"如实写进 sources/状态产物,继续走 500 等合法免费源,绝不伪造。
import "./env.js";

const NUMBERED_KEY_MAX = 9;
// The Odds API 配额/鉴权类状态码:401=key 无效或配额耗尽(实测),429=限流。换 key 有意义。
// 其他状态码(404/422/5xx)与 key 无关,换 key 只会白烧请求,不轮换。
const QUOTA_STATUSES = new Set([401, 429]);

export const WORLD_CUP_WINDOW = { start: "2026-06-11", end: "2026-07-19" };
const DEFAULT_CLUB_SPORTS = "soccer_epl,soccer_spain_la_liga,soccer_germany_bundesliga,soccer_italy_serie_a,soccer_france_ligue_one,soccer_portugal_primeira_liga,soccer_norway_eliteserien";
const WC_SPORTS = "soccer_fifa_world_cup";

export function listOddsApiKeys(env = process.env) {
  const keys = [];
  const push = (value) => {
    for (const piece of String(value ?? "").split(/[,;\s]+/)) {
      const key = piece.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  };
  push(env.ODDS_API_KEY);
  push(env.ODDS_API_KEYS);
  for (let i = 2; i <= NUMBERED_KEY_MAX; i++) push(env[`ODDS_API_KEY_${i}`]);
  return keys;
}

export function isWorldCupWindow(date) {
  const d = String(date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= WORLD_CUP_WINDOW.start && d <= WORLD_CUP_WINDOW.end;
}

// 市场分级:世界杯窗口只拉 h2h+totals;平时 h2h+spreads(亚盘)。显式 env 永远优先。
export function oddsApiMarketsForDate(date, env = process.env) {
  if (env.ODDS_API_MARKETS) return env.ODDS_API_MARKETS;
  return isWorldCupWindow(date) ? "h2h,totals" : "h2h,spreads";
}

// sport 分级:世界杯窗口默认只拉世界杯(降低调用频次 7→1);显式 env 永远优先。
export function oddsApiSportsForDate(date, env = process.env) {
  const raw = env.ODDS_API_SPORTS || (isWorldCupWindow(date) ? WC_SPORTS : DEFAULT_CLUB_SPORTS);
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * 带多 key 轮换的 The Odds API 请求。
 * @param {(key: string) => string|URL} buildUrl 用给定 key 构造完整请求 URL
 * @param {{ fetch?: typeof fetch, env?: object, timeoutMs?: number, headers?: object }} options
 * @returns 成功:{ ok:true, response, keyIndex, keyCount, used, remaining, attempts }
 *          失败:{ ok:false, quotaExhausted?, noKey?, status?, error, attempts }(绝不抛,调用方决定降级口径)
 */
export async function fetchOddsApiRotating(buildUrl, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const timeoutMs = Number(options.timeoutMs ?? env.ODDS_CRAWLER_TIMEOUT_MS ?? 15000);
  const keys = listOddsApiKeys(env);
  const attempts = [];
  if (!keys.length) {
    return { ok: false, noKey: true, attempts, error: "缺少 ODDS_API_KEY(免费多 key 可配 ODDS_API_KEYS=key1,key2 或 ODDS_API_KEY_2..9,均放 local.env)" };
  }
  if (typeof fetchImpl !== "function") return { ok: false, attempts, error: "当前 Node 环境不支持 fetch" };
  for (let i = 0; i < keys.length; i++) {
    let response;
    try {
      response = await fetchImpl(String(buildUrl(keys[i])), {
        headers: { "User-Agent": "football-ai-copilot/odds-api-rotation", ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // 网络层错误与 key 无关(同一 host),换 key 结果相同 → 直接失败,如实报错。
      attempts.push({ keyIndex: i, error: error.message });
      return { ok: false, attempts, error: `The Odds API 网络错误:${error.message}` };
    }
    if (response.ok) {
      return {
        ok: true,
        response,
        keyIndex: i,
        keyCount: keys.length,
        used: response.headers?.get?.("x-requests-used") ?? null,
        remaining: response.headers?.get?.("x-requests-remaining") ?? null,
        attempts
      };
    }
    const status = response.status;
    let bodyHead = "";
    try { bodyHead = (await response.text()).slice(0, 160); } catch { /* body 读不到不影响判定 */ }
    attempts.push({ keyIndex: i, status, body: bodyHead });
    if (!QUOTA_STATUSES.has(status)) {
      return { ok: false, status, attempts, error: `The Odds API HTTP ${status}: ${bodyHead}` };
    }
    // 401/429 → 该 key 配额尽/无效/被限流,轮换下一个免费 key。
  }
  return {
    ok: false,
    quotaExhausted: true,
    status: attempts.at(-1)?.status ?? null,
    attempts,
    error: `The Odds API 全部 ${keys.length} 个免费 key 配额耗尽/无效(401/429)——外盘本轮缺失,如实标注,等待免费层月度配额重置(500/月),绝不编数据`
  };
}
