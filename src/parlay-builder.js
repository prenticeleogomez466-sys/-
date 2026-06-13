// 串关推荐构建(2026-06-12 用户需求:最稳/均衡/高赔/爆冷分档,胜负平/让球/比分/总进球/半全场混合过关)。
// 铁律对齐:
//   · 赔率=✅500真盘实测(快照/jqs实抓),缺该赔种=该玩法不出腿,绝不兜底;
//   · 概率=该玩法全集比例法 de-vig(🔶推断:与既有比分/半全场 de-vig 裁决一致,Power 已证伪勿换);
//   · 联合概率/EV=独立性假设下乘积(🔶推断,显式标注);串关 EV 恒负(抽水叠乘),如实展示不吹;
//   · 竞彩混合过关规则:同一场只能选一个玩法的一个选项入同一注串。
// 纯函数,不读盘不抓网;jqs 原始赔率由调用方传入(store 只存 de-vig 概率,原始赔率须实抓)。

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
  const legs = [];
  const push = (market, sels) => {
    const dv = devig(sels);
    if (!dv) return;
    sels.forEach((e, i) => legs.push({ market, sel: e.sel, odds: e.odds, probMkt: r3(dv.probs[i]), probModel: e.probModel ?? null, label: `${market}:${e.sel}@${e.odds}` }));
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
      sc.slice(0, 6).forEach((x, i) => legs.push({ market: "比分", sel: x.score, odds: x.odds, probMkt: r3(dv.probs[i]), probModel: null, label: `比分:${x.score}@${x.odds}` }));
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
    const odds = r2(legs.reduce((t, l) => t * l.odds, 1));
    const probMkt = r3(legs.reduce((t, l) => t * l.probMkt, 1));
    const hasModel = legs.every((l) => Number.isFinite(l.probModel));
    const probModel = hasModel ? r3(legs.reduce((t, l) => t * l.probModel, 1)) : null;
    return { legs, odds, probMkt, probModel, evMkt: r3(probMkt * odds - 1), evModel: probModel != null ? r3(probModel * odds - 1) : null };
  });
  const byProb = [...scored].sort((a, b) => b.probMkt - a.probMkt);
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
  const tiers = [
    { tier: "🛡️最稳", combos: take(byProb, maxPerTier, "全玩法中市场de-vig联合概率最高的搭法(稳=概率,非保中)") },
    { tier: "⚖️均衡", combos: take(byProb.filter((c) => c.odds >= 4 && c.odds < 9), maxPerTier, "串赔4~9倍区间内联合概率最高") },
    { tier: "🚀高赔", combos: take(byProb.filter((c) => c.odds >= 9 && c.odds < 40), maxPerTier, "串赔9~40倍区间内联合概率最高(比分/半全场天花板低,中率以联合概率为准)") },
    { tier: "🌋极限高赔", combos: take(byProb.filter((c) => c.odds >= 40), maxPerTier, "串赔≥40倍(多为比分/半全场互串),联合概率1%上下,纯彩票性质") },
    { tier: "💣爆冷", combos: take(byProb.filter((c) => c.legs.every((l) => l.probMkt <= 0.30)), maxPerTier, "每腿均为该玩法冷方向(de-vig≤30%),赔高但联合概率个位数%以下") },
  ].filter((t) => t.combos.length);
  // 模型分歧参考:模型联合概率有值且模型EV>市场EV的最大者(诚实:模型=市场跟随器,常无正EV)
  const mdl = scored.filter((c) => c.evModel != null).sort((a, b) => b.evModel - a.evModel)[0] ?? null;
  return { ok: true, tiers, modelBest: mdl, note: null };
}
