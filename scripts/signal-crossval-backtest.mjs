// 互相验证回测 harness (signal cross-validation backtest)
// ──────────────────────────────────────────────────────────────────────────
// 用户方向(2026-05-31): 把 联赛/球队/赔率/盘口水位 四路信号各自当独立预测器,
// 走 walk-forward(只用过去) 回测, 看哪路真有 edge(命中/Brier/LogLoss/能否打败收盘线),
// 为"互相验证置信层"打基础。数据=football-data.co.uk CSV(开盘Avg+收盘AvgC+亚盘水位+赛果)。
//
// 四路预测器(全部仅用赛前可得信息, 输出 {h,d,a} 概率):
//   1. 球队Elo      —— 纯赛果序列, 在线更新, 主场优势加成
//   2. 联赛类比CBR  —— (联赛, 开盘热门强度档, 热门主客) 桶的历史真实 1X2 频率(经验库式, 只累计过去)
//   3. 开盘赔率     —— 开盘 Avg 去 vig 隐含概率(市场基准)
//   4. 盘口水位     —— 开盘亚盘 P(主队赢盘) 分档 → 该档历史真实 1X2 频率(只累计过去)
// 两个基准(非赛前可用, 仅作天花板/CLV 参照):
//   5. 收盘线       —— 收盘 AvgC 去 vig(博彩界公认最强先验, 几乎打不败)
//   6. 开→收漂移    —— 朝收盘方向挪一半, 量化"赔率变化"这块信息饼有多大
//
// 评分: N / 命中率(argmax) / 多分类Brier / LogLoss / ECE校准 / 是否 LogLoss<收盘线(真 edge)
//
// 用法: node scripts/signal-crossval-backtest.mjs

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASONS = ["2021", "2122", "2223", "2324", "2425", "2526"];
// football-data season code: 2021=2020/21 ... 2526=2025/26
const SEASON_CODES = ["2021", "2122", "2223", "2324", "2425", "2526"];
const LEAGUES = ["E0", "E1", "D1", "D2", "SP1", "I1", "F1", "N1", "B1", "P1"];

const HOME_ADV = 60;     // Elo 主场优势(分)
const ELO_K = 20;
const MIN_TEAM_GAMES = 5;
const MIN_BUCKET = 25;   // CBR/水位 桶最少历史样本才采信

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }

function devig3(oh, od, oa) {
  if (!oh || !od || !oa) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia;
  if (!(s > 0)) return null;
  return { h: ih / s, d: id / s, a: ia / s };
}
function devig2(oh, oa) {
  if (!oh || !oa) return null;
  const ih = 1 / oh, ia = 1 / oa, s = ih + ia;
  return s > 0 ? ih / s : null;   // P(home side)
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(",");
  const idx = (name) => head.indexOf(name);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < 10) continue;
    const ftr = c[idx("FTR")];
    if (!ftr || !"HDA".includes(ftr)) continue;
    const open = devig3(num(c[idx("AvgH")]), num(c[idx("AvgD")]), num(c[idx("AvgA")]))
      ?? devig3(num(c[idx("B365H")]), num(c[idx("B365D")]), num(c[idx("B365A")]));
    const close = devig3(num(c[idx("AvgCH")]), num(c[idx("AvgCD")]), num(c[idx("AvgCA")]))
      ?? devig3(num(c[idx("B365CH")]), num(c[idx("B365CD")]), num(c[idx("B365CA")]));
    // 亚盘水位: 开盘 Asian home/away 赔率 → P(主赢盘)
    const ahHomeProb = devig2(num(c[idx("AvgAHH")]), num(c[idx("AvgAHA")]))
      ?? devig2(num(c[idx("B365AHH")]), num(c[idx("B365AHA")]));
    out.push({
      date: c[idx("Date")], home: c[idx("HomeTeam")], away: c[idx("AwayTeam")],
      ftr, open, close, ahHomeProb,
    });
  }
  return out;
}

function parseDate(s) {
  // dd/mm/yy 或 dd/mm/yyyy
  const m = s.split("/");
  if (m.length !== 3) return 0;
  let [d, mo, y] = m.map((x) => parseInt(x, 10));
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, mo - 1, d)).getTime();
}

