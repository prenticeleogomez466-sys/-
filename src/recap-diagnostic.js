// 诊断型复盘核心(2026-06-14 用户裁决:"复盘要直观看到 预测vs实际、为什么没中/缺什么信息、
//   中的是主选还是次选,并把盘口推荐 vs 模型推荐 同场对比跑胜率")。复盘核心目的=进化模型,不是记分牌。
//
// 纯读 ledger + market store,绝不改线上数据/模型。每个数字可追溯到 ledger 原始行(✅实测);
// 盘口热门=该场 europeanOdds 直胜最低赔(✅实测),悬殊盘只卖让球→直胜赔缺,如实标⚠️不冒充(no-fabrication)。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WLD = { 主胜: "home", 平局: "draw", 客胜: "away" };
const OUT_ZH = { home: "主胜", draw: "平局", away: "客胜" };

function marketFavoriteOf(row, dataDir, cache) {
  const date = row.date;
  if (!cache.has(date)) {
    const p = join(dataDir, "market", `${date}.json`);
    cache.set(date, existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).snapshots ?? []) : []);
  }
  const snaps = cache.get(date);
  const [h, a] = String(row.match || "").split(/\s*(?:对|vs|VS)\s*/);
  const snap = snaps.find((s) => (h && a && (s.homeTeam || "").includes(h.trim()) && (s.awayTeam || "").includes(a.trim()))
    || String(s.sequence) === String(row.sequence));
  if (!snap) return { fav: null, note: "⚠️无盘口快照" };
  const eo = snap.europeanOdds?.current ?? snap.europeanOdds?.initial ?? snap.europeanOdds;
  if (eo && Number.isFinite(eo.home) && Number.isFinite(eo.draw) && Number.isFinite(eo.away)) {
    const pick = ["home", "draw", "away"].reduce((b, k) => (eo[k] < eo[b] ? k : b), "home");
    return { fav: pick, src: "europeanOdds", odds: eo };
  }
  return { fav: null, note: "⚠️悬殊盘直胜赔缺(只卖让球)" };
}

// 未中归因(只从 ledger 已有字段诚实推导,不编造)
export function attributeMiss(row, modelOutcome, marketFav, actualOutcome) {
  const tags = [];
  const p = Math.max(row.probabilityHome || 0, row.probabilityDraw || 0, row.probabilityAway || 0);
  if (p >= 0.5 && p < 0.6) tags.push("硬币档(势均·模型50-60%档实测仅~24%命中)");
  if (actualOutcome === "draw") tags.push("平局(模型主推从不选平=结构盲区)");
  if (marketFav && modelOutcome && modelOutcome !== marketFav) tags.push("逆市场分歧(实证分歧越大市场越对)");
  if (/无历史联赛画像|冷门联赛|缺.*情报|参考赔率为主/.test(row.reason || "")) tags.push("信息缺口(无联赛画像/缺球队情报→纯跟随赔率)");
  if (/世界杯|国际|友谊|预选|国家/.test(row.competition || "")) tags.push("国家队域(无xG/薄样本/无专属校准反馈)");
  return tags.length ? tags : ["其它(校准误差/泊松方差)"];
}

/**
 * 诊断型复盘:模型主推 vs 盘口热门头对头胜率 + 命中构成(主/次选) + 未中归因 + 逐场诊断。
 * @param {Array} ledger recommendation-ledger 全量行
 * @param {Object} opts { dataDir, onlyDate }
 * @returns {{ stats, perMatch, summaryRows, detailRows }}
 */
