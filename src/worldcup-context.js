// 世界杯锦标赛上下文:把超算(run-worldcup-supercomputer)输出的每队 出线/夺冠 概率
// 附到世界杯单场旁,让日报/手机页在世界杯期间显示赛会级背景(而非只有单场胜平负)。
// 非世界杯赛事 / 无超算数据 → 返回 ""(自动休眠,不影响日常竞彩;开赛后超算 json 一在即生效)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

let _cache;
export function loadWorldCupSupercomputer() {
  if (_cache !== undefined) return _cache;
  try {
    const p = join(getExportDir(), "worldcup-supercomputer.json");
    _cache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch { _cache = null; }
  return _cache;
}
export function _resetWorldCupCache() { _cache = undefined; }

/** 仅世界杯决赛圈(世预赛不算)。 */
export function isWorldCupCompetition(competition) {
  return Boolean(competition && /世界杯|world\s*cup/i.test(competition) && !/预选|资格|外围|qualif/i.test(competition));
}

function findTeam(name, rows) {
  if (!name || !Array.isArray(rows)) return null;
  const n = String(name).trim();
  const low = n.toLowerCase();
  return rows.find((r) => r.team === n || r.en === n
    || (r.en && String(r.en).toLowerCase() === low)
    || (r.team && n.includes(r.team))) || null;
}

const pc = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");

/** 返回某队赛会概率 {team,advance,champion,r16,qf,sf,final} 或 null。 */
export function worldCupTeamContext(name, rows = loadWorldCupSupercomputer()?.rows) {
  const t = findTeam(name, rows);
  if (!t) return null;
  return { team: t.team, advance: t.advance, champion: t.champion, r16: t.r16, qf: t.qf, sf: t.sf, final: t.final };
}

/** 世界杯单场:返回赛会级上下文一行(出线%/夺冠%);非世界杯/无数据/两队都查不到→""。 */
export function worldCupContextLine(homeTeam, awayTeam, competition) {
  if (!isWorldCupCompetition(competition)) return "";
  const data = loadWorldCupSupercomputer();
  if (!data?.rows?.length) return "";
  const h = worldCupTeamContext(homeTeam, data.rows);
  const a = worldCupTeamContext(awayTeam, data.rows);
  if (!h && !a) return "";
  const fmt = (name, t) => (t ? `${name} 出线${pc(t.advance)}·夺冠${pc(t.champion)}` : `${name} —`);
  return `${fmt(homeTeam, h)} ｜ ${fmt(awayTeam, a)}`;
}