async function loadAll() {
  const all = [];
  let ok = 0, fail = 0;
  for (const league of LEAGUES) {
    for (const season of SEASON_CODES) {
      const url = `${BASE}/${season}/${league}.csv`;
      try {
        const r = await fetch(url);
        if (!r.ok) { fail++; continue; }
        const rows = parseCsv(await r.text());
        for (const row of rows) { row.league = league; row.season = season; }
        all.push(...rows);
        ok++;
      } catch { fail++; }
    }
  }
  console.error(`[load] CSV ok=${ok} fail=${fail}, matches=${all.length}`);
  all.forEach((r) => { r.ts = parseDate(r.date); });
  all.sort((a, b) => a.ts - b.ts);
  return all;
}

// ── 预测器状态 ──
const elo = new Map();                 // team -> rating
const cbrBucket = new Map();           // key -> {h,d,a}
const waterBucket = new Map();         // key -> {h,d,a}

function getElo(t) { return elo.get(t) ?? 1500; }
function eloProb(home, away) {
  const dr = getElo(home) + HOME_ADV - getElo(away);
  const pHomeRaw = 1 / (1 + Math.pow(10, -dr / 400));   // 主 vs 客(二元)
  // 二元→三元: 用经验平局率随强弱差收缩(简化, 训练无关常数)
  const drawBase = 0.27;
  const d = drawBase * (1 - Math.min(0.6, Math.abs(pHomeRaw - 0.5) * 1.2));
  const h = (1 - d) * pHomeRaw, a = (1 - d) * (1 - pHomeRaw);
  return { h, d, a };
}
function updateElo(home, away, ftr) {
  const eh = getElo(home), ea = getElo(away);
  const exp = 1 / (1 + Math.pow(10, -((eh + HOME_ADV - ea) / 400)));
  const sh = ftr === "H" ? 1 : ftr === "D" ? 0.5 : 0;
  elo.set(home, eh + ELO_K * (sh - exp));
  elo.set(away, ea + ELO_K * ((1 - sh) - (1 - exp)));
}

function favTier(open) {
  // 以开盘最大隐含概率(热门强度)定档
  const p = Math.max(open.h, open.a);
  if (p < 0.40) return "T0";
  if (p < 0.50) return "T1";
  if (p < 0.60) return "T2";
  if (p < 0.72) return "T3";
  return "T4";
}
function favIsHome(open) { return open.h >= open.a ? 1 : 0; }

function bucketProb(map, key) {
  const b = map.get(key);
  if (!b) return null;
  const n = b.h + b.d + b.a;
  if (n < MIN_BUCKET) return { prob: null, n };
  // 拉普拉斯平滑
  return { prob: { h: (b.h + 1) / (n + 3), d: (b.d + 1) / (n + 3), a: (b.a + 1) / (n + 3) }, n };
}
function bump(map, key, ftr) {
  let b = map.get(key);
  if (!b) { b = { h: 0, d: 0, a: 0 }; map.set(key, b); }
  b[ftr === "H" ? "h" : ftr === "D" ? "d" : "a"]++;
}

function driftPred(open, close) {
  if (!open || !close) return null;
  // 朝收盘方向挪一半(模拟"跟着锐钱走但拿不到完整收盘")
  return { h: (open.h + close.h) / 2, d: (open.d + close.d) / 2, a: (open.a + close.a) / 2 };
}

// ── 评分器 ──
function newScorer() { return { n: 0, hit: 0, brier: 0, logloss: 0, bins: Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 })) }; }
function score(s, prob, ftr) {
  if (!prob) return;
  s.n++;
  const pick = prob.h >= prob.d && prob.h >= prob.a ? "H" : prob.d >= prob.a ? "D" : "A";
  if (pick === ftr) s.hit++;
  const y = { h: ftr === "H" ? 1 : 0, d: ftr === "D" ? 1 : 0, a: ftr === "A" ? 1 : 0 };
  s.brier += (prob.h - y.h) ** 2 + (prob.d - y.d) ** 2 + (prob.a - y.a) ** 2;
  const pTrue = Math.max(1e-9, prob[ftr === "H" ? "h" : ftr === "D" ? "d" : "a"]);
  s.logloss += -Math.log(pTrue);
  // ECE: 用 argmax 概率分箱
  const pm = Math.max(prob.h, prob.d, prob.a);
  const b = Math.min(9, Math.floor(pm * 10));
  s.bins[b].p += pm; s.bins[b].y += pick === ftr ? 1 : 0; s.bins[b].n++;
}
function ece(s) {
  let e = 0;
  for (const b of s.bins) if (b.n) e += (b.n / s.n) * Math.abs(b.p / b.n - b.y / b.n);
  return e;
}

