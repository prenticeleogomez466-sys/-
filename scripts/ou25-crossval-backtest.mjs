// 大小球 2.5 球 互相验证回测 (Over/Under 2.5 cross-validation)
// ──────────────────────────────────────────────────────────────────────────
// 第二刀(2026-05-31): 1X2 已证四路都打不过收盘线; 转去大小球这个更低效的市场,
// 看 联赛环境 / 球队火力 是否真有 edge。全程真实数据(进球+开/收大小球赔率), walk-forward。
//
// 预测器(输出 P(大于2.5球), 仅用过去):
//   1. 联赛环境CBR  —— 该联赛历史真实大球率(经验, 只累计过去)
//   2. 球队火力泊松 —— 主客分项进球率(scored/conceded)→ λ_total → 泊松 P(>2.5)
//   3. 开盘大小球   —— 开盘 Avg>2.5/<2.5 去 vig P(over)(市场基准)
//   4. 火力+联赛融合 —— 球队泊松 与 联赛率 的简单平均(看融合能否>市场)
// 基准: 5. 收盘大小球线(AvgC, 天花板)  6. 开→收漂移
//
// 评分: N / 命中%(P>0.5判大) / Brier / LogLoss / ECE / 能否打败收盘大小球线
// 用法: node scripts/ou25-crossval-backtest.mjs

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["2021", "2122", "2223", "2324", "2425", "2526"];
const LEAGUES = ["E0", "E1", "D1", "D2", "SP1", "I1", "F1", "N1", "B1", "P1"];
const MIN_TEAM_GAMES = 8;
const MIN_BUCKET = 30;

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function devig2(oOver, oUnder) {
  if (!oOver || !oUnder) return null;
  const a = 1 / oOver, b = 1 / oUnder, s = a + b;
  return s > 0 ? a / s : null;   // P(over)
}
function parseDate(s) {
  const m = s.split("/"); if (m.length !== 3) return 0;
  let [d, mo, y] = m.map((x) => parseInt(x, 10)); if (y < 100) y += 2000;
  return Date.UTC(y, mo - 1, d);
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(","); const idx = (n) => head.indexOf(n);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(","); if (c.length < 10) continue;
    const hg = num(c[idx("FTHG")]), ag = num(c[idx("FTAG")]);
    if (hg == null || ag == null) continue;
    const openOver = devig2(num(c[idx("Avg>2.5")]), num(c[idx("Avg<2.5")]))
      ?? devig2(num(c[idx("B365>2.5")]), num(c[idx("B365<2.5")]));
    const closeOver = devig2(num(c[idx("AvgC>2.5")]), num(c[idx("AvgC<2.5")]))
      ?? devig2(num(c[idx("B365C>2.5")]), num(c[idx("B365C<2.5")]));
    out.push({
      date: c[idx("Date")], home: c[idx("HomeTeam")], away: c[idx("AwayTeam")],
      hg, ag, total: hg + ag, over: hg + ag >= 3 ? 1 : 0, openOver, closeOver,
    });
  }
  return out;
}
async function loadAll() {
  const all = []; let ok = 0, fail = 0;
  for (const lg of LEAGUES) for (const sc of SEASON_CODES) {
    try {
      const r = await fetch(`${BASE}/${sc}/${lg}.csv`);
      if (!r.ok) { fail++; continue; }
      const rows = parseCsv(await r.text());
      rows.forEach((x) => { x.league = lg; });
      all.push(...rows); ok++;
    } catch { fail++; }
  }
  console.error(`[load] ok=${ok} fail=${fail} matches=${all.length}`);
  all.forEach((r) => { r.ts = parseDate(r.date); });
  all.sort((a, b) => a.ts - b.ts);
  return all;
}

function poissonOver25(lam) {
  // P(total >= 3) = 1 - P(0)-P(1)-P(2)
  const e = Math.exp(-lam);
  return 1 - e * (1 + lam + lam * lam / 2);
}

// ── 状态(在线/只用过去) ──
const team = new Map();   // t -> {hg,hc,hn, ag,ac,an}  主客分项
function tg(t) { let v = team.get(t); if (!v) { v = { hg: 0, hc: 0, hn: 0, ag: 0, ac: 0, an: 0 }; team.set(t, v); } return v; }
const leagueOU = new Map();  // league -> {o,u}

function newScorer() { return { n: 0, hit: 0, brier: 0, logloss: 0, bins: Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 })) }; }
function score(s, p, y) {
  if (p == null) return;
  p = Math.min(0.999, Math.max(0.001, p));
  s.n++; if ((p > 0.5 ? 1 : 0) === y) s.hit++;
  s.brier += (p - y) ** 2;
  s.logloss += -(y ? Math.log(p) : Math.log(1 - p));
  const conf = y ? p : 1 - p;   // 这里用预测正确类的概率做可靠性
  const pm = Math.max(p, 1 - p); const b = Math.min(9, Math.floor(pm * 10));
  s.bins[b].p += pm; s.bins[b].y += (p > 0.5 ? 1 : 0) === y ? 1 : 0; s.bins[b].n++;
}
function ece(s) { let e = 0; for (const b of s.bins) if (b.n) e += (b.n / s.n) * Math.abs(b.p / b.n - b.y / b.n); return e; }

