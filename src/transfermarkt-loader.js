/**
 * Transfermarkt 球员市值加载器
 * ──────────────────────────────────────────────────
 * 从 dcaribou/transfermarkt-datasets 公开 CSV 加载球员市值数据,
 * 作为球队实力先验特征.
 *
 * 数据源:https://github.com/dcaribou/transfermarkt-datasets/tree/master/data
 *   - clubs.csv  俱乐部基本信息 + 总市值
 *   - players.csv 球员市值 + 位置 + 国籍
 *   - player_valuations.csv 历史市值变化
 *
 * 用法:
 *   const tm = await loadTransfermarktClubValues();
 *   tm.getClubValue("Paris Saint-Germain");   // 总市值(欧元)
 *   tm.compareTeams(home, away);              // home/away 市值比
 *
 * 缓存:D:\football-model-data\transfermarkt\,TTL 30 天(市值更新慢).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { canonicalTeamName } from "./team-aliases.js";

const BASE_URL = "https://raw.githubusercontent.com/dcaribou/transfermarkt-datasets/master/data";
const DEFAULT_TTL_MINUTES = 60 * 24 * 30;  // 30 天

/**
 * 加载俱乐部市值数据.
 * @returns {{ ok, clubs, getClubValue, compareTeams }}
 */
export async function loadTransfermarktClubValues(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.TRANSFERMARKT_ENABLED === "0") {
    return { ok: false, warning: "TRANSFERMARKT_ENABLED=0", getClubValue: () => null, compareTeams: () => null };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, warning: "fetch 不可用", getClubValue: () => null, compareTeams: () => null };
  }
  try {
    const csv = await fetchCached("clubs.csv", fetchImpl, DEFAULT_TTL_MINUTES);
    const clubs = parseClubsCSV(csv);
    return {
      ok: true,
      clubs,
      getClubValue(teamName) {
        const canonical = canonicalTeamName(teamName);
        // 先精确匹配 canonical → club,再尝试 normalized fuzzy
        for (const club of clubs) {
          if (canonicalTeamName(club.name) === canonical) return club.totalMarketValueEur;
        }
        return null;
      },
      compareTeams(home, away) {
        const hv = this.getClubValue(home);
        const av = this.getClubValue(away);
        if (!Number.isFinite(hv) || !Number.isFinite(av) || (hv + av) === 0) return null;
        return {
          homeValue: hv,
          awayValue: av,
          ratio: hv / Math.max(1, av),
          homeShare: hv / (hv + av),
          gap: hv - av
        };
      }
    };
  } catch (error) {
    return { ok: false, error: error.message, getClubValue: () => null, compareTeams: () => null };
  }
}

export function parseClubsCSV(csv) {
  const lines = String(csv || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCSVRow(lines[0]);
  const idx = {
    name: header.findIndex((h) => /^name$|^club_name$/i.test(h)),
    totalValue: header.findIndex((h) => /total_market_value|market_value_in_eur|squad_value/i.test(h)),
    domesticLeague: header.findIndex((h) => /domestic_competition|league/i.test(h))
  };
  if (idx.name < 0) return [];
  const clubs = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVRow(lines[i]);
    if (cells.length <= idx.name) continue;
    const name = cells[idx.name];
    if (!name) continue;
    clubs.push({
      name,
      totalMarketValueEur: idx.totalValue >= 0 ? Number(cells[idx.totalValue]) || null : null,
      domesticLeague: idx.domesticLeague >= 0 ? cells[idx.domesticLeague] : null
    });
  }
  return clubs;
}

function parseCSVRow(row) {
  // 简单 CSV 解析(支持双引号)
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (inQuotes) {
      if (c === '"' && row[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function fetchCached(filename, fetchImpl, ttlMinutes) {
  const cacheDir = getDataSubdir("transfermarkt");
  const cachePath = join(cacheDir, filename);
  if (existsSync(cachePath)) {
    const age = (Date.now() - statSync(cachePath).mtimeMs) / 60000;
    if (age < ttlMinutes) return readFileSync(cachePath, "utf8");
  }
  const url = `${BASE_URL}/${filename}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    mkdirSync(cacheDir, { recursive: true });
    try { writeFileSync(cachePath, text, "utf8"); } catch { /* */ }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
