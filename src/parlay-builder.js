// 串关推荐构建(2026-06-12 用户需求:最稳/均衡/高赔/爆冷分档,胜负平/让球/比分/总进球/半全场混合过关)。
// 铁律对齐:
//   · 赔率=✅500真盘实测(快照/jqs实抓),缺该赔种=该玩法不出腿,绝不兜底;
//   · 概率=该玩法全集比例法 de-vig(🔶推断:与既有比分/半全场 de-vig 裁决一致,Power 已证伪勿换);
//   · 联合概率/EV=独立性假设下乘积(🔶推断,显式标注);串关 EV 恒负(抽水叠乘),如实展示不吹;
//   · 竞彩混合过关规则:同一场只能选一个玩法的一个选项入同一注串。
// 纯函数,不读盘不抓网;jqs 原始赔率由调用方传入(store 只存 de-vig 概率,原始赔率须实抓)。

import { adjustParlayForCorrelation } from "./parlay-correlation-adjuster.js";

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;

// 比例法 de-vig:p_i = (1/o_i) / Σ(1/o_j),全集归一(集合截断时 overround 仍>1 才可信,由调用处数据保证)
function devig(entries) {
  const inv = entries.map((e) => 1 / e.odds);
  const sum = inv.reduce((t, x) => t + x, 0);
  if (!(sum > 0)) return null;
  return { probs: inv.map((x) => x / sum), overround: sum };
}

// 单场全玩法腿候选。p=prediction(含 marketSnapshot),jqsOdds={0..7:赔率}|null。
// 每腿 = { market, sel, odds(✅), probMkt(🔶de-vig), probModel(🔶|null), label }
export function buildParlayLegs(p, jqsOdds = null) {
  const s = p.marketSnapshot ?? {};
  const home = p.fixture?.homeTeam ?? "主队", away = p.fixture?.awayTeam ?? "客队";
  // 腿对位元数据(供跨场相关性修正用;league/kickoff 真值,缺则 null 不编)
  const meta = {
    league: p.fixture?.competition ?? p.fixture?.league ?? null,
    kdate: p.fixture?.matchDateTime ?? p.fixture?.kickoff ?? p.fixture?.date ?? null,
    home, away,
  };
  const legs = [];
  // 每腿带 mktOverround=该玩法真盘抽水(Σ(1/o)>1 的溢出);串关价值=∏(1/overround),抽水越小价值越高(精确,非编造)。
  const push = (market, sels) => {
    const dv = devig(sels);
    if (!dv) return;
    sels.forEach((e, i) => legs.push({ market, sel: e.sel, odds: e.odds, probMkt: r3(dv.probs[i]), probMktRaw: dv.probs[i], probModel: e.probModel ?? null, mktOverround: r3(dv.overround), label: `${market}:${e.sel}@${e.odds}`, ...meta }));
  };
  // 胜负平(spf):赔率快照 current;模型概率=prediction.probabilities
  const eu = s.europeanOdds?.current;
  if (eu && [eu.home, eu.draw, eu.away].every((v) => Number(v) > 1)) {
    const mp = p.probabilities ?? {};
    push("胜负平", [
      { sel: `${home}胜`, odds: Number(eu.home), probModel: mp.home ?? null },
      { sel: "平局", odds: Number(eu.draw), probModel: mp.draw ?? null },
      { sel: `${away}胜`, odds: Number(eu.away), probModel: mp.away ?? null },
    ]);
  }
  // 让球胜平负(nspf):模型概率=handicapWld.probabilities(让球后三向)
  const hc = s.handicapOdds?.current;
  const line = s.jingcaiHandicap?.line ?? p.handicapPick?.line;
  if (hc && [hc.home, hc.draw, hc.away].every((v) => Number(v) > 1) && line != null) {
    const hw = p.handicapPick?.handicapWld?.probabilities ?? {};
    push(`让球(${line > 0 ? "+" : ""}${line})`, [
      { sel: `${home}让${line}胜`, odds: Number(hc.home), probModel: hw.home ?? null },
      { sel: "让平", odds: Number(hc.draw), probModel: hw.draw ?? null },
      { sel: `${away}受让胜`, odds: Number(hc.away), probModel: hw.away ?? null },
    ]);
  }
  // 比分(bf):store 已是全集(按赔率升序);候选只留前6档(长尾概率<2%无串关意义),de-vig 用全集
  const sc = s.scoreOdds?.top;
  if (Array.isArray(sc) && sc.length >= 6) {
    const dv = devig(sc.map((x) => ({ odds: x.odds })));
    if (dv && dv.overround > 1) {
      sc.slice(0, 6).forEach((x, i) => legs.push({ market: "比分", sel: x.score, odds: x.odds, probMkt: r3(dv.probs[i]), probMktRaw: dv.probs[i], probModel: null, mktOverround: r3(dv.overround), label: `比分:${x.score}@${x.odds}`, ...meta }));
    }
  }
  // 半全场(bqc):9 类全集
  const hf = s.halfFullOdds?.top;
  if (Array.isArray(hf) && hf.length === 9) {
    push("半全场", hf.map((x) => ({ sel: x.halfFull, odds: x.odds })));
  }
  // 总进球(jqs):原始赔率必须由调用方实抓传入(store 只存 de-vig 概率);缺=不出腿,绝不用概率反推赔率
  if (jqsOdds && Object.keys(jqsOdds).length >= 6) {
    const ent = Object.entries(jqsOdds).filter(([, o]) => Number(o) > 1)
      .map(([g, o]) => ({ sel: `${g}${g === "7" ? "+" : ""}球`, odds: Number(o) }));
    if (ent.length >= 6) push("总进球", ent);
  }
  return { match: `${home} vs ${away}`, seq: p.fixture?.sequence ?? "", legs };
}