(async () => {
  const data = await loadAll();
  const preds = ["联赛环境CBR", "球队火力泊松", "火力+联赛融合", "开盘大小球", "收盘大小球(基准)", "开→收漂移"];
  const S = Object.fromEntries(preds.map((p) => [p, newScorer()]));
  let scored = 0;
  const diag = [];   // 分歧分析: {pPois,pOpen,pClose,over}

  for (const m of data) {
    if (m.openOver == null) continue;
    const H = tg(m.home), A = tg(m.away);
    const ready = H.hn >= MIN_TEAM_GAMES && A.an >= MIN_TEAM_GAMES && H.an + H.hn >= MIN_TEAM_GAMES && A.hn + A.an >= MIN_TEAM_GAMES;
    const lo = leagueOU.get(m.league);
    const leagueReady = lo && lo.o + lo.u >= MIN_BUCKET;

    // 球队火力 λ: 主队进攻=主场进球率, 对手防守=客队客场失球率
    let pPois = null;
    if (ready) {
      const homeAtt = H.hg / Math.max(1, H.hn), awayDefC = A.ac / Math.max(1, A.an);
      const awayAtt = A.ag / Math.max(1, A.an), homeDefC = H.hc / Math.max(1, H.hn);
      const lamH = (homeAtt + awayDefC) / 2, lamA = (awayAtt + homeDefC) / 2;
      pPois = poissonOver25(lamH + lamA);
    }
    const pLeague = leagueReady ? (lo.o + 1) / (lo.o + lo.u + 2) : null;
    const pOpen = m.openOver;
    const pFuse = (pPois != null && pLeague != null) ? (pPois + pLeague) / 2 : null;
    const pClose = m.closeOver ?? null;
    const pDrift = (m.openOver != null && m.closeOver != null) ? (m.openOver + m.closeOver) / 2 : null;

    if (pPois != null && pLeague != null) {
      score(S["联赛环境CBR"], pLeague, m.over);
      score(S["球队火力泊松"], pPois, m.over);
      score(S["火力+联赛融合"], pFuse, m.over);
      score(S["开盘大小球"], pOpen, m.over);
      if (pClose != null) score(S["收盘大小球(基准)"], pClose, m.over);
      if (pDrift != null) score(S["开→收漂移"], pDrift, m.over);
      if (pClose != null) diag.push({ pPois, pOpen, pClose, over: m.over });
      scored++;
    }

    // 更新(walk-forward, 预测后)
    H.hg += m.hg; H.hc += m.ag; H.hn++;
    A.ag += m.ag; A.ac += m.hg; A.an++;
    if (!lo) leagueOU.set(m.league, { o: m.over, u: 1 - m.over });
    else { lo.o += m.over; lo.u += 1 - m.over; }
  }

  const closeLL = S["收盘大小球(基准)"].n ? S["收盘大小球(基准)"].logloss / S["收盘大小球(基准)"].n : null;
  console.log(`\n===== 大小球2.5 互相验证回测 · 同集合 N=${scored} 场 (6联赛×~5季) =====\n`);
  const rows = [["信号", "N", "命中%", "Brier", "LogLoss", "ECE", "vs收盘线"]];
  for (const p of preds) {
    const s = S[p]; if (!s.n) { rows.push([p, "0", "-", "-", "-", "-", "-"]); continue; }
    const ll = s.logloss / s.n;
    const cmp = closeLL == null ? "-" : (p.includes("收盘") ? "(基准)" : (ll < closeLL ? `✅胜${((closeLL - ll) / closeLL * 100).toFixed(1)}%` : `✗差${((ll - closeLL) / closeLL * 100).toFixed(1)}%`));
    rows.push([p, String(s.n), (s.hit / s.n * 100).toFixed(1), (s.brier / s.n).toFixed(4), ll.toFixed(4), ece(s).toFixed(4), cmp]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(w[c])).join("  "));
  console.log(`\n基础率: 大球占比 ${(data.filter(d=>d.openOver!=null).reduce((s,d)=>s+d.over,0)/data.filter(d=>d.openOver!=null).length*100).toFixed(1)}%`);

  // ── 分歧分析: 模型(球队火力)与开盘市场分歧最大的子集, 谁更对? ──
  console.log(`\n----- 分歧分析: 球队火力泊松 vs 开盘市场 -----`);
  diag.sort((a, b) => Math.abs(b.pPois - b.pOpen) - Math.abs(a.pPois - a.pOpen));
  for (const [label, frac] of [["分歧最大20%", 0.2], ["分歧最大10%", 0.1], ["分歧最大5%", 0.05]]) {
    const k = Math.floor(diag.length * frac); const sub = diag.slice(0, k);
    let mHit = 0, oHit = 0, mLL = 0, oLL = 0;
    for (const d of sub) {
      const cl = (p) => Math.min(0.999, Math.max(0.001, p));
      mHit += (d.pPois > 0.5 ? 1 : 0) === d.over ? 1 : 0;
      oHit += (d.pOpen > 0.5 ? 1 : 0) === d.over ? 1 : 0;
      mLL += -(d.over ? Math.log(cl(d.pPois)) : Math.log(1 - cl(d.pPois)));
      oLL += -(d.over ? Math.log(cl(d.pOpen)) : Math.log(1 - cl(d.pOpen)));
    }
    console.log(`  ${label} (n=${k}): 模型命中${(mHit / k * 100).toFixed(1)}% LL${(mLL / k).toFixed(4)} | 市场命中${(oHit / k * 100).toFixed(1)}% LL${(oLL / k).toFixed(4)} → ${mLL < oLL ? "★模型在此子集更准" : "市场仍更准"}`);
  }

  const fs = await import("node:fs");
  const out = { date: new Date().toISOString().slice(0, 10), market: "OU2.5", scoredN: scored, closeLL, signals: {} };
  for (const p of preds) { const s = S[p]; out.signals[p] = s.n ? { n: s.n, hit: s.hit / s.n, brier: s.brier / s.n, logloss: s.logloss / s.n, ece: ece(s) } : null; }
  fs.writeFileSync("D:/football-model-exports/ou25-crossval-backtest.json", JSON.stringify(out, null, 2));
  console.log("\nSAVED: D:/football-model-exports/ou25-crossval-backtest.json");
})();
