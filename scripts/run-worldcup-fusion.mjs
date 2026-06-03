/**
 * 世界杯多模型融合引擎 (run-worldcup-fusion.mjs)
 * ------------------------------------------------------------------
 * 深度挖掘市面顶级世界杯预测大模型(Opta 超算 / Polymarket+Kalshi 预测市场)+
 * 本模型(Elo→Poisson 蒙特卡洛 + 自家市场列),做诚实的多模型融合。
 *
 * 诚实方法论(关键,避免自欺):
 *   - Opta、预测市场、本模型市场列 三家都含赔率成分 → 高度相关。
 *     直接四路平均 = 把"市场"重复计三次,系统性盖过唯一独立信号。
 *   - 正确:先把三路赔率派生源塌缩成单一【市场共识】,再与本模型【Elo 独立信号】
 *     做对数意见池(log-opinion-pool, 几何加权)融合。
 *   - 权重市场偏重(wMkt 0.65 / wElo 0.35),与既有 alpha 一致,
 *     �summarize 本项目实证"公开数据打不过市场"——融合是市场锚定 + 模型微调,
 *     不是"我们的模型最强"。
 *
 * 输出: D:/football-model-exports/worldcup-fusion-champion.json + 控制台表
 * 纯只读上游数据,不改任何现有产物。
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXPORTS = "D:/football-model-exports";
const W_ELO = 0.35;   // 本模型 Elo 独立信号权重
const W_MKT = 0.65;   // 市场共识权重(实证:市场难打)
const FLOOR = 0.03;   // log-pool 零概率地板(%)

const champ = JSON.parse(readFileSync(`${EXPORTS}/worldcup-champion-prob.json`, "utf8"));
const ext = JSON.parse(readFileSync("data/world-cup/external-model-forecasts.json", "utf8"));

// 外部源中文化
const toZh = ext.nameMap;
function distZh(srcDist) {
  const o = {};
  for (const [en, v] of Object.entries(srcDist)) {
    const zh = toZh[en];
    if (zh) o[zh] = v;
  }
  return o;
}
const optaZh = distZh(ext.sources.opta.dist);
const predZh = distZh(ext.sources.predMarket.dist);

// 32 队骨架(以本模型口径为准)
const teams = champ.rows.map((r) => r.team);

// 每路原始 %(缺失记 0)
const raw = teams.map((t) => {
  const row = champ.rows.find((r) => r.team === t);
  return {
    team: t,
    elo: row.elo,
    eloModel: row.model,          // 本模型独立
    ourMarket: row.market,        // 本模型自家市场列(赔率派生)
    opta: optaZh[t] ?? 0,         // Opta 超算(赔率派生)
    predMarket: predZh[t] ?? 0,   // Polymarket/Kalshi(赔率派生)
  };
});

// 各路在 32 队内归一到 100(外部源只列前 ~21-23,补零再归一)
function renorm(rows, key) {
  const s = rows.reduce((a, r) => a + r[key], 0) || 1;
  rows.forEach((r) => (r[`n_${key}`] = (r[key] / s) * 100));
}
["eloModel", "ourMarket", "opta", "predMarket"].forEach((k) => renorm(raw, k));

// 市场共识 = 三路赔率派生源(归一后)的均值,再归一
raw.forEach((r) => {
  r.mktConsensus = (r.n_ourMarket + r.n_opta + r.n_predMarket) / 3;
});
renorm(raw, "mktConsensus");

// 对数意见池融合: p ∝ elo^wElo * consensus^wMkt
raw.forEach((r) => {
  const a = Math.max(r.n_eloModel, FLOOR);
  const b = Math.max(r.n_mktConsensus, FLOOR);
  r._g = Math.pow(a, W_ELO) * Math.pow(b, W_MKT);
});
const gSum = raw.reduce((a, r) => a + r._g, 0);
raw.forEach((r) => (r.fused = (r._g / gSum) * 100));

// 分歧度(本模型独立信号 vs 市场共识),正=模型更看好(潜在 edge 或高估)
raw.forEach((r) => (r.edge = r.n_eloModel - r.n_mktConsensus));

raw.sort((x, y) => y.fused - x.fused);

const fmt = (v) => (v == null ? "—" : v.toFixed(1));
console.log("\n世界杯多模型融合 · 夺冠概率(%)  [Elo独立×市场共识 对数意见池]\n");
console.log("排名 球队        Elo   本模型  自家市  Opta  预测市  市场共识  ★融合   分歧");
console.log("─".repeat(82));
raw.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(2)}  ${r.team.padEnd(6)} ${String(r.elo).padStart(5)}  ` +
    `${fmt(r.n_eloModel).padStart(5)}  ${fmt(r.n_ourMarket).padStart(5)}  ${fmt(r.opta).padStart(4)}  ` +
    `${fmt(r.predMarket).padStart(5)}  ${fmt(r.n_mktConsensus).padStart(6)}  ${fmt(r.fused).padStart(6)}  ` +
    `${(r.edge >= 0 ? "+" : "") + r.edge.toFixed(1)}`
  );
});

// 最大分歧 = 看模型在哪儿与市场打架(诚实自检点)
const byEdge = [...raw].sort((a, b) => b.edge - a.edge);
console.log("\n本模型最看好(高于市场共识,潜在 edge 或高估):");
byEdge.slice(0, 4).forEach((r) => console.log(`  ${r.team}: 本模型 ${fmt(r.n_eloModel)}% vs 市场 ${fmt(r.n_mktConsensus)}% (+${r.edge.toFixed(1)})`));
console.log("本模型最看衰(低于市场共识):");
byEdge.slice(-4).reverse().forEach((r) => console.log(`  ${r.team}: 本模型 ${fmt(r.n_eloModel)}% vs 市场 ${fmt(r.n_mktConsensus)}% (${r.edge.toFixed(1)})`));

const top1 = raw[0];
console.log(`\n融合冠军首选: ${top1.team} ${fmt(top1.fused)}%`);
console.log(`模型选手投票(只给冠军的外部模型): ${ext.sources.modelPickers.votes.map((v) => `${v.model.split(" ")[0]}→${v.champion}`).join("; ")}`);
console.log("\n诚实:Opta/预测市场/自家市场三路相关,已塌缩为单一市场共识防重复计票;融合=市场锚定+Elo微调,非'模型最强'。国际赛 wld 上限~50-55%,融合不破天花板,价值在分布更稳/分歧暴露 edge。");

writeFileSync(`${EXPORTS}/worldcup-fusion-champion.json`, JSON.stringify({
  asOf: ext.asOf,
  method: "log-opinion-pool(Elo独立 × 市场共识[Opta+预测市场+自家市场塌缩]), wElo=" + W_ELO + " wMkt=" + W_MKT,
  sources: {
    eloModel: "本模型 Elo→Poisson 蒙特卡洛(独立)",
    ourMarket: "自家去抽水市场列",
    opta: ext.sources.opta.url,
    predMarket: ext.sources.predMarket.url,
  },
  weights: { wElo: W_ELO, wMkt: W_MKT },
  rows: raw.map((r) => ({
    team: r.team, elo: r.elo,
    eloModel: +r.n_eloModel.toFixed(2), ourMarket: +r.n_ourMarket.toFixed(2),
    opta: r.opta || null, predMarket: r.predMarket || null,
    mktConsensus: +r.n_mktConsensus.toFixed(2), fused: +r.fused.toFixed(2),
    edge: +r.edge.toFixed(2),
  })),
  modelPickerVotes: ext.sources.modelPickers.votes,
}, null, 1));
console.log(`\n已写 ${EXPORTS}/worldcup-fusion-champion.json`);
