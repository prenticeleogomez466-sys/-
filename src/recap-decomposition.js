/**
 * 深度归因复盘 · 信息拆解 + 规律挖掘(Recap Decomposition,2026-06-15)
 * ────────────────────────────────────────────────────────────
 * 用户裁决(2026-06-15):"复盘不光看命中率,要拆解所有信息——赔率初盘→收盘变化、战意、水位盘口、
 *   胜负平/让胜负平赔率、阵容、战术克制,它们之间的联系才造成结果导向,分析深层逻辑;
 *   跨场找共性、什么变化造成结果、有没有规律,才能判断下次买什么。"
 *
 * 两层:
 *   ① decomposeMatch(row):逐场把【已结算 ledger 行】拆成多维信号,每维标"是否指向了真实结果"+因果一句话。
 *   ② minePatterns(rows):跨场聚合找规律(赔率漂移/信心档/赛事/分歧/让球…→命中率 vs 基线 lift)。
 *
 * 严守铁律(三标签 + 打不过市场不装):
 *   ✅实测 = 直接来自 ledger 真实字段(初/收盘赔率、真实赛果、命中布尔);
 *   🔶推断 = 由实测派生的判断(漂移方向→资金流向、规律 lift),必注样本量 n;
 *   ⚠️缺   = 该维度未入历史 ledger(战意/阵容/战术/亚盘水位=临场情报,从不持久化)→标缺,绝不编。
 *   规律=🔶观测性,带样本量;**小样本/未经回测不得当预测 edge**(模型本无 CLV/打不过收盘线,见回测铁证)。
 * 纯函数、零 I/O、决定性。
 */

const WLD = { 主胜: "home", 平局: "draw", 客胜: "away" };
const OUT_ZH = { home: "主胜", draw: "平局", away: "客胜" };
const r2 = (x) => Math.round(x * 100) / 100;
const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

/** 主推方向初盘→收盘赔率漂移(✅实测,依据 primaryOpeningOdds→primaryOdds)。 */
export function oddsDrift(row) {
  const open = Number(row.primaryOpeningOdds), close = Number(row.primaryOdds);
  if (!(open > 1) || !(close > 1)) return null;
  const pct = r2(((close - open) / open) * 100);
  // 收盘<初盘=赔率收缩=资金涌入该方向(被加注);收盘>初盘=赔率走高=退烧
  const dir = pct <= -3 ? "收缩(被加注)" : pct >= 3 ? "走高(退烧)" : "基本不变";
  return { open, close, pct, dir };
}

/**
 * 逐场拆解(✅/🔶/⚠️):赔率漂移、胜负平、让胜负平、比分/半全场、信心档 + 临场情报维(标缺)。
 * @param {object} row 已结算 ledger 行
 */