// 跨场组合(每场一腿,符合"同场只能一个玩法"规则)。games=buildParlayLegs产物数组。
// 返回分档组合;每档按市场联合概率降序,跨档去重。
export function buildParlayPlan(games, { maxPerTier = 4 } = {}) {
  const usable = games.filter((g) => g.legs.length);
  if (usable.length < 2) return { ok: false, note: `可串场次不足(需≥2场有真实赔率,实际${usable.length}场)`, tiers: [] };
  // 2~4 腿串(2026-06-13 修 OOM):旧实现是"每场都串一腿"的全场笛卡尔积(k=N 腿 + 组合数=∏每场腿数),
  // 场次一多(今天业务日 10 场)即 8^10≈10.7 亿组合爆内存,且语义也错(串成 N 腿而非用户 0612 定的 2-4 腿)。
  // 改为按腿数 k∈{2,3,4} 枚举【场次组合】(同场只入一腿,守"混合过关同场一玩法"规则);
  // 场次多时收紧每场候选腿数(>6 场→top5,3<n≤6→top8,≤3→全保留=旧行为),并加硬上限防爆炸。
  const perGame = usable.length > 6 ? 5 : usable.length > 3 ? 8 : Infinity;
  const lists = usable.map((g) => {
    const sorted = [...g.legs].sort((a, b) => b.probMkt - a.probMkt);
    return sorted.slice(0, perGame).map((l) => ({ ...l, match: g.match, seq: g.seq }));
  });
  const COMBO_CAP = 200000;
  const combos = [];
  const maxK = Math.min(4, lists.length);
  const gameCombos = (k) => {
    const res = [];
    const pick = (start, acc) => {
      if (acc.length === k) { res.push([...acc]); return; }
      for (let i = start; i < lists.length; i++) { acc.push(i); pick(i + 1, acc); acc.pop(); }
    };
    pick(0, []);
    return res;
  };
  outer:
  for (let k = 2; k <= maxK; k++) {
    for (const idxs of gameCombos(k)) {
      let part = [[]];
      for (const gi of idxs) part = part.flatMap((c) => lists[gi].map((l) => [...c, l]));
      for (const legs of part) {
        combos.push(legs);
        if (combos.length >= COMBO_CAP) break outer;
      }
    }
  }
  const scored = combos.map((legs) => {
    const rawOdds = legs.reduce((t, l) => t * l.odds, 1);
    const odds = r2(rawOdds);
    const probMkt = r3(legs.reduce((t, l) => t * l.probMkt, 1));
    const hasModel = legs.every((l) => Number.isFinite(l.probModel));
    const probModel = hasModel ? r3(legs.reduce((t, l) => t * l.probModel, 1)) : null;
    // 抽水透明化(精确,非编造):combo overround=∏各玩法真盘抽水;价值效率 valueScore=∏(概率×赔率)=1/∏overround,
    // 越接近1抽水越小=结构最优。EV/价值从【未取整】devig概率算(probMkt/odds各自取整的乘积会虚增到≥1=伪正EV);
    // 数学保证 ∏overround>1 ⇒ valueScore<1 ⇒ EV 恒负。
    const overround = legs.every((l) => Number.isFinite(l.mktOverround))
      ? r3(legs.reduce((t, l) => t * l.mktOverround, 1)) : null;
    const valueScoreRaw = legs.reduce((t, l) => t * (l.probMktRaw ?? l.probMkt) * l.odds, 1);
    const valueScore = r3(valueScoreRaw);
    // 跨场相关性修正(🔶启发ρ,与14场胆串同源同口径,展示层不参与选档/不影响下注):
    const corr = adjustParlayForCorrelation(legs.map((l) => ({
      fixtureId: l.seq, league: l.league, kickoffDate: l.kdate, outcome: l.market,
      probability: l.probMkt, homeTeam: l.home, awayTeam: l.away,
    })));
    // 每注质量研判(纯展示,零编造):最弱腿(联合概率短板)、抽水最大腿、模型认同腿数(model≥市场=模型也看好该向)。
    const weakest = legs.reduce((m, l) => (l.probMkt < m.probMkt ? l : m), legs[0]);
    const maxVig = legs.reduce((m, l) => ((l.mktOverround ?? 0) > (m.mktOverround ?? 0) ? l : m), legs[0]);
    const modelLegs = legs.filter((l) => Number.isFinite(l.probModel));
    const modelAgree = modelLegs.filter((l) => l.probModel >= l.probMkt).length;
    const quality = {
      weakest: `${weakest.match}「${weakest.sel}」${(weakest.probMkt * 100).toFixed(0)}%`,
      maxVig: `${maxVig.market}(抽水${maxVig.mktOverround ?? "?"})`,
      modelAgree: modelLegs.length ? `${modelAgree}/${modelLegs.length}腿` : null,
    };
    return {
      legs, odds, probMkt, probModel, overround, valueScore, quality,
      probMktCorr: corr.ok ? corr.jointProbabilityCorrelated : null,
      corrAdjPct: corr.ok ? corr.adjustmentPct : null,
      evMkt: r3(valueScoreRaw - 1), evModel: probModel != null ? r3(probModel * odds - 1) : null,
    };
  });
  const byProb = [...scored].sort((a, b) => b.probMkt - a.probMkt);
  // 全空间按价值效率降序(抽水最小优先);各风险档"该层最优解"=本档赔率区间内价值效率最高的搭法(非单纯联合概率)。
  const byValueAll = [...scored].sort((a, b) => b.valueScore - a.valueScore || b.probMkt - a.probMkt);
  // 价值最优:抽水最小的真串(odds≥3,排除两热门凑数的伪串);这是"混合串关最优化"的核心答案。
  const byValue = byValueAll.filter((c) => c.odds >= 3 && c.valueScore != null);
  const seen = new Set();
  const key = (c) => c.legs.map((l) => `${l.seq}|${l.market}|${l.sel}`).join("&");
  const take = (arr, n, why) => {
    const out = [];
    for (const c of arr) {
      if (out.length >= n) break;
      if (seen.has(key(c))) continue;
      seen.add(key(c)); out.push({ ...c, why });
    }
    return out;
  };
  // 完整阶梯【从最稳到高配】:每档=该风险层我能给的最优解。最稳按联合概率(保中率优先);其余各档按价值效率(同赔率区间内抽水最小=最不亏)。
  const tiers = [
    { tier: "🛡️最稳", combos: take(byProb, maxPerTier, "阶梯①最稳:全玩法中市场de-vig联合概率最高(稳=概率最大,非保中);多为低赔大热搭法") },
    { tier: "💎性价比", combos: take(byValue, maxPerTier, "阶梯②性价比:全空间价值效率最高(valueScore=概率×串赔=1/∏各玩法抽水,越接近1越不亏);EV恒负,此=结构最优解,多为低抽水胜负平/让球") },
    { tier: "⚖️均衡", combos: take(byValueAll.filter((c) => c.odds >= 4 && c.odds < 9), maxPerTier, "阶梯③均衡:串赔4~9倍区间内价值效率最高(兼顾赔率与抽水的该层最优)") },
    { tier: "🚀进取", combos: take(byValueAll.filter((c) => c.odds >= 9 && c.odds < 40), maxPerTier, "阶梯④进取:串赔9~40倍区间内价值效率最高(博赔但选抽水最小的搭法)") },
    { tier: "🏆高配", combos: take(byValueAll.filter((c) => c.odds >= 40), maxPerTier, "阶梯⑤高配:串赔≥40倍(多为比分/半全场互串),区间内价值效率最高=高赔里相对最不亏;联合概率1%上下,博大彩性质") },
    { tier: "💣爆冷", combos: take(byValueAll.filter((c) => c.legs.every((l) => l.probMkt <= 0.30)), maxPerTier, "阶梯⑥爆冷:每腿均为该玩法冷方向(de-vig≤30%),区间内价值效率最高;赔高但联合概率个位数%以下,纯搏冷") },
  ].filter((t) => t.combos.length);
  // 模型分歧参考:模型联合概率有值且模型EV>市场EV的最大者(诚实:模型=市场跟随器,常无正EV)
  const mdl = scored.filter((c) => c.evModel != null).sort((a, b) => b.evModel - a.evModel)[0] ?? null;
  // 相关性汇总(🔶):取最稳头注的修正幅度作代表(同源14场胆串口径;展示层,不参与选档)
  const repr = tiers[0]?.combos?.[0] ?? null;
  const correlationNote = (repr && repr.corrAdjPct != null && Math.abs(repr.corrAdjPct) >= 0.005)
    ? `🔶跨场相关性修正(同源14场胆串ρ):头注独立联合概率${(repr.probMkt * 100).toFixed(1)}%→相关性修正${(repr.probMktCorr * 100).toFixed(1)}%(${repr.corrAdjPct > 0 ? "同联赛/同日正相关→实际略高" : "反向腿负相关→实际略低"});仅展示,EV/选档仍按独立口径`
    : "🔶腿间相关性弱(±0.5%内,跨场基本独立),联合概率按独立口径";
  return { ok: true, tiers, modelBest: mdl, correlationNote, note: null };
}
