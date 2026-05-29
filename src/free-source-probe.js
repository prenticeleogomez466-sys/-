/**
 * Free Source Probe(Y 档 — 免授权数据源在线探测)
 * ────────────────────────────────────────────────────────────
 * "继续全球找免授权源"是个反复要做的事。这里把候选源固化成可随时重跑的探测清单:
 * 实测每个 endpoint 现在能不能免 key 抓、返回的是不是真有内容(不只是 200 空壳),
 * 输出 usable / empty / blocked / error 四态,免得每次靠记忆猜。
 *
 * 2026-05-29 首测基线:FPL=usable(英超伤停);ESPN injuries=empty(足球 feed 不喂,
 * 连在赛季的 MLS 也 0);OpenLigaDB=usable 但只有赛果无伤停;TheSportsDB free=lineup empty;
 * Understat=blocked(反爬空壳)。
 */

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

// 每个源:probe 返回 { status:"usable"|"empty"|"blocked"|"error", detail, signal }
// signal = 它能供给模型的信号类型(injury/lineup/result/xg/odds),便于决定接不接。
const SOURCES = [
  {
    name: "FPL bootstrap-static",
    url: "https://fantasy.premierleague.com/api/bootstrap-static/",
    signal: "injury(英超)",
    judge: (j) => {
      const inj = (j?.elements ?? []).filter((p) => ["i", "d", "s"].includes(p.status)).length;
      return inj > 0 ? { status: "usable", detail: `${inj} 名伤停/疑似/停赛球员` } : { status: "empty", detail: "无伤停(休赛期?)" };
    }
  },
  {
    name: "ESPN injuries (eng.1)",
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries",
    signal: "injury(五大联赛)",
    judge: (j) => {
      const tot = Array.isArray(j?.injuries) ? j.injuries.reduce((s, t) => s + (t.injuries?.length || 0), 0) : 0;
      return tot > 0 ? { status: "usable", detail: `${tot} 条伤停` } : { status: "empty", detail: "ESPN 足球 injuries feed 不喂数据" };
    }
  },
  {
    name: "ESPN scoreboard (eng.1)",
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
    signal: "result/odds",
    judge: (j) => {
      const n = (j?.events ?? []).length;
      return n > 0 ? { status: "usable", detail: `${n} 场赛事` } : { status: "empty", detail: "无赛事(休赛期)" };
    }
  },
  {
    name: "OpenLigaDB (bl1/2024)",
    url: "https://api.openligadb.de/getmatchdata/bl1/2024",
    signal: "result(德甲)",
    judge: (j) => (Array.isArray(j) && j.length ? { status: "usable", detail: `${j.length} 场赛果(无伤停字段)` } : { status: "empty", detail: "空" })
  },
  {
    name: "TheSportsDB free (key=3)",
    url: "https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4328",
    signal: "fixture/lineup",
    judge: (j) => (j?.events?.length ? { status: "usable", detail: `${j.events.length} 场赛程(lineup 多为付费档)` } : { status: "empty", detail: "无赛程" })
  },
  {
    name: "Understat (EPL xG)",
    url: "https://understat.com/league/EPL/2024",
    signal: "xg",
    json: false,
    judge: (txt) => (typeof txt === "string" && txt.includes("datesData") ? { status: "usable", detail: "含 xG JSON" } : { status: "blocked", detail: "反爬空壳,无 datesData" })
  }
];

async function probeOne(src, fetchImpl) {
  try {
    const r = await fetchImpl(src.url, { headers: UA });
    if (!r.ok) return { name: src.name, signal: src.signal, status: "error", detail: `HTTP ${r.status}` };
    const body = src.json === false ? await r.text() : await r.json();
    const verdict = src.judge(body);
    return { name: src.name, signal: src.signal, ...verdict };
  } catch (e) {
    return { name: src.name, signal: src.signal, status: "error", detail: e.message };
  }
}

/**
 * 探测所有候选免授权源。
 * @param {{fetch?:Function, sources?:Array}} opts
 * @returns {Promise<{probedAt:string, results:Array, usableCount:number}>}
 */
export async function probeFreeSources(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const list = opts.sources ?? SOURCES;
  const results = [];
  for (const src of list) results.push(await probeOne(src, fetchImpl));
  return {
    results,
    usableCount: results.filter((r) => r.status === "usable").length
  };
}

export { SOURCES };