export function buildRecapDiagnostic(ledger, opts = {}) {
  const { dataDir, onlyDate = null } = opts;
  const marketCache = new Map();
  let settledRaw = ledger.filter((r) => (r.actualStatus === "settled" || r.actual) && r.actualScore && r.primary
    && (!onlyDate || r.date === onlyDate));
  // 去重:同一场常被多个销售业务日各推一次,按 队名+真实比分 去重,保留最接近开赛(date 最大)那次。
  const rawCount = settledRaw.length;
  const dedup = new Map();
  for (const r of [...settledRaw].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    dedup.set(`${r.match}|${r.actualScore}`, r);
  }
  const settled = [...dedup.values()];
  const dupRemoved = rawCount - settled.length;

  let mHit = 0, mkHit = 0, bothCount = 0;
  let primHit = 0, secHit = 0, dcHit = 0;
  const missAttr = {};
  const perMatch = [];

  for (const r of settled) {
    const modelOutcome = WLD[r.primary] ?? null;
    const actualOutcome = WLD[r.actual] ?? null;
    const primaryHit = r.actual === r.primary;
    const dc = r.doubleChanceShort || "";
    const dcSet = new Set([...dc].map((c) => ({ "1": "主胜", X: "平局", "2": "客胜" }[c])).filter(Boolean));
    const secondaryHit = !primaryHit && (r.actual === r.secondary || dcSet.has(r.actual));
    if (primaryHit) primHit++;
    else if (secondaryHit) { secHit++; if (dcSet.has(r.actual)) dcHit++; }

    const mk = marketFavoriteOf(r, dataDir, marketCache);
    const marketHit = mk.fav ? (mk.fav === actualOutcome) : null;
    if (mk.fav && modelOutcome) { bothCount++; if (primaryHit) mHit++; if (marketHit) mkHit++; }

    const miss = primaryHit ? null : attributeMiss(r, modelOutcome, mk.fav, actualOutcome);
    if (miss) for (const t of miss) missAttr[t] = (missAttr[t] || 0) + 1;

    perMatch.push({
      date: r.date, match: r.match, comp: r.competition,
      model: r.primary, sec: r.secondary || "", dc, actual: r.actual, score: r.actualScore,
      hitLevel: primaryHit ? "✅主选中" : secondaryHit ? "🟡次选/双选救回" : "❌未中",
      marketFav: mk.fav ? OUT_ZH[mk.fav] : (mk.note || "—"),
      marketHit: marketHit === null ? "—" : (marketHit ? "盘口✅" : "盘口❌"),
      scoreHit: r.scorePrimary === r.actualScore ? "✅" : "❌",
      hfHit: r.halfFullPrimary && r.actualHalfFull ? (r.halfFullPrimary === r.actualHalfFull ? "✅" : "❌") : "—",
      miss: miss ? miss.join(" / ") : "",
    });
  }

  const total = settled.length;
  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + "%" : "—");
  const stats = {
    total, rawCount, dupRemoved, bothCount,
    modelHit: mHit, marketHit: mkHit, modelRate: pct(mHit, bothCount), marketRate: pct(mkHit, bothCount),
    edgePp: bothCount ? +(((mHit - mkHit) / bothCount) * 100).toFixed(1) : 0,
    primaryHit: primHit, secondaryRescue: secHit, doubleChanceRescue: dcHit,
    comboRate: pct(primHit + secHit, total), missAttr,
  };

  const verdict = stats.edgePp < 0 ? "模型跑输盘口(本质跟随且更差)" : stats.edgePp > 0 ? "模型略优于盘口" : "持平=纯跟随";
  const summaryRows = [
    ["诊断型复盘", onlyDate || "全 ledger"],
    [],
    ["① 模型主推 vs 盘口热门(头对头同口径)", "", ""],
    ["项目", "命中", "胜率"],
    ["模型主推", `${mHit}/${bothCount}`, stats.modelRate],
    ["盘口热门(庄家直胜最低赔)", `${mkHit}/${bothCount}`, stats.marketRate],
    ["差值(模型-盘口)", `${stats.edgePp}pp`, verdict],
    [],
    ["② 命中构成(全 " + total + " 场)", "", ""],
    ["主选直接命中", `${primHit}/${total}`, pct(primHit, total)],
    ["次选/双选救回", `${secHit}(双选 ${dcHit})`, ""],
    ["合计(主+次)", `${primHit + secHit}/${total}`, stats.comboRate],
    [],
    ["③ 未中归因(" + (total - primHit) + " 场未主选命中)", "场数", ""],
    ...Object.entries(missAttr).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, ""]),
    [],
    ["样本说明", `去重后 ${total} 场真实比赛(原始 ${rawCount} 行,去重 ${dupRemoved} 重复推荐)`, ""],
    ["口径", "盘口热门=europeanOdds直胜最低赔(✅实测);悬殊盘直胜赔缺如实标⚠️不冒充", ""],
  ];
  const detailHdr = ["日期", "对阵", "赛事", "模型主选", "模型次选", "双选", "盘口热门", "盘口命中", "实际", "比分", "命中级别", "比分中", "半全场中", "未中归因"];
  const detailRows = perMatch.map((r) => [r.date, r.match, r.comp, r.model, r.sec, r.dc, r.marketFav, r.marketHit, r.actual, r.score, r.hitLevel, r.scoreHit, r.hfHit, r.miss]);

  return { stats, perMatch, summaryRows, detailRows: [detailHdr, ...detailRows] };
}