export function decomposeMatch(row) {
  const actual = WLD[row.actual] ?? null;
  const model = WLD[row.primary] ?? null;
  const primaryHit = row.actual === row.primary;
  const dims = [];

  // ① 赔率初盘→收盘漂移 × 结果
  const dft = oddsDrift(row);
  if (dft) {
    let verdict, note;
    const moneyIn = dft.pct <= -3;       // 资金涌入主推方向
    const moneyOut = dft.pct >= 3;
    if (moneyIn && primaryHit) { verdict = "✅兑现"; note = `主推被加注(${dft.open}→${dft.close},${dft.pct}%)且命中——资金流向与结果一致`; }
    else if (moneyIn && !primaryHit) { verdict = "❌打脸"; note = `主推被加注(${dft.pct}%)却没中——热钱方向被打脸(临场资金≠结果)`; }
    else if (moneyOut && !primaryHit) { verdict = "✅兑现(反向)"; note = `主推退烧(赔率走高${dft.pct}%)且确实没中——市场提前减码兑现`; }
    else if (moneyOut && primaryHit) { verdict = "🔶逆势中"; note = `主推退烧(${dft.pct}%)却中了——逆资金流命中(偏运气/模型独立判断)`; }
    else { verdict = "—平"; note = `初盘≈收盘(${dft.pct}%),无明显资金流向`; }
    dims.push({ dim: "赔率漂移(初盘→收盘)", tag: "✅实测", verdict, signal: `${dft.open}→${dft.close}·${dft.dir}`, note });
  } else {
    dims.push({ dim: "赔率漂移(初盘→收盘)", tag: "⚠️缺", verdict: "—", signal: "初/收盘赔率未持久化", note: "该场未记初盘或收盘赔率,标缺" });
  }

  // ② 胜负平:模型主推 × 真实结果
  if (model && actual) {
    const conf = Math.max(row.probabilityHome || 0, row.probabilityDraw || 0, row.probabilityAway || 0);
    dims.push({
      dim: "胜负平(模型主推)", tag: "✅实测",
      verdict: primaryHit ? "✅兑现" : "❌落空",
      signal: `主推${OUT_ZH[model]}(模型${Math.round(conf * 100)}%)`,
      note: primaryHit ? `主推命中` : `实际${OUT_ZH[actual]}${actual === "draw" ? "(平局=模型主推结构盲区)" : ""}`,
    });
  }

  // ③ 让胜负平(让球)× 真实让球结果
  if (row.handicapWldCode != null && row.actualHandicapCode != null) {
    dims.push({
      dim: "让胜负平(让球盘)", tag: "✅实测",
      verdict: row.handicapWldHit ? "✅兑现" : "❌落空",
      signal: `让${row.handicapLine ?? "?"}·模型${row.handicapWld ?? row.handicapWldCode}`,
      note: row.handicapWldHit ? "让球方向命中" : `实际让球结果${row.actualHandicap ?? row.actualHandicapCode}`,
    });
  } else {
    dims.push({ dim: "让胜负平(让球盘)", tag: "⚠️缺", verdict: "—", signal: "无让球盘/未结算", note: "该场无官方让球线或未结算让球" });
  }

  // ④ 比分 / 半全场形态
  if (row.scorePrimary) {
    dims.push({
      dim: "比分形态", tag: "✅实测",
      verdict: row.scoreHit ? "✅兑现" : row.scoreSecondaryHit ? "🟡次选中" : "❌落空",
      signal: `首选${row.scorePrimary}`, note: `实际${row.actualScore ?? "?"}`,
    });
  }
  if (row.halfFullPrimary) {
    dims.push({
      dim: "半全场", tag: "✅实测",
      verdict: row.halfFullHit ? "✅兑现" : row.halfFullSecondaryHit ? "🟡次选中" : "❌落空",
      signal: `首选${row.halfFullPrimary}`, note: `实际${row.actualHalfFull ?? "?"}`,
    });
  }

  // ⑤ 信心档/风险
  if (row.confidence != null || row.tier) {
    dims.push({
      dim: "信心档/风险", tag: "🔶推断",
      verdict: primaryHit ? "✅兑现" : "❌落空",
      signal: `信心${row.confidence ?? "?"}·${row.tier ?? ""}${row.risk ? `·${row.risk}` : ""}`,
      note: "信心档=模型自评,兑现与否见结果",
    });
  }

  // ⑥ 临场情报维(战意/阵容/战术克制/亚盘水位)——历史 ledger 从不持久化,诚实标缺(不编)
  dims.push({ dim: "战意·阵容·战术克制·亚盘水位", tag: "⚠️缺", verdict: "—",
    signal: "临场情报未入历史复盘", note: "这些维度赛前在「情报详情」表展示,但未持久化进 ledger→历史复盘无法回溯(下一步:结算时快照情报入 ledger 即可纳入拆解)" });

  // 因果综述:哪些维度指向了真实结果(信号兑现) vs 落空
  const realDims = dims.filter((d) => d.tag === "✅实测");
  const aligned = realDims.filter((d) => d.verdict.startsWith("✅"));
  const misfired = realDims.filter((d) => d.verdict.startsWith("❌"));
  const synthesis = `本场${primaryHit ? "主推命中" : "主推落空"}:` +
    (aligned.length ? `兑现信号[${aligned.map((d) => d.dim.split("(")[0]).join("/")}]` : "无信号兑现") +
    (misfired.length ? `;落空信号[${misfired.map((d) => d.dim.split("(")[0]).join("/")}]` : "") +
    (dft && dft.pct <= -3 && !primaryHit ? ";⚠️深层:被加注方向打脸=临场热钱不等于结果(模型跟随收盘≠保命)" : "") +
    (actual === "draw" && !primaryHit ? ";⚠️深层:平局=模型主推从不选平的结构盲区" : "");

  return { date: row.date, match: row.match, comp: row.competition, primaryHit, dims, synthesis };
}

/**
 * 跨场规律挖掘(🔶观测性,带样本量 n)。找"什么共性/变化→什么结果",给下次判断参考。
 * **诚实:小样本(n<minN)或未经回测=不当预测 edge,仅描述已发生;模型本无 CLV/打不过收盘线。**
 * @param {Array} rows 已结算 ledger 行
 * @param {{minN?:number}} [opts]
 */
