/**
 * ClubElo 加载器(2026-05-31 学习轮 15)
 * ─────────────────────────────────────────────────────────────
 * clubelo.com 免 key CSV API(实测 headless 可抓,零反爬):
 *   http://api.clubelo.com/<YYYY-MM-DD>  → 当日全球俱乐部 Elo 快照
 *   http://api.clubelo.com/<ClubName>    → 该队 1939 至今 Elo 历史(带 From/To)
 * CSV 头:Rank,Club,Country,Level,Elo,From,To
 *
 * 用途(补模型缺口:跨联赛球队实力 Elo):
 *   - 跨联赛公平比较的实力先验;
 *   - 与轮8经验贝叶斯收缩协同 —— 出场少的队收缩向 Elo 先验而非中性 1.0(下一轮接 DC)。
 * 本模块只负责抓取+解析+缓存,纯数据层。映射到中文 canonical / 接 DC 是下游。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./paths.js";

const BASE = "http://api.clubelo.com";

/** 解析 ClubElo CSV → [{rank, club, country, level, elo, from, to}]。容错:跳过空行/列不足。 */
export function parseClubEloCsv(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]?.split(",") ?? [];
  const idx = (name) => header.indexOf(name);
  const iClub = idx("Club"), iCountry = idx("Country"), iLevel = idx("Level"), iElo = idx("Elo"), iFrom = idx("From"), iTo = idx("To"), iRank = idx("Rank");
  if (iClub < 0 || iElo < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < header.length) continue;
    const elo = Number(c[iElo]);
    const club = (c[iClub] || "").trim();
    if (!club || !Number.isFinite(elo)) continue;
    out.push({
      rank: c[iRank] === "None" ? null : Number(c[iRank]),
      club,
      country: (c[iCountry] || "").trim(),
      level: Number(c[iLevel]) || null,
      elo,
      from: (c[iFrom] || "").trim() || null,
      to: (c[iTo] || "").trim() || null,
    });
  }
  return out;
}

/** 抓某日 Elo 快照(默认带 24h 磁盘缓存,过夜重跑不重复打网络)。返回 {club→row} map + 数组。 */
export async function fetchClubEloSnapshot(date, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const cacheDir = join(getDataDir(), "clubelo");
  const cachePath = join(cacheDir, `snapshot-${date}.csv`);
  let text = null;
  if (!opts.noCache && existsSync(cachePath)) {
    text = readFileSync(cachePath, "utf8");
  } else {
    try {
      const r = await fetchImpl(`${BASE}/${date}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, rows: [], byClub: new Map() };
      text = await r.text();
      try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cachePath, text, "utf8"); } catch { /* 缓存失败不致命 */ }
    } catch (e) {
      return { ok: false, error: e.message, rows: [], byClub: new Map() };
    }
  }
  const rows = parseClubEloCsv(text);
  const byClub = new Map();
  for (const r of rows) byClub.set(normalizeClubKey(r.club), r);
  return { ok: rows.length > 0, rows, byClub, date };
}

/** clubelo 队名归一(小写去空格点),供与 team-aliases 对接的下游匹配用。 */
export function normalizeClubKey(name) {
  return String(name || "").toLowerCase().replace(/[.\s'’-]/g, "");
}

/** Elo → 主胜隐含概率(标准 Elo 公式 + 主场加成,默认 +65 分≈主场优势)。供回测/先验用。 */
export function eloWinProb(homeElo, awayElo, homeBonus = 65) {
  if (!Number.isFinite(homeElo) || !Number.isFinite(awayElo)) return null;
  const d = homeElo + homeBonus - awayElo;
  return 1 / (1 + Math.pow(10, -d / 400));
}
