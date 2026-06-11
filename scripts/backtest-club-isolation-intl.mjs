#!/usr/bin/env node
/**
 * 小回测(2026-06-11 ledger-settlement-1 铁律要求:动概率前先回测):
 * 国家队场先验 —— "被国家队薄样本污染的俱乐部 DC(旧路径)" vs "club-only 隔离后落到的
 * national-Elo 先验(新路径)" 在 store 已结算国际赛上的真实表现对比。
 *
 * 口径(leak-safe 尽力):
 *   - 评测集 = store 全部已结算国际赛唯一场(同场跨文件副本按最新业务日取 1 份;
 *     赛果已经 detox-store-conflicts-2026-06-11 以 ESPN 仲裁清洗);
 *   - 旧臂 = 按旧代码语义重建:拟合池含国际赛、不去重,严格只用赛日前(date<D)的赛果
 *     walk-forward 拟合;预测后过生产同款物理 λ 闸(isPhysicalLambda),不物理 → 退
 *     national-Elo(与 prediction-engine 生产链一致);
 *   - 新臂 = club-only 隔离后国家队不在 DC 训练集 → 直接 national-Elo 先验
 *     (洲际校正不加,两臂同口径,差异只来自"污染 DC vs Elo");
 *   - 两臂都无先验的场剔除;只统计两臂可比的场。
 *   - 诚实声明:national-elo.json 为当前快照(Elo 移动缓慢,3 个月窗内偏差小),
 *     两臂的 Elo 回退用同一快照 → 该偏置对"两臂差值"近似中性。
 *
 * 用法:node scripts/backtest-club-isolation-intl.mjs
 */
import "../src/env.js";
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { isSoftCompetition } from "../src/competition-soft-recalibration.js";
import { isPhysicalLambda } from "../src/prediction-engine.js";
import { loadNationalElo, nationalEloFor, eloToLambdas } from "../src/national-elo-source.js";
import { buildDerivedScoreModel } from "../src/derived-score-model.js";

const NB_SIZE_SOFT = 8; // 与 prediction-engine 国家队 Elo 分支同款

const SINCE = process.argv[2] ?? "2026-03-01";