(async () => {
  const data = await loadAll();
  const preds = ["球队Elo", "联赛类比CBR", "开盘赔率", "盘口水位", "收盘线(基准)", "开→收漂移"];
  const S = Object.fromEntries(preds.map((p) => [p, newScorer()]));
  let scored = 0;
  const teamGames = new Map();

  for (const m of data) {
    if (!m.open) continue;
    const tier = favTier(m.open);
    const fih = favIsHome(m.open);
    const cbrKey = `${m.league}|${tier}|${fih}`;
    const waterKey = m.ahHomeProb != null ? `W${Math.min(9, Math.floor(m.ahHomeProb * 10))}` : null;

    const tgH = teamGames.get(m.home) ?? 0, tgA = teamGames.get(m.away) ?? 0;
    const eloReady = tgH >= MIN_TEAM_GAMES && tgA >= MIN_TEAM_GAMES;

    // 预测(只用过去)
    const pElo = eloReady ? eloProb(m.home, m.away) : null;
    const cbr = bucketProb(cbrBucket, cbrKey); const pCbr = cbr?.prob ?? null;
    const pOpen = m.open;
    const water = waterKey ? bucketProb(waterBucket, waterKey) : null; const pWater = water?.prob ?? null;
    const pClose = m.close ?? null;
    const pDrift = driftPred(m.open, m.close);

    // 只在四路赛前预测器都 fire 时计入headline(同集合可比), 收盘/漂移随同集合评分
    if (pElo && pCbr && pWater) {
      score(S["球队Elo"], pElo, m.ftr);
      score(S["联赛类比CBR"], pCbr, m.ftr);
      score(S["开盘赔率"], pOpen, m.ftr);
      score(S["盘口水位"], pWater, m.ftr);
      if (pClose) score(S["收盘线(基准)"], pClose, m.ftr);
      if (pDrift) score(S["开→收漂移"], pDrift, m.ftr);
      scored++;
    }

    // 更新状态(放在预测之后 = 严格 walk-forward, 不泄漏当前场)
    updateElo(m.home, m.away, m.ftr);
    teamGames.set(m.home, tgH + 1); teamGames.set(m.away, tgA + 1);
    bump(cbrBucket, cbrKey, m.ftr);
    if (waterKey) bump(waterBucket, waterKey, m.ftr);
  }

  const closeLL = S["收盘线(基准)"].n ? S["收盘线(基准)"].logloss / S["收盘线(基准)"].n : null;
  console.log(`\n===== 互相验证回测 · 同评分集合 N=${scored} 场 (6联赛×~5季, 仅四路赛前预测器都fire) =====\n`);
  const rows = [["信号", "N", "命中%", "Brier", "LogLoss", "ECE校准", "vs收盘线"]];
  for (const p of preds) {
    const s = S[p]; if (!s.n) { rows.push([p, "0", "-", "-", "-", "-", "-"]); continue; }
    const ll = s.logloss / s.n;
    const cmp = closeLL == null ? "-" : (p.includes("收盘") ? "(基准)" : (ll < closeLL ? `✅ 胜${((closeLL - ll) / closeLL * 100).toFixed(1)}%` : `✗ 差${((ll - closeLL) / closeLL * 100).toFixed(1)}%`));
    rows.push([p, String(s.n), (s.hit / s.n * 100).toFixed(1), (s.brier / s.n).toFixed(4), ll.toFixed(4), ece(s).toFixed(4), cmp]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(w[c])).join("  "));

  console.log(`\n判读: LogLoss 越低越准; "vs收盘线"=能否打败博彩收盘价(真 edge 的金标准)。`);
  console.log(`命中率高≠有edge(均势市场argmax偏门), 以 LogLoss/Brier/校准 为准。`);

  // 写 JSON 供下一步置信层用
  const fs = await import("node:fs");
  const out = { date: new Date().toISOString().slice(0, 10), scoredN: scored, closeLL, signals: {} };
  for (const p of preds) { const s = S[p]; out.signals[p] = s.n ? { n: s.n, hit: s.hit / s.n, brier: s.brier / s.n, logloss: s.logloss / s.n, ece: ece(s) } : null; }
  fs.writeFileSync("D:/football-model-exports/signal-crossval-backtest.json", JSON.stringify(out, null, 2));
  console.log("\nSAVED: D:/football-model-exports/signal-crossval-backtest.json");
})();