export function minePatterns(rows, opts = {}) {
  const minN = opts.minN ?? 8;
  const settled = rows.filter((r) => (r.actualStatus === "settled" || r.actual) && r.primary && r.actual);
  const n = settled.length;
  const baseHit = pctOf(settled.filter((r) => r.actual === r.primary).length, n);
  const patterns = [];
  const addBucket = (label, subset, dimName) => {
    if (subset.length < minN) return;
    const hit = pctOf(subset.filter((r) => r.actual === r.primary).length, subset.length);
    patterns.push({ dim: dimName, condition: label, n: subset.length, hitRate: hit, base: baseHit, lift: hit != null && baseHit != null ? hit - baseHit : null });
  };

  // 规律①:主推方向初盘→收盘漂移 → 命中率
  const drifted = settled.map((r) => ({ r, d: oddsDrift(r) })).filter((x) => x.d);
  addBucket("主推被加注(收盘≤初盘-3%)", drifted.filter((x) => x.d.pct <= -3).map((x) => x.r), "赔率漂移");
  addBucket("主推退烧(收盘≥初盘+3%)", drifted.filter((x) => x.d.pct >= 3).map((x) => x.r), "赔率漂移");
  addBucket("赔率基本不变(±3%内)", drifted.filter((x) => Math.abs(x.d.pct) < 3).map((x) => x.r), "赔率漂移");

  // 规律②:信心档 → 命中率
  const conf = (r) => Math.max(r.probabilityHome || 0, r.probabilityDraw || 0, r.probabilityAway || 0);
  addBucket("强信心(主推≥65%)", settled.filter((r) => conf(r) >= 0.65), "信心档");
  addBucket("中信心(55~65%)", settled.filter((r) => conf(r) >= 0.55 && conf(r) < 0.65), "信心档");
  addBucket("硬币档(50~55%)", settled.filter((r) => conf(r) >= 0.5 && conf(r) < 0.55), "信心档");

  // 规律③:赛事类型 → 命中率
  const isIntl = (r) => /世界杯|国际|友谊|预选|国家|洲/.test(r.competition || "");
  addBucket("国家队/国际赛", settled.filter(isIntl), "赛事类型");
  addBucket("俱乐部联赛", settled.filter((r) => !isIntl(r)), "赛事类型");

  // 规律④:主推方向 → 命中率(平局盲区/客胜信号弱的实证复现)
  addBucket("主推主胜", settled.filter((r) => r.primary === "主胜"), "主推方向");
  addBucket("主推客胜", settled.filter((r) => r.primary === "客胜"), "主推方向");
  addBucket("主推平局", settled.filter((r) => r.primary === "平局"), "主推方向");

  // 规律⑤:让球过盘
  const hcRows = settled.filter((r) => r.handicapWldHit != null);
  if (hcRows.length >= minN) {
    patterns.push({ dim: "让球盘", condition: "让球方向命中率", n: hcRows.length,
      hitRate: pctOf(hcRows.filter((r) => r.handicapWldHit).length, hcRows.length), base: null, lift: null });
  }

  // 规律⑥:实际结果里平局占比(对照"模型主推从不选平")
  const drawRate = pctOf(settled.filter((r) => r.actual === "平局").length, n);
  const modelDrawPick = pctOf(settled.filter((r) => r.primary === "平局").length, n);

  patterns.sort((a, b) => (Math.abs(b.lift ?? 0) - Math.abs(a.lift ?? 0)));
  return {
    n, baseHit, minN, patterns, drawRate, modelDrawPick,
    note: `🔶规律=观测性统计(样本n标注),非预测edge:小样本/未经leak-safe回测不得据此改下注;模型1X2本质市场跟随、打不过收盘线(回测铁证)。实际平局占比${drawRate}% vs 模型主推平局${modelDrawPick}%(平局盲区实证)。`,
  };
}

const parseGoals = (s) => { const m = String(s ?? "").match(/(\d+)-(\d+)/); return m ? { h: +m[1], a: +m[2] } : null; };

/** 一组场的【实际结果分布】(主/平/客% + 大2.5球% + BTTS% + 主队过盘%);n=0→空。 */
function outcomeDist(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const c = (f) => arr.filter(f).length;
  const homePct = pctOf(c((x) => x.r.actual === "主胜"), n);
  const drawPct = pctOf(c((x) => x.r.actual === "平局"), n);
  const awayPct = pctOf(c((x) => x.r.actual === "客胜"), n);
  const over25Pct = pctOf(c((x) => x.total >= 3), n);
  const bttsPct = pctOf(c((x) => x.sc.h > 0 && x.sc.a > 0), n);
  const hcRows = arr.filter((x) => x.r.actualHandicapCode != null);
  const homeCoverPct = hcRows.length ? pctOf(hcRows.filter((x) => String(x.r.actualHandicapCode) === "3").length, hcRows.length) : null;
  const modal = [["主胜", homePct], ["平局", drawPct], ["客胜", awayPct]].sort((a, b) => b[1] - a[1])[0];
  return { n, homePct, drawPct, awayPct, over25Pct, bttsPct, homeCoverPct, likely: `${modal[0]}${modal[1]}%`, avgGoals: r2(arr.reduce((t, x) => t + x.total, 0) / n) };
}

