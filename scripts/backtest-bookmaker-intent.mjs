/**
 * backtest-bookmaker-intent.mjs —— 验证"庄家意图(开盘 vs 收盘偏离)"的实战价值(真实历史·零编造)。
 * ──────────────────────────────────────────────────────────────────────────
 * 假设(我新做的 bookmaker-intent 核心思路):开盘≈公众/竞彩类定价,收盘≈sharp 共识(最准)。
 *   当开盘把热门定得比收盘高(收盘看淡热门)=公众追捧/庄家 shade 热门 → 该热门被高估,实际命中应更低;
 *   当收盘比开盘更看好热门(sharp 加注)=该热门更可靠,实际命中应更高。
 * 测法:按 (收盘热门隐含 − 开盘热门隐含) 分三组,看各组热门**实际命中率** vs **开盘隐含**(高估=隐含>实际)。
 *   同时给"跟开盘热门下注、按公平赔率"的 ROI(看偏离方向能否提示价值)。
 * 数据=football-data.co.uk(开盘 Avg + 收盘 AvgC + 真实赛果),无未来泄漏(开盘/收盘均赛前)。
 */
const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["2021", "2122", "2223", "2324", "2425", "2526"];
const LEAGUES = ["E0", "E1", "D1", "D2", "SP1", "I1", "F1", "N1", "B1", "P1"];

const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
function devig3(oh, od, oa) {
  if (!oh || !od || !oa) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia;
  return s > 0 ? { h: ih / s, d: id / s, a: ia / s, oh, od, oa } : null;
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(",");
  const idx = (n) => head.indexOf(n);
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
    if (!open || !close) continue;
    out.push({ ftr, open, close });
  }
  return out;
}
async function loadAll() {
  const all = []; let ok = 0, fail = 0;
  for (const league of LEAGUES) for (const season of SEASON_CODES) {
    try {
      const r = await fetch(`${BASE}/${season}/${league}.csv`);
      if (!r.ok) { fail++; continue; }
      all.push(...parseCsv(await r.text())); ok++;
    } catch { fail++; }
  }
  console.error(`[load] CSV ok=${ok} fail=${fail}, matches=${all.length}`);
  return all;
}

function run(rows) {
  const groups = {
    "收盘看淡热门(开盘高估·公众追捧)": { n: 0, favHit: 0, openSum: 0, closeSum: 0, roi: 0 },
    "平稳(|偏离|<2pp)": { n: 0, favHit: 0, openSum: 0, closeSum: 0, roi: 0 },
    "收盘加注热门(sharp更看好)": { n: 0, favHit: 0, openSum: 0, closeSum: 0, roi: 0 },
  };
  let dropped = 0;
  for (const m of rows) {
    const favKey = m.open.h >= m.open.a ? "h" : "a";          // 开盘热门(主/客)
    const favOpen = m.open[favKey], favClose = m.close[favKey];
    const favOdds = favKey === "h" ? m.open.oh : m.open.oa;    // 开盘真实赔率(带vig)
    if (!(favOdds > 1)) { dropped++; continue; }
    const drift = favClose - favOpen;                          // 收盘相对开盘对热门的变化
    const g = drift <= -0.02 ? groups["收盘看淡热门(开盘高估·公众追捧)"]
      : drift >= 0.02 ? groups["收盘加注热门(sharp更看好)"]
      : groups["平稳(|偏离|<2pp)"];
    const won = (favKey === "h" && m.ftr === "H") || (favKey === "a" && m.ftr === "A");
    g.n++; g.openSum += favOpen; g.closeSum += favClose;
    if (won) g.favHit++;
    g.roi += won ? (favOdds - 1) : -1;                         // 跟开盘热门、按真实开盘赔率下注的盈亏(单位注)
  }
  return { groups, dropped };
}

const rows = await loadAll();
const { groups, dropped } = run(rows);
console.log(`\n═══ 庄家意图回测:开盘(公众) vs 收盘(sharp)偏离 → 热门真实表现 ═══`);
console.log(`样本 ${rows.length} 场(剔除坏赔率 ${dropped})·football-data 10联赛6季真实开盘+收盘+赛果\n`);
const pc = (x) => (x * 100).toFixed(1) + "%";
console.log("组".padEnd(34) + "样本".padStart(7) + "开盘隐含".padStart(11) + "收盘隐含".padStart(11) + "实际命中".padStart(10) + "高估(隐含-实际)".padStart(16) + "跟投ROI".padStart(10));
for (const [name, g] of Object.entries(groups)) {
  if (!g.n) continue;
  const openAvg = g.openSum / g.n, closeAvg = g.closeSum / g.n, hit = g.favHit / g.n;
  const overEst = openAvg - hit, roi = g.roi / g.n;
  console.log(name.padEnd(32) + String(g.n).padStart(7) + pc(openAvg).padStart(11) + pc(closeAvg).padStart(11) + pc(hit).padStart(10) + ((overEst >= 0 ? "+" : "") + (overEst * 100).toFixed(1) + "pp").padStart(16) + ((roi >= 0 ? "+" : "") + (roi * 100).toFixed(1) + "%").padStart(10));
}
console.log(`\n判读:`);
console.log(`  若"收盘看淡热门"组实际命中 < 开盘隐含(高估为正且大),"收盘加注"组实际命中≈/≥隐含`);
console.log(`  → 证明"开盘vs收盘偏离"能真实识别被高估/可靠的热门 = 庄家意图研判有实战价值(识别力)。`);
console.log(`  注:这是用收盘修正开盘(收盘=sharp最准),非打败收盘线;跟投ROI含开盘vig,负值属正常(公开盘打不过收盘线)。`);