// ── 1. 全量收集(业务日降序;复刻旧代码:不隔离、不去重) ──
const allRows = [];
for (const date of listFixtureDates()) {
  const { fixtures } = loadFixtures(date);
  for (const f of fixtures) {
    if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
    const matchDay = String(f.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? f.date;
    allRows.push({
      storeDate: date, matchDay,
      home: f.homeTeam, away: f.awayTeam,
      homeGoals: f.result.home, awayGoals: f.result.away,
      date: f.date, league: f.competition ?? f.league ?? null,
      soft: isSoftCompetition(f.competition ?? f.league),
    });
  }
}

// ── 2. 评测集:唯一国际赛场(最新业务日副本),赛日 ≥ SINCE 且已踢 ──
const elo = loadNationalElo();
const seen = new Set();
const evalMatches = [];
for (const r of allRows) { // allRows 已按业务日降序 → 首见=最新副本
  if (!r.soft) continue;
  const key = `${r.matchDay}|${r.home}|${r.away}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (r.matchDay < SINCE || r.matchDay > "2026-06-11") continue;
  const eh = nationalEloFor(elo, r.home);
  const ea = nationalEloFor(elo, r.away);
  if (!Number.isFinite(eh) || !Number.isFinite(ea)) continue; // 无 Elo 两臂同缺,剔除
  evalMatches.push({ ...r, eh, ea });
}

const actualOf = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const argmaxOf = (p) => ["home", "draw", "away"].reduce((b, k) => (p[k] > p[b] ? k : b), "home");
const brierOf = (p, actual) => ["home", "draw", "away"].reduce((s, k) => s + ((p[k] - (k === actual ? 1 : 0)) ** 2), 0);

function eloPrior(m) {
  const lam = eloToLambdas(m.eh, m.ea);
  if (!lam) return null;
  const model = buildDerivedScoreModel(lam.home, lam.away, { nbSize: NB_SIZE_SOFT });
  return model?.probabilities ?? null;
}

// ── 3. 旧臂:按赛日分组,一日一拟合(池=赛日前全部赛果,含国际赛、含重复副本) ──
const byDay = new Map();
for (const m of evalMatches) {
  if (!byDay.has(m.matchDay)) byDay.set(m.matchDay, []);
  byDay.get(m.matchDay).push(m);
}
const days = [...byDay.keys()].sort();
console.log(`评测集:${evalMatches.length} 场国际赛(${days.length} 个赛日,${SINCE}..2026-06-11,两队均有国家队 Elo)`);

const stats = { old: { n: 0, hit: 0, brier: 0 }, neo: { n: 0, hit: 0, brier: 0 } };
const deltas = [];
for (const day of days) {
  const pool = allRows
    .filter((r) => r.date < day && r.matchDay >= shiftDays(day, -540))
    .map((r) => ({ home: r.home, away: r.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals, date: r.date, league: r.league }));
  const fitOld = fitFromMatches(pool, { referenceDate: day });
  for (const m of byDay.get(day)) {
    const actual = actualOf(m);
    const pElo = eloPrior(m);
    // 旧臂:污染 DC → 物理闸 → 不物理/无训练退 Elo(生产语义)
    let dc = predictFromFitted(fitOld, { homeTeam: m.home, awayTeam: m.away });
    if (dc?.expectedGoals && !isPhysicalLambda(dc.expectedGoals)) dc = null;
    const pOld = dc?.probabilities ?? pElo;
    const pNew = pElo; // 新臂:club-only 隔离 → 国家队恒走 Elo 先验
    if (!pOld || !pNew) continue;
    stats.old.n++; stats.old.hit += argmaxOf(pOld) === actual ? 1 : 0; stats.old.brier += brierOf(pOld, actual);
    stats.neo.n++; stats.neo.hit += argmaxOf(pNew) === actual ? 1 : 0; stats.neo.brier += brierOf(pNew, actual);
    if (argmaxOf(pOld) !== argmaxOf(pNew) || Math.abs(pOld.home - pNew.home) > 0.03) {
      deltas.push({ day, match: `${m.home} vs ${m.away}`, actual, old: argmaxOf(pOld), neo: argmaxOf(pNew), pOldH: pOld.home.toFixed(3), pNewH: pNew.home.toFixed(3) });
    }
  }
}

function shiftDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}

const fmt = (s) => `n=${s.n} 命中=${s.hit}(${(100 * s.hit / Math.max(1, s.n)).toFixed(1)}%) Brier=${(s.brier / Math.max(1, s.n)).toFixed(4)}`;
console.log(`旧臂(污染俱乐部DC+物理闸退Elo): ${fmt(stats.old)}`);
console.log(`新臂(club-only隔离→national-Elo): ${fmt(stats.neo)}`);
console.log(`两臂分歧场(主推不同或主胜概率差>3pp):${deltas.length}`);
for (const d of deltas) console.log(`  ${d.day} ${d.match} 实际=${d.actual} 旧推=${d.old}(pH=${d.pOldH}) 新推=${d.neo}(pH=${d.pNewH})`);
const hitDelta = (stats.neo.hit / Math.max(1, stats.neo.n)) - (stats.old.hit / Math.max(1, stats.old.n));
const brierDelta = (stats.neo.brier / Math.max(1, stats.neo.n)) - (stats.old.brier / Math.max(1, stats.old.n));
console.log(`\n净效果:命中 ${hitDelta >= 0 ? "+" : ""}${(100 * hitDelta).toFixed(2)}pp,Brier ${brierDelta >= 0 ? "+" : ""}${brierDelta.toFixed(4)}(负=更好)`);