/**
 * 条件→大概率结果(🔶观测性):什么样的盘口/让球/赔率变化 → 实际结果分布(主/平/客% + 大球% + BTTS% + 过盘%)。
 * 直接回答用户"什么变化造成大概率什么结果"。临场维(阵容/战意/积分/战术/亚盘水位)历史ledger未持久化→列入"待积累"不挖。
 * @param {Array} rows 已结算 ledger 行;@param {{minN?:number}} [opts]
 */
export function mineConditionalOutcomes(rows, opts = {}) {
  const minN = opts.minN ?? 8;
  const settled = rows.filter((r) => (r.actualStatus === "settled" || r.actual) && r.actual && r.actualScore);
  const enrich = settled.map((r) => { const sc = parseGoals(r.actualScore); return sc ? { r, sc, total: sc.h + sc.a, drift: oddsDrift(r) } : null; }).filter(Boolean);
  const base = outcomeDist(enrich);
  const buckets = [];
  const add = (dim, label, subset) => { if (subset.length >= minN) buckets.push({ dim, condition: label, ...outcomeDist(subset) }); };
  const hcLine = (x) => Number(x.r.handicapLine);

  // 让球线变化 → 结果分布
  add("让球线", "深盘·主让≥1.5", enrich.filter((x) => hcLine(x) <= -1.5));
  add("让球线", "主让1球(-1)", enrich.filter((x) => hcLine(x) === -1));
  add("让球线", "主小让(-1<line<0)", enrich.filter((x) => hcLine(x) > -1 && hcLine(x) < 0));
  add("让球线", "平手盘(0)", enrich.filter((x) => hcLine(x) === 0));
  add("让球线", "客受让(line>0)", enrich.filter((x) => hcLine(x) > 0));
  // 赔率漂移(主推方向初盘→收盘)→ 结果分布
  add("赔率漂移", "主推被加注(收缩≤-3%)", enrich.filter((x) => x.drift && x.drift.pct <= -3));
  add("赔率漂移", "主推退烧(走高≥+3%)", enrich.filter((x) => x.drift && x.drift.pct >= 3));
  add("赔率漂移", "赔率稳定(±3%内)", enrich.filter((x) => x.drift && Math.abs(x.drift.pct) < 3));
  // 赛事类型 → 结果分布(国家队平局率高 vs 联赛)
  const isIntl = (r) => /世界杯|国际|友谊|预选|国家|洲/.test(r.competition || "");
  add("赛事类型", "国家队/国际赛", enrich.filter((x) => isIntl(x.r)));
  add("赛事类型", "俱乐部联赛", enrich.filter((x) => !isIntl(x.r)));
  // 模型信心档 → 结果分布
  const conf = (x) => Math.max(x.r.probabilityHome || 0, x.r.probabilityDraw || 0, x.r.probabilityAway || 0);
  add("模型信心", "强信心(≥65%)", enrich.filter((x) => conf(x) >= 0.65));
  add("模型信心", "硬币档(50~55%)", enrich.filter((x) => conf(x) >= 0.5 && conf(x) < 0.55));

  // 临场维(历史 ledger 未持久化)→ 诚实列"待积累",绝不编(快照机制上线后从该日起累积)
  const pending = ["阵容(预测/确认首发·缺阵)", "战意/动机(赛事重要性·已出线轮换)", "积分/排名压力(保级/争冠/出线形势)", "战术克制(阵型姿态对位)", "亚盘水位变化(初盘→临场水位)"];

  return {
    n: enrich.length, minN, base, buckets, pendingDims: pending,
    note: `🔶条件→结果=观测性分布(带样本n),非预测edge:模型1X2打不过收盘线、逆市场分歧是陷阱(回测铁证),规律仅供研判、未经leak-safe回测不得据此逆市下注。阵容/战意/积分/战术/亚盘水位=临场维,历史从未入ledger→已列"待积累",需快照入库后累积≥${minN}场方可挖,现标缺不编。`,
  };
}
