import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEuropeanOdds, wcFixturesFromSnapshots, eloContradiction } from "../scripts/ingest-worldcup-match-odds.mjs";

test("pickEuropeanOdds 取 final>current>initial,无效/缺失→null(不臆造)", () => {
  assert.deepEqual(pickEuropeanOdds({ initial: { home: 2, draw: 3, away: 4 }, current: { home: 1.9, draw: 3.1, away: 4.2 } }),
    { home: 1.9, draw: 3.1, away: 4.2 });
  assert.deepEqual(pickEuropeanOdds({ current: { home: 1.5, draw: 4, away: 7 }, final: { home: 1.4, draw: 4.5, away: 8 } }),
    { home: 1.4, draw: 4.5, away: 8 });
  assert.equal(pickEuropeanOdds(null), null);
  assert.equal(pickEuropeanOdds({ current: null }), null);
  assert.equal(pickEuropeanOdds({ current: { home: 1, draw: 3, away: 4 } }), null); // home<=1 无效
});

test("wcFixturesFromSnapshots 只收世界杯真实欧赔,14场胜负彩(europeanOdds=null)跳过", () => {
  const zhToEn = { "墨西哥": "Mexico", "南非": "South Africa", "韩国": "Korea Republic", "捷克": "Czechia" };
  const snaps = [
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", marketType: "jingcai",
      europeanOdds: { current: { home: 1.5, draw: 4, away: 7 } }, collectedAt: "2026-06-10T00:00:00Z", source: "jc" },
    { competition: "世界杯", homeTeam: "韩国", awayTeam: "捷克", marketType: "shengfucai",
      europeanOdds: null, asianHandicap: { current: { line: -0.25 } }, collectedAt: "2026-06-09" }, // 14场无欧赔→跳过
    { competition: "国际赛", homeTeam: "克罗地亚", awayTeam: "斯洛文尼亚",
      europeanOdds: { current: { home: 1.24, draw: 4.6, away: 9.45 } }, collectedAt: "2026-06-07" }, // 非世界杯→跳过
  ];
  const m = wcFixturesFromSnapshots(snaps, zhToEn, "fallback");
  assert.equal(m.size, 1, "只墨西哥vs南非一条");
  const fx = [...m.values()][0];
  assert.equal(fx.home, "Mexico"); // 中文→groups 英文规范名
  assert.equal(fx.away, "South Africa");
  assert.deepEqual(fx.odds, { home: 1.5, draw: 4, away: 7 });
});

test("wcFixturesFromSnapshots 同对阵保留 collectedAt 最新", () => {
  const zhToEn = { "墨西哥": "Mexico", "南非": "South Africa" };
  const snaps = [
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", europeanOdds: { current: { home: 1.6, draw: 3.9, away: 6 } }, collectedAt: "2026-06-08" },
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", europeanOdds: { current: { home: 1.5, draw: 4.0, away: 7 } }, collectedAt: "2026-06-10" },
  ];
  const fx = [...wcFixturesFromSnapshots(snaps, zhToEn).values()][0];
  assert.equal(fx.collectedAt, "2026-06-10");
  assert.equal(fx.odds.away, 7);
});

// ── 常识闸 eloContradiction(F1 防再犯:CubeGoal 错映射赔率别再写回)──
// 注入假 Elo 表,不依赖 team-priors.json 数据文件。
const ELO = { Germany: 1925, Curacao: 1433, Iraq: 1608, Norway: 1912, Mexico: 1700, "South Africa": 1520,
  "Ivory Coast": 1676, Ecuador: 1935 };
const fakePrior = (name) => (ELO[name] != null ? { en: name, elo: ELO[name] } : null);

test("eloContradiction:真实方向一致的好数据通过(强队为热门)", () => {
  // 德国 vs 库拉索 真实盘(ESPN DraftKings 实测 1.029/17/29):德国大热,与 Elo +492 同向 → 通过
  assert.equal(eloContradiction({ home: "Germany", away: "Curacao", odds: { home: 1.029, draw: 17, away: 29 } }, fakePrior), null);
  // 伊拉克 vs 挪威 真实盘(14/7/1.211):客队挪威大热,与 Elo -304 同向 → 通过
  assert.equal(eloContradiction({ home: "Iraq", away: "Norway", odds: { home: 14, draw: 7, away: 1.211 } }, fakePrior), null);
});

test("eloContradiction:真实市场分歧不误杀(Ivory Coast vs Ecuador 500实盘)", () => {
  // Elo差 -259(>250 进闸)但 500 实盘 3.36/2.65/2.2 被 ESPN/DK 3.6/2.85/2.45 印证为真实分歧
  // (市场不看好 Elo 高估的厄瓜多尔),shortfall≈0.24<0.30 → 必须通过,不准误杀
  assert.equal(eloContradiction({ home: "Ivory Coast", away: "Ecuador", odds: { home: 3.36, draw: 2.65, away: 2.2 } }, fakePrior), null);
});

test("eloContradiction:CubeGoal 两条错映射坏数据被拦(原样赔率)", () => {
  // 坏条1(84691 错映射):Iraq vs Norway 2.03/3.89/2.64,伊拉克成热门但 Elo 差 -304 → 方向闸拦
  const badIraq = eloContradiction({ home: "Iraq", away: "Norway", odds: { home: 2.03, draw: 3.89, away: 2.64 } }, fakePrior);
  assert.ok(badIraq, "伊拉克成热门(Elo差-304)必须被拦");
  assert.match(badIraq, /弱队反成热门/);
  // 坏条2(84681 错映射):Germany vs Curacao 1.94/4.6/2.52,德国仍是热门方向但量级假
  // (Elo+492 → We≈0.945,市场隐含 we≈0.56,shortfall≈0.38>0.30)→ 方向闸拦不住,量级闸必须拦
  const badGer = eloContradiction({ home: "Germany", away: "Curacao", odds: { home: 1.94, draw: 4.6, away: 2.52 } }, fakePrior);
  assert.ok(badGer, "德国 1.94 量级假(ESPN实测1.029)必须被拦");
  assert.match(badGer, /量级假/);
});

test("eloContradiction:Elo差≤250 或缺 Elo → 不拦(无法判定不臆造)", () => {
  // Mexico vs South Africa Elo差 180 ≤ 250:即使客队热门也不拦(正常冷门盘不误杀)
  assert.equal(eloContradiction({ home: "Mexico", away: "South Africa", odds: { home: 3.2, draw: 3.3, away: 2.1 } }, fakePrior), null);
  // 任一队无 Elo → 不拦
  assert.equal(eloContradiction({ home: "Atlantis", away: "Norway", odds: { home: 1.2, draw: 6, away: 12 } }, fakePrior), null);
  // 无效赔率 → 交给既有闸,不在此拦
  assert.equal(eloContradiction({ home: "Germany", away: "Curacao", odds: { home: 1, draw: 4, away: 9 } }, fakePrior), null);
});
