// 日职球队全维度真实画像挖掘(2026-06-06)——用2234场历史真实赛果挖每队特点。
// 维度(全部真实可追溯,无兜底):综合实力(场均积分)/进攻(场均进球)/防守(场均失球)/主场战绩/客场战绩/
// 近5状态/对特定对手H2H。教练组=免费源无数据→标缺不编。结合今日DC强度+deep-context+500赔率。
import { readFileSync, readdirSync } from "node:fs";
import { canonicalTeamName } from "../src/team-aliases.js";

const dir = "D:/football-model-data/fixtures";
const JL = /日本职业|日职|J1|J League|Kashima|Kawasaki|Vissel|Urawa|Yokohama|Sanfrecce|Nagoya|Cerezo|Gamba|Sagan|Avispa|Albirex|Consadole|Shimizu|Machida|Fagiano|Kyoto|Kashiwa|FC Tokyo|Tokyo Verdy/i;
const all = [];
for (const f of readdirSync(dir).filter((x) => /^20(2[0-6])-/.test(x) && x.endsWith(".json"))) {
  try { for (const m of (() => { const a = JSON.parse(readFileSync(dir + "/" + f, "utf8")); return Array.isArray(a) ? a : a.fixtures || []; })()) {
    const hg = m.result?.home ?? m.result?.homeGoals, ag = m.result?.away ?? m.result?.awayGoals;
    if (JL.test((m.competition || "") + (m.homeTeam || "") + (m.awayTeam || "")) && Number.isFinite(Number(hg)) && Number.isFinite(Number(ag)) && m.date)
      all.push({ home: canonicalTeamName(m.homeTeam), away: canonicalTeamName(m.awayTeam), hg: +hg, ag: +ag, date: m.date, rawHome: m.homeTeam, rawAway: m.awayTeam });
  } } catch {}
}
all.sort((a, b) => a.date.localeCompare(b.date));

// 只统计近2季(2025+2026)更反映当前实力;再老的稀释当前特性
const recent = all.filter((m) => m.date >= "2025-01-01");
const P = new Map();
const g = (t) => { if (!P.has(t)) P.set(t, { gp: 0, pts: 0, gf: 0, ga: 0, hG: 0, hPts: 0, hGf: 0, hGa: 0, aG: 0, aPts: 0, aGf: 0, aGa: 0, last: [] }); return P.get(t); };
for (const m of recent) {
  const h = g(m.home), a = g(m.away);
  const hp = m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0, ap = m.ag > m.hg ? 3 : m.hg === m.ag ? 1 : 0;
  h.gp++; h.pts += hp; h.gf += m.hg; h.ga += m.ag; h.hG++; h.hPts += hp; h.hGf += m.hg; h.hGa += m.ag; h.last.push(hp === 3 ? "胜" : hp === 1 ? "平" : "负");
  a.gp++; a.pts += ap; a.gf += m.ag; a.ga += m.hg; a.aG++; a.aPts += ap; a.aGf += m.ag; a.aGa += m.hg; a.last.push(ap === 3 ? "胜" : ap === 1 ? "平" : "负");
}
const fmt = (x, d = 2) => Number(x).toFixed(d);
function profile(t) {
  const p = P.get(t); if (!p || p.gp < 5) return null;
  return {
    team: t, gp: p.gp, ppg: p.pts / p.gp, atk: p.gf / p.gp, def: p.ga / p.gp,
    homePpg: p.hG ? p.hPts / p.hG : null, homeGf: p.hG ? p.hGf / p.hG : null, homeGa: p.hG ? p.hGa / p.hG : null,
    awayPpg: p.aG ? p.aPts / p.aG : null, awayGf: p.aG ? p.aGf / p.aG : null, awayGa: p.aG ? p.aGa / p.aG : null,
    last5: p.last.slice(-5).join(""),
  };
}
// 今日6场日职(主队在前)
const today = [["鹿岛鹿角", "神户胜利船"], ["町田泽维亚", "名古屋鲸八"], ["浦和红钻", "冈山绿雉"], ["横滨水手", "清水鼓动"], ["柏太阳神", "京都不死鸟"], ["川崎前锋", "广岛三箭"]];
console.log("=== 今日6场日职·球队真实画像(近2季", recent.length, "场挖掘) ===\n");
for (const [hn, an] of today) {
  const h = profile(canonicalTeamName(hn)), a = profile(canonicalTeamName(an));
  console.log(`【${hn}(主) vs ${an}(客)】`);
  if (h) console.log(`  ${hn}: 综合${fmt(h.ppg)}分/场 攻${fmt(h.atk)} 防${fmt(h.def)} | 主场${fmt(h.homePpg)}分(进${fmt(h.homeGf)}失${fmt(h.homeGa)}) | 近5 ${h.last5}`);
  else console.log(`  ${hn}: 样本不足(标缺)`);
  if (a) console.log(`  ${an}: 综合${fmt(a.ppg)}分/场 攻${fmt(a.atk)} 防${fmt(a.def)} | 客场${fmt(a.awayPpg)}分(进${fmt(a.awayGf)}失${fmt(a.awayGa)}) | 近5 ${a.last5}`);
  else console.log(`  ${an}: 样本不足(标缺)`);
  // H2H(全历史)
  const h2h = all.filter((m) => (m.home === canonicalTeamName(hn) && m.away === canonicalTeamName(an)) || (m.home === canonicalTeamName(an) && m.away === canonicalTeamName(hn))).slice(-4);
  if (h2h.length) console.log(`  H2H: ${h2h.map((m) => `${m.date.slice(2, 7)} ${m.rawHome.slice(0, 2)}${m.hg}-${m.ag}${m.rawAway.slice(0, 2)}`).join(" / ")}`);
  console.log("");
}
console.log("诚实:教练组=免费源无结构化数据→标缺不编;欧亚让球盘赔率变化=今日500实时另抓(历史日职无赔率)。");
