// 输出层单写者收敛(2026-06-10 缺陷#5#7#8#12#16#17#20):
//   xlsx(20列专业版)+ 手机页(核心7列点开看全部)+ 英文固定URL页(football.html)
//   三面渲染的唯一真相源。所有"今日交付"脚本一律经 scripts/today-full-coverage.mjs → 本库,
//   旁路写者(today-complete-5 / today-mobile-consistent / today-twotable-xlsx / today-full-output /
//   render-today-mobile / render-recommendation-html / jingcai-daily 桌面copy+openpyxl polish)已改薄壳或摘除。
// 纯函数,不碰 fs —— 可单测(日期必传/banner真计数/审计背书缺文件不写/双日期三面一致)。

// ── 日期解析:显式参数必须合法,缺参用本机 UTC+8 当日;非法直接 throw(fail-loud,绝不猜) ──
export function resolveDeliveryDate(arg, now = new Date()) {
  if (arg != null && arg !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      throw new Error(`日期参数非法:"${arg}"(要求 YYYY-MM-DD)。拒绝猜测日期,不出表。`);
    }
    return arg;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// ── 各赔种真实填充计数(缺陷#8:banner 分子用实数,绝不写 N/N 假全覆盖) ──
// 判定依据 = 渲染串里的 ✅ 真盘标记(euroStr/hcStr/ouRealStr/scoreMktStr/hfMktStr/asianStr 只在真有数据时打 ✅)。
export function buildOddsFillCounts(rows) {
  const has = (s) => /✅/.test(String(s ?? ""));
  return {
    total: rows.length,
    euro: rows.filter((r) => has(r.euro)).length,
    handicap: rows.filter((r) => /✅500让球/.test(String(r.hc ?? ""))).length,
    score: rows.filter((r) => has(r.scoreMkt)).length,
    halffull: rows.filter((r) => has(r.hfMkt)).length,
    ou: rows.filter((r) => /✅500总进球/.test(String(r.ouReal ?? ""))).length,
    asian: rows.filter((r) => has(r.asian)).length,
  };
}

// ── 市场输入降级显著标注(缺陷#12:odds.xml失败/大小球缺/外盘401 → 不打✅,banner 明示) ──
export function buildDegradeNote(counts, covMissing) {
  const n = counts.total;
  const gaps = [];
  if (counts.euro < n) gaps.push(`欧赔缺${n - counts.euro}场`);
  if (counts.handicap < n) gaps.push(`让球赔率缺${n - counts.handicap}场`);
  if (counts.score < n) gaps.push(`比分盘缺${n - counts.score}场`);
  if (counts.halffull < n) gaps.push(`半全场盘缺${n - counts.halffull}场`);
  if (counts.ou < n) gaps.push(`大小球缺${n - counts.ou}场`);
  if (counts.asian < n) gaps.push(`亚盘(外盘)缺${n - counts.asian}场`);
  if (covMissing) gaps.push("近5/H2H/画像整层未补全(coverage缺)");
  if (!gaps.length) return "";
  return `⚠️市场输入降级:${gaps.join("、")}——缺口逐格已标⚠️未打✅,缺就标缺不冒充。`;
}

// ── banner 赔率覆盖段(逐赔种实数) ──
export function buildOddsCoverageLine(counts) {
  const n = counts.total;
  return `欧赔${counts.euro}/${n}·让球${counts.handicap}/${n}·比分${counts.score}/${n}·半全场${counts.halffull}/${n}·大小球${counts.ou}/${n}(500竞彩真盘实数)+亚盘${counts.asian}/${n}(DK+titan007双源)`;
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-06-11 渲染层升级(用户裁决,最高优先):
//   ① 世界杯模型先验透明列组(Elo先验/confedAdj/场馆λ/出线夺冠%)——归属"世界杯模型",
//      与市场锚列(足球大模型)并排,两模型贡献一眼分清;非WC场标"—"。
//   ② 让球方向列=模型真实裁决(handicapWld argmax),可与胜平负不同向;不同向时格内注逻辑
//      (修订旧"四列同向"铁律:让球列放行真实裁决,胜负平/比分/半全场三列仍同向)。
//   ③ 串关安全度三级(信心档+risk+证伪标签);只标注不替用户弃赛。
//   ④ 数据审计工作表(场×数据维度矩阵,每格=值+来源+抓取时间+三标签)+ 内容审计区。
// 全部纯函数,不碰 fs,可单测。
// ════════════════════════════════════════════════════════════════════════════

// ── ① 世界杯模型先验透明列组(仅世界杯场;缺哪项标哪项,绝不编) ──
export function wcPriorCells({ isWc, prior, lambdaCtx, wcLine }) {
  if (!isWc) return { elo: "⚠️非世界杯场缺(俱乐部联赛无国家队Elo先验,胜负平由每日大模型给)", lambda: "—", tourney: "—" };
  let elo;
  if (prior?.probabilities) {
    const p = prior.probabilities;
    const adj = Number(prior.confedAdj) || 0;
    const ha = Number(prior.homeAdv) || 0;
    const sgn = (v) => `${v >= 0 ? "+" : ""}${v}`;
    elo = `主${Math.round(p.home * 100)}%/平${Math.round(p.draw * 100)}%/客${Math.round(p.away * 100)}%(eloDiff${sgn(prior.eloDiff)}·洲际校正confedAdj${sgn(adj)}${ha ? `·东道主+${ha}` : ""})✅Elo底座`;
  } else {
    elo = "⚠️Elo先验缺(任一队不在48强Elo名单,标缺不编)";
  }
  let lambda;
  if (lambdaCtx?.isWC) {
    const v = lambdaCtx.venue;
    lambda = `×${lambdaCtx.lambdaMult}${v ? `(${v.city}·海拔${v.altitude_m}m${v.indoor ? "·恒温顶棚" : ""})` : ""}${lambdaCtx.factors?.length ? `｜${lambdaCtx.factors.join("；")}` : ""}`;
  } else {
    lambda = "⚠️场馆λ缺(世界杯上下文未解析)";
  }
  return { elo, lambda, tourney: wcLine || "⚠️超算json缺(出线/夺冠%未算)" };
}

// ── ② 让球方向·模型真实裁决(handicapWld argmax;与胜平负不同向时注逻辑) ──
export function handicapVerdictParts({ line, wldCode, wldLabel, hw, marketDist, lineReal = true }) {
  if (!hw?.pickCode) return { text: "⚠️让球真实裁决缺(无让球三态分布)", sameDir: null, note: null, verdict: null, modelPct: null, marketPct: null };
  // 2026-06-13 铁律(用户三次重申"不许冒充·我要下注"):竞彩官方让球线未抓到时,过盘%只能按推断线算=不可信。
  //   按 feedback_no_fallback_absolute=标缺不冒充:本场不出让球过盘数字,绝不用推断线盖✅500冒充真实裁决。
  if (!lineReal) {
    return {
      text: "⚠️竞彩官方让球线未抓到→本场不出让球过盘分析(让球赔率✅500在,具体线以竞彩App实际为准;绝不用推断线冒充真实过盘)",
      sameDir: null, note: "line-missing", verdict: null, modelPct: null, marketPct: null, lineReal: false,
    };
  }
  const L = Number(line) || 0;
  const absL = Math.abs(L);
  const lineStr = L > 0 ? `受让+${L}` : L < 0 ? `让${L}` : "平手";
  const mKey = { "3": "home", "1": "push", "0": "away" }[hw.pickCode];
  const modelPct = Math.round((hw.probability ?? hw.probabilities?.[mKey] ?? 0) * 100);
  const marketPct = marketDist && Number.isFinite(marketDist[mKey]) ? Math.round(marketDist[mKey] * 100) : null;
  const sameDir = hw.pickCode === String(wldCode);
  let note = null;
  if (!sameDir) {
    if (wldCode === "3" && L < 0) {
      note = hw.pickCode === "1" ? `主胜但最可能恰好只赢${absL}球→走盘` : `主胜但难净胜${absL}球→让球客胜`;
    } else if (wldCode === "0" && L > 0) {
      note = hw.pickCode === "1" ? `客胜但最可能恰好只赢${absL}球→走盘` : `客胜但难净胜${absL}球→受让方主队过盘(让球主胜)`;
    } else {
      note = `胜平负主推${wldLabel ?? "—"},让球盘(${lineStr})按比分分布真实裁决=${hw.pick}——让球问"过不过盘"非"谁赢",两问可不同向`;
    }
  }
  const text = `${hw.pick} 过盘${modelPct}%(模型)${marketPct != null ? ` vs ${marketPct}%(市场)` : "(市场赔率⚠️缺)"}〔${lineStr}〕${sameDir ? "·与胜平负同向" : `\n⚠️与胜平负不同向:${note}`}`;
  return { text, sameDir, note, verdict: hw.pick, modelPct, marketPct, lineStr };
}

// ── ③ 串关安全度(信心档+risk+证伪标签 三级;只标注供搭串参考) ──
export function parlaySafety({ tier, risk, advLabel }) {
  const t = String(tier ?? ""), a = String(advLabel ?? "");
  if (/硬币/.test(t)) return { grade: "⛔", text: "⛔串关排除(硬币场·势均无真优势)" };
  if (/证伪/.test(a)) return { grade: "⛔", text: "⛔串关排除(三视角对抗证伪场)" };
  const why = [];
  if (!/一档|二档/.test(t)) why.push(`信心档不足(${t || "档位缺"})`);
  if (String(risk ?? "") === "高") why.push("risk=高");
  if (!a) why.push("证伪未覆盖该场");
  if (!why.length) return { grade: "🟢", text: "🟢串关候选(一/二档·非高风险·未被证伪)" };
  return { grade: "🟡", text: `🟡谨慎(${why.join("·")})` };
}
export const PARLAY_ORDER_NOTE = "串关安全度三级:🟢串关候选=一/二档+非高风险+证伪未杀;🟡谨慎=档位/风险/审计覆盖任一不足;⛔串关排除=硬币场或三视角证伪场。只标注供搭串参考,买不买你定。";

// ── H2H 渲染:新版本地49k历史库对象({source,label,meetings})+ 旧版 ESPN 数组兼容;零交锋如实标⚠️ ──
export function renderH2hCell(h2h, homeZh) {
  if (!h2h) return "⚠️未取到";
  if (Array.isArray(h2h)) {
    return h2h.length ? h2h.map((x) => `${x.date} ${homeZh}${x.gf}-${x.ga}(${x.res})`).join(" / ") : "近赛季窗口无交锋(ESPN免费源限近赛季)";
  }
  const ms = Array.isArray(h2h.meetings) ? h2h.meetings : [];
  if (!ms.length) return `⚠️零交锋:本地49k国际赛历史库(1872-2026)未见两队交手〔${h2h.source ?? "源缺"}〕`;
  const flip = (score) => { const m = String(score).match(/(\d+)-(\d+)/); return m ? `${m[2]}-${m[1]}` : score; };
  const view = ms.slice(0, 4).map((m) => {
    const homeFirst = !h2h.homeEn || m.home === h2h.homeEn;
    const sc = homeFirst ? m.score : flip(m.score);
    return `${m.date} ${homeZh}${sc}(${m.resForFixtureHome ?? "—"}·${m.tournament ?? ""}${m.neutral ? "·中立" : ""})`;
  }).join(" / ");
  return `${view}${ms.length > 4 ? ` 等${ms.length}次` : ""} ${h2h.label ?? (h2h.source ? `✅${h2h.source}` : "")}`;
}

// ── 亚盘双源渲染(DK+titan007 并存;口径分歧以 titan007 即时盘为准并注明) ──
export function renderAsianDualCell(ah) {
  const t7 = ah?.titan007, dk = ah?.dk;
  const fmtT7 = (l, txt) => `${Number(l) > 0 ? `主让${l}` : Number(l) < 0 ? `主受让${Math.abs(l)}` : "平手"}(${txt ?? ""})`;
  const parts = [];
  if (t7?.live) {
    parts.push(`titan007即时 ${fmtT7(t7.live.line, t7.live.lineText)} 水主${t7.live.homeWater}/客${t7.live.awayWater}(初盘${fmtT7(t7.init?.line, t7.init?.lineText)}·${t7.companiesCount ?? "?"}家·主参${t7.primaryCompany?.name ?? "—"})✅titan007`);
  }
  if (dk?.line != null) {
    parts.push(`DK ${dk.line} 主${dk.homeOdds}/客${dk.awayOdds}${dk.openLine && dk.openLine !== dk.line ? `(开${dk.openLine}→异动)` : ""} ✅${dk.source ?? "ESPN/DraftKings"}`);
  }
  if (!parts.length) return "⚠️未取到(DK/titan007双源均缺)";
  let div = "";
  if (t7?.live && dk?.line != null) {
    const dkHomeGive = -parseFloat(dk.line); // DK 负=主让 → 转 titan007 口径(正=主让)
    if (Number.isFinite(dkHomeGive) && Math.abs(dkHomeGive - Number(t7.live.line)) > 1e-9) {
      div = `\n⚠️双源口径分歧(DK主让${dkHomeGive} vs titan007主让${t7.live.line})——以titan007即时盘为准(抓取${String(t7.fetchedAt ?? "").slice(0, 16) || "?"}Z)`;
    }
  }
  return parts.join(" ｜ ") + div;
}

// ── 欧赔外盘参考(竞彩未开售场;🔶仅方向参考,非可投注口径) ──
export function renderEuroRefCell(euroRef) {
  if (!euroRef?.value) return null;
  const v = euroRef.value;
  return `🔶外盘百家平均 ${v.home}/${v.draw}/${v.away}(titan007 ${euroRef.companies ?? "?"}家·竞彩未开售仅方向参考,非可投注口径)`;
}

// ── 三列同向自检(胜负平/比分/半全场;让球列按 2026-06-11 新口径放行真实裁决,不再纳入硬约束) ──
export function threeColumnCoherence(rows) {
  const dirWld = (s) => { if (/未开售/.test(String(s))) return null; const m = String(s).match(/(主胜|平局|客胜)/); return m ? m[1] : null; };
  const dirScore = (s) => { const m = String(s).match(/(\d+)\s*-\s*(\d+)/); if (!m) return null; const h = +m[1], a = +m[2]; return h > a ? "主胜" : h < a ? "客胜" : "平局"; };
  const dirHf = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? m[2] : null; };
  let checked = 0, skipped = 0; const violations = [];
  for (const r of rows) {
    const w = dirWld(r.wld), sc = dirScore(r.score), hf = dirHf(r.halffull);
    if (!w || !sc || !hf) { skipped++; continue; }
    checked++;
    if (w !== sc || w !== hf) violations.push(`${r.match}:胜负平=${w}/比分=${sc}/半全场=${hf}`);
  }
  return { checked, skipped, violations, ok: violations.length === 0 };
}

// ── ④ 数据审计工作表(场×维度矩阵 + 内容审计区) ──
// ── 四玩法独立真实裁决(2026-06-11 用户裁决,取代"四列同向"显示锁):
//    胜负平=模型综合;让球=模型vs市场过盘真实裁决(0610口径);比分/半全场=各自500盘口de-vig真实热门(✅市场)主推,
//    模型方向一致视图退居次行。方向可不同向但每个不同向必须带依据;绝不为"看起来独特"人造分歧——
//    盘口与胜负平真同向时如实标"同向共振"。内部真钱管线(validatePredictionConsistency 核 wldConsistent)零改动。 ──
const SCORE_DIR = (score) => { const m = String(score).match(/^(\d+)\s*-\s*(\d+)$/); if (!m) return null; const a = +m[1], b = +m[2]; return a > b ? "3" : a === b ? "1" : "0"; };
export const DIR_LABEL = { "3": "主胜", "1": "平局", "0": "客胜" };
const FT_DIR = (hf) => { const ft = String(hf ?? "").split("-")[1]?.trim(); return ft === "主胜" ? "3" : ft === "平局" ? "1" : ft === "客胜" ? "0" : null; };

export function marketScoreView(p) {
  const sp = p.scorePicks ?? {};
  const md = Array.isArray(sp.marketDistribution) && sp.marketDistribution.length ? sp.marketDistribution : null;
  const wld = p.pick?.code != null ? String(p.pick.code) : null;
  if (!md) return { fromMarket: false, dir: null, sameAsWld: null, cell: null, basis: "比分盘未开售/模板盘弃用→退模型DC矩阵🔶" };
  const top = md.slice(0, 3);
  const dir = SCORE_DIR(top[0].score);
  const sameAsWld = wld != null && dir != null ? dir === wld : null;
  const fmt = (d) => `${d.score}(${Math.round(d.probability * 100)}%)`;
  const cell = `盘口主推 ${top.map(fmt).join(" / ")} ✅500比分盘de-vig` +
    (sameAsWld === false ? ` ⚠️与胜负平不同向:比分盘真实热门=${DIR_LABEL[dir]}方向(比分玩法按盘口热门下,胜负平玩法按方向下,两问不同)` : sameAsWld ? " ·与胜负平同向共振" : "");
  return { fromMarket: true, dir, sameAsWld, cell, basis: "500比分盘de-vig真实众数", top };
}

export function marketHalfFullView(p) {
  const hp = p.halfFullPicks ?? {};
  const md = Array.isArray(hp.marketDistribution) && hp.marketDistribution.length ? hp.marketDistribution : null;
  const wld = p.pick?.code != null ? String(p.pick.code) : null;
  if (!md) return { fromMarket: false, dir: null, sameAsWld: null, cell: null, basis: "半全场盘未开售/模板盘弃用→退模型半场联合矩阵🔶" };
  const top = md.slice(0, 3);
  const dir = FT_DIR(top[0].halfFull);
  const sameAsWld = wld != null && dir != null ? dir === wld : null;
  const fmt = (d) => `${d.halfFull}(${Math.round(d.probability * 100)}%)`;
  const cell = `盘口主推 ${top.map(fmt).join(" / ")} ✅500半全场盘de-vig` +
    (sameAsWld === false ? ` ⚠️与胜负平不同向:半全场盘真实热门终场=${DIR_LABEL[dir] ?? "?"}(按盘口热门下,非方向复制)` : sameAsWld ? " ·与胜负平同向共振" : "");
  return { fromMarket: true, dir, sameAsWld, cell, basis: "500半全场盘de-vig真实众数", top };
}

// 信号面板:只用本次实抓证据拼装(欧赔初→现、亚盘开→现+水位、竞彩让球盘de-vig、大小球),阵容未出如实标⚠️。
//   共振/背离判定措辞诚实:欧赔答"谁赢"、亚盘/让球盘答"过不过盘",两问不同向≠矛盾,标"赢球与过盘分离"。
export function buildSignalPanel({ euroCur, euroIni, asian, hcDist, ouLine, lineupKnown = false }) {
  const parts = []; const dirs = {};
  if (euroCur && [euroCur.home, euroCur.draw, euroCur.away].every((x) => Number.isFinite(Number(x)))) {
    const cur = { "3": Number(euroCur.home), "1": Number(euroCur.draw), "0": Number(euroCur.away) };
    const fav = Object.entries(cur).sort((a, b) => a[1] - b[1])[0][0];
    dirs.euro = fav;
    let move = "";
    if (euroIni && Number.isFinite(Number(euroIni.home))) {
      const ini = { "3": Number(euroIni.home), "1": Number(euroIni.draw), "0": Number(euroIni.away) };
      const d = cur[fav] - ini[fav];
      move = Math.abs(d) >= 0.01 ? (d < 0 ? `·热门${DIR_LABEL[fav]}水位压入(${ini[fav]}→${cur[fav]},资金进)` : `·热门${DIR_LABEL[fav]}水位走高(${ini[fav]}→${cur[fav]},资金出)`) : "·初现持平";
    }
    parts.push(`欧赔:热门=${DIR_LABEL[fav]}${move}`);
  } else parts.push("欧赔:⚠️未开售");
  if (asian && asian.line != null) {
    const lean = Number(asian.homeOdds) < Number(asian.awayOdds) ? "主" : "客";
    const moved = asian.openLine != null && String(asian.openLine) !== String(asian.line);
    dirs.asianLean = lean === "主" ? "3" : "0";
    parts.push(`亚盘:让${asian.line}${moved ? `(开${asian.openLine}→现${asian.line}·盘口异动)` : "(开盘未动)"}·水位偏${lean}(主${asian.homeOdds}/客${asian.awayOdds})`);
  } else parts.push("亚盘:⚠️未取到");
  if (hcDist && hcDist.home != null) {
    const lean = hcDist.home > hcDist.away ? "3" : "0";
    dirs.hcLean = lean;
    parts.push(`竞彩让球盘:过盘资金偏${DIR_LABEL[lean] === "主胜" ? "主" : "客"}(主过盘${Math.round(hcDist.home * 100)}%/客过盘${Math.round(hcDist.away * 100)}%)`);
  } else parts.push("竞彩让球盘:⚠️缺");
  if (ouLine) parts.push(ouLine);
  let verdict = "";
  if (dirs.euro && dirs.hcLean) {
    if (dirs.euro === dirs.hcLean && (!dirs.asianLean || dirs.asianLean === dirs.euro)) {
      verdict = `🟣三盘共振${DIR_LABEL[dirs.euro]}(欧赔/亚盘/让球盘同侧)`;
    } else {
      // 精确点名分歧腿(不笼统):逐盘列方向,谁背离一眼可见
      const side = (d) => (d === "3" ? "主" : d === "0" ? "客" : "平");
      const segs = [`欧赔热门=${side(dirs.euro)}`];
      if (dirs.asianLean) segs.push(`亚盘水位偏${side(dirs.asianLean)}`);
      segs.push(`让球盘资金偏${side(dirs.hcLean)}`);
      verdict = `🟠盘口信号分歧:${segs.join(" / ")}——欧赔答"谁赢"、亚盘/让球盘答"过不过盘",分歧=赢球难赢盘信号,玩法间方向不同有据`;
    }
  }
  parts.push(lineupKnown ? "阵容:✅已出(已按首发重算)" : "阵容:⚠️未公布(开赛前~1h LineupWatch自动按首发重分析推送)");
  if (verdict) parts.push(verdict);
  return { text: parts.join(" ‖ "), dirs, verdict };
}

// 方向矩阵审计:四玩法方向逐场列出;任何与胜负平不同向的格必须带依据(basis),无依据=FAIL(拒交付)。
export function directionMatrixAudit(entries) {
  const lines = []; const errors = [];
  for (const e of entries) {
    const cells = [];
    for (const m of e.markets) {
      cells.push(`${m.name}=${m.dirLabel ?? "—"}${m.sameAsWld === false ? `(不同向·依据:${m.basis || "❌缺依据"})` : ""}`);
      if (m.sameAsWld === false && !m.basis) errors.push(`${e.match}:${m.name}与胜负平不同向但无依据`);
    }
    lines.push(`${e.match}:胜负平=${e.wldLabel ?? "—"} ｜ ${cells.join(" ｜ ")}`);
  }
  return { ok: errors.length === 0, lines, errors };
}

export const AUDIT_DIMENSIONS = ["欧赔", "让球", "比分", "半全场", "大小球", "亚盘DK", "亚盘titan007", "欧赔参考(外盘)", "近5", "H2H", "国际赛画像", "世界杯先验"];
export function auditCell(tag, value, src, t) {
  return `${tag} ${value}｜源:${src}｜抓取:${t ?? "时间未记录"}`;
}
export function buildAuditSheet({ date, rows, contentAudit }) {
  const header = ["#", "对阵", ...AUDIT_DIMENSIONS];
  const body = rows.map((r) => [String(r.idx), r.match, ...AUDIT_DIMENSIONS.map((d) => r.audit?.[d] ?? "⚠️缺(该维未登记)")]);
  const tail = [[""], ["—— 内容审计区(2026-06-11 口径) ——"], ...(contentAudit ?? []).map((x) => (Array.isArray(x) ? x : [x]))];
  return { name: "数据审计", rows: [[`🔍 数据审计 · ${date} · ${rows.length}场×${AUDIT_DIMENSIONS.length}维(每格=三标签+值+来源+抓取时间)`], header, ...body, ...tail] };
}

// ── 14场/任选9 闸裁决工作表(buildFourteenPlan 闸如实判定;不能出写明依据,绝不硬凑) ──
export function buildFourteenSheetRows({ date, fourteen, periodFacts = [] }) {
  const head = [`🎯 14场/任选9 · ${date} · 闸裁决`];
  if (!fourteen) return [head, ["闸裁决", "⚠️ 14场计划未构建(store 无本期胜负彩腿映射)"], ...periodFacts.map((x) => (Array.isArray(x) ? x : [x]))];
  if (!fourteen.available) {
    return [head,
      ["闸裁决", "⛔ 今日不发14场段(任选9 同闸不发)"],
      ["依据(buildFourteenPlan 闸原话)", fourteen.note ?? "—"],
      ...periodFacts.map((x) => (Array.isArray(x) ? x : [x])),
    ];
  }
  // ── 防冷裁决(2026-06-11 用户裁决:删掉"爆冷后果"废话,只答四件事——哪场最可能爆、冷向是主/平/客、
  //    重点防哪些、防不住就全包或弃[弃=不当胆/不进任选9;14场票内腿必须填则全包])。
  // 🔶推断:由引擎逐腿真实概率派生;冷向=主选之外概率最高方向(平局算冷,爆冷不只输赢)。
  const sels = (fourteen.selections ?? []).filter((s) => s.rawProbabilities && Number.isFinite(s.rawProbabilities.home));
  const CODE_LABEL = { "3": "主胜", "1": "平局", "0": "客胜" };
  const probOfCode = (s, c) => (c === "3" ? s.rawProbabilities.home : c === "1" ? s.rawProbabilities.draw : s.rawProbabilities.away);
  for (const s of sels) {
    const others = ["3", "1", "0"].filter((c) => c !== s.singleCode)
      .map((c) => ({ code: c, p: probOfCode(s, c) })).sort((a, b) => b.p - a.p);
    const [t1, t2] = others;
    // 冷向显示:第二威胁≥20%时并显(回答"冷是胜还是负还是平"——可能不止一个方向有戏)
    s._cold = {
      label: CODE_LABEL[t1.code], p: t1.p,
      text: t2.p >= 0.20 ? `${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%+${CODE_LABEL[t2.code]}${Math.round(t2.p * 100)}%` : `${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%`,
    };
    if (t1.p >= 0.27 && t2.p >= 0.22) s._guard = `🚨防不住→全包(任选9弃此腿,不当胆):双威胁 ${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%+${CODE_LABEL[t2.code]}${Math.round(t2.p * 100)}%`;
    else if (t1.p >= 0.27) s._guard = `🛡重点防:双选 ${s.single}/${CODE_LABEL[t1.code]}`;
    else if (t1.p >= 0.24) s._guard = `⚠️建议防:双选 ${s.single}/${CODE_LABEL[t1.code]}`;
    else s._guard = `可单选(冷向${CODE_LABEL[t1.code]}仅${Math.round(t1.p * 100)}%)`;
  }
  const header = ["腿", "对阵", "单选", "复选", "类型", "主/平/客%", "冷向", "防冷裁决", "信心", "理由"];
  const legs = (fourteen.selections ?? []).map((s) => [String(s.index), s.match, s.single, s.compound, s.type,
    `${s.probabilities?.home ?? ""}/${s.probabilities?.draw ?? ""}/${s.probabilities?.away ?? ""}`,
    s._cold ? s._cold.text : (s.upsetRisk ?? ""),
    s._guard ?? "—", String(s.confidence ?? ""), s.reason ?? ""]);
  const r9 = fourteen.renxuan9;
  const scenarioRows = [];
  if (sels.length >= 2) {
    const ranked = [...sels].sort((a, b) => b._cold.p - a._cold.p);
    const giveUp = ranked.filter((s) => s._guard.startsWith("🚨"));
    const mustGuard = ranked.filter((s) => s._guard.startsWith("🛡"));
    scenarioRows.push(
      [""],
      ["💣 防冷裁决汇总", "🔶由引擎逐腿真实概率派生;冷向=主选外概率最高方向(平局算冷,双威胁并显)"],
      ["最可能爆冷", ranked.slice(0, 3).map((s) => `第${s.index}腿 ${s.match}:冷=${s._cold.text}`).join(" ║ ")],
      ["重点防", mustGuard.length ? mustGuard.map((s) => `第${s.index}腿双选${s.single}/${s._cold.label}`).join(" ║ ") : "无(达重点防线的都已升级全包,见下行)"],
      ["防不住→全包/弃", giveUp.length ? giveUp.map((s) => `第${s.index}腿 ${s.match}(${s._guard.split(":")[1] ?? "双威胁"}→票内全包;任选9弃之,不当胆)`).join(" ║ ") : "无双威胁腿"],
    );
    if (r9?.ok && Array.isArray(r9.picks)) {
      const nineMatches = new Set(r9.picks.map((p) => p.match));
      const nineBad = ranked.filter((s) => nineMatches.has(s.match) && (s._guard.startsWith("🚨") || s._guard.startsWith("🛡")));
      if (nineBad.length) scenarioRows.push(["⚠️任选9换腿建议", nineBad.map((s) => `第${s.index}腿 ${s.match} 冷=${s._cold.text}——任选9无双选可防,建议换更稳腿`).join(" ║ ")]);
    }
  } else if (fourteen.selections?.length) {
    scenarioRows.push([""], ["💣 防冷裁决", "⚠️本期产物缺逐腿原始概率字段(旧版引擎生成),如实跳过——重跑生成即有"]);
  }
  const tail = [[""],
    ["闸裁决", "✅ 本期可发(恰14腿·比赛日含今日·停售未过)"],
    ...periodFacts.map((x) => (Array.isArray(x) ? x : [x])),
    ["单式串", fourteen.singleLine ?? ""],
    ["复式串", fourteen.compoundLine ?? ""],
    ["胆串(相关性修正)", fourteen.bankerParlay ? `独立估计${fourteen.bankerParlay.independentProbability ?? "—"} / 修正${fourteen.bankerParlay.adjustedProbability ?? "—"}` : "—"],
    ["任选9", r9?.ok ? `9场:${(r9.picks ?? []).map((p) => `${p.match ?? ""}${p.single ?? p.pick ?? ""}`).join(" ")}` : `不出(${r9?.reason ?? "—"})`],
    ...scenarioRows,
  ];
  return [head, header, ...legs, ...tail];
}

// ── 串关推荐工作表(2026-06-12 用户需求:最稳/均衡/高赔/爆冷分档,胜负平/让球/比分/总进球/半全场混合过关) ──
// plan = parlay-builder.buildParlayPlan 产物;赔率✅实测乘积、概率/EV 🔶推断(de-vig+独立性),规则与风险写进表头,绝不吹正EV。
const parlayPct = (x) => `${(x * 100).toFixed(x >= 0.095 ? 0 : 1)}%`;
export function buildParlaySheet({ date, plan, jqsFetchedAt, advBanner }) {
  const legsN = plan?.ok ? (plan.tiers[0]?.combos[0]?.legs.length ?? 2) : 2;
  const head = [`🔗 串关推荐(混合过关·全${legsN}串1·每注100元口径) · ${date}`];
  const rules = [
    ["规则", `竞彩混合过关:同一场只能选一个玩法的一个选项入同一注;今日在售场为${legsN}场→本表全部${legsN}串1。`],
    ["数据", `腿赔率=✅500真盘实测(胜负平/让球/比分/半全场=当日快照;总进球=本次实抓 trade.500.com pl_jqs${jqsFetchedAt ? `,抓取${jqsFetchedAt}` : ""});串赔率=各腿实测赔率乘积。`],
    ["口径", "金额列按每注100元假设:可中=串赔×100(含本金);净赚=可中-100,回报率=净赚/100;期望回收🔶=联合概率×可中(恒<100元,两重抽水叠乘)——串关数学期望必然劣于单注,本表只按要求给搭法标注,不构成下注建议。联合概率=🔶推断(各玩法全集比例法de-vig × 跨场独立性假设)。"],
    ...(advBanner ? [["风险", advBanner]] : []),
  ];
  if (!plan?.ok) return { name: "串关推荐", rows: [head, ...rules, [`⚠️ ${plan?.note ?? "串关计划未构建"}(如实不出,不硬凑)`]] };
  // 排版(2026-06-12 用户反馈"有点乱"):腿合并成一列"怎么买",一格照着抄;概率/模型概率合一列。
  const CIRCLED = "①②③④⑤⑥⑦⑧⑨";
  const howToBuy = (c) => c.legs.map((l, i) => `${CIRCLED[i] ?? `${i + 1}.`}【${l.match}】${l.market}→买「${l.sel}」@${l.odds}`).join("\n");
  const header = ["档位", `怎么买(一注${legsN}腿,全中才中)✅`, "串赔率✅", "100元:可中/净赚✅", "中的概率🔶", "100元期望回收🔶", "说明"];
  const body = [];
  for (const t of plan.tiers) {
    for (const c of t.combos) {
      const win = Math.round(c.odds * 100), net = win - 100, exp = Math.round(c.probMkt * win);
      body.push([t.tier, howToBuy(c), `${c.odds}`,
        `可中${win}元(净赚+${net}元·回报率+${net}%)`,
        `${parlayPct(c.probMkt)}${c.probModel != null ? `(模型${parlayPct(c.probModel)})` : ""}`,
        `${exp}元(亏${100 - exp})`, c.why]);
    }
  }
  const tail = [[""]];
  if (plan.modelBest) {
    tail.push(["模型分歧参考(🔶)", `模型口径EV最高搭法:${plan.modelBest.legs.map((l) => `${l.match} ${l.label}`).join(" × ")} 串赔${plan.modelBest.odds}·模型联合概率${parlayPct(plan.modelBest.probModel)}·模型EV=${plan.modelBest.evModel}${plan.modelBest.evModel < 0 ? "(仍为负:模型本质市场跟随器,无独立edge,与当日对抗证伪结论一致)" : "(⚠️正EV仅为模型自评,当日三视角证伪未背书,勿当真edge)"}`]);
  }
  return { name: "串关推荐", rows: [head, ...rules, header, ...body, ...tail] };
}

// 手机页/英文页串关区(三处同源同口径;plan 缺/不可串 → 如实一句话,不留空白假象)
export function renderParlayHtmlSection(plan, { compact = false } = {}) {
  const esc2 = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (!plan) return "";
  if (!plan.ok) return `<div class="note">🔗 串关推荐:⚠️ ${esc2(plan.note ?? "未构建")}(如实不出)</div>`;
  const legsN = plan.tiers[0]?.combos[0]?.legs.length ?? 2;
  const CIRC = "①②③④⑤⑥⑦⑧⑨";
  const rows = plan.tiers.flatMap((t) => t.combos.map((c) =>
    `<tr><td>${esc2(t.tier)}</td><td>${c.legs.map((l, i) => `${CIRC[i] ?? i + 1}${esc2(l.match)}<br>买「<b>${esc2(l.sel)}</b>」@${l.odds}<span style="color:#9aa6b4">【${esc2(l.market)}·${Math.round(l.probMkt * 100)}%】</span>`).join("<hr style='border:none;border-top:1px dashed #ddd;margin:3px 0'>")}</td><td><b>${c.odds}</b></td><td><b>${Math.round(c.odds * 100)}元</b><br><span style="color:#9aa6b4">净+${Math.round(c.odds * 100) - 100}</span></td><td>${esc2(parlayPct(c.probMkt))}${c.probModel != null ? `<br><span style="color:#9aa6b4">模型${esc2(parlayPct(c.probModel))}</span>` : ""}</td></tr>`)).join("");
  return `<h2 style="font-size:15px;margin:16px 4px 6px;color:#4A148C">🔗 串关推荐(混合过关·全${legsN}串1·每注100元)</h2>
<div class="note" style="font-size:11.5px">同场只能选一个玩法入串(竞彩规则)。串赔=✅500实测乘积;可中=串赔×100元含本金;概率=🔶de-vig×独立假设;串关EV恒负(双重抽水),数学期望劣于单注——只给搭法,买不买你定。${compact ? "" : "完整期望回收/说明列见 xlsx「串关推荐」表。"}</div>
<table${compact ? ` class="core" style="font-size:12px"` : ""}><tr><th>档位</th><th>搭法(${legsN}串1)</th><th>串赔✅</th><th>100元可中✅</th><th>联合概率🔶</th></tr>${rows}</table>`;
}

// ── 手机页头条覆盖副标题(2026-06-10 审计确认缺陷:头条硬编码"5赔种全覆盖"假全覆盖声明,与 xlsx 真计数 banner 口径不一) ──
// counts 必须来自 buildOddsFillCounts 真计数;缺/非法直接 throw(fail-loud,绝不默认自吹全覆盖)。
// 任一赔种(欧赔/让球/比分/半全场/大小球)有缺口 → 禁出"全覆盖"字样,改逐赔种实数(与 xlsx banner 缺陷#8 同口径)。
export function buildCoverageSubtitle(counts) {
  if (!counts || !Number.isFinite(counts.total) || counts.total <= 0) {
    throw new Error("buildCoverageSubtitle:counts 缺失/非法(必须传 buildOddsFillCounts 真计数),拒绝输出覆盖声明。");
  }
  const n = counts.total;
  const kinds = [["欧赔", counts.euro], ["让球", counts.handicap], ["比分", counts.score], ["半全场", counts.halffull], ["大小球", counts.ou]];
  if (kinds.every(([, c]) => c === n)) return `5赔种全覆盖(${n}/${n}真计数核验)`;
  return kinds.map(([k, c]) => `${k}${c}/${n}`).join("·");
}

// ── 审计背书(缺陷#17:绝不硬编码历史日期的审计声明;adversarial/<date>.json 缺 → 不写背书句) ──
// advData = adversarial/<date>.json 的 verdicts(或 null);rows 用于派生真实让球线清单。
export function buildAuditFoot({ rows, advData }) {
  const parts = [];
  const lines = rows
    .map((r) => {
      const line = r.hcP?.line;
      if (!line) return null;
      const home = String(r.match ?? "").split(" vs ")[0];
      return `${home}${String(line).replace(/^让/, "")}`;
    })
    .filter(Boolean);
  if (lines.length) parts.push(`让球线=500实时核实(${lines.join("/")})`);
  if (advData && Object.keys(advData).length) {
    const audited = rows.filter((r) => r.adv).length;
    parts.push(`三视角对抗证伪已审计${audited}/${rows.length}场(🔴=证伪·只标注不弃赛,展开看致命点)`);
  } else {
    // 缺当日审计文件:不写任何"已审计"背书(绝不凭空捏造审计声明),只如实标未跑。
    parts.push("⚠️对抗证伪未跑(football-signal-verify 当日未出,证伪列标缺)");
  }
  return parts.join("。") + "。";
}

// ── 对抗证伪单元格(无当日审计文件 → 如实标⚠️未跑,绝不编造结论) ──
export function advCellText(r, advDataPresent) {
  if (r.adv) return `${r.adv.label}${r.adv.ev != null ? ` EV=${r.adv.ev}` : ""} ｜ ${r.adv.kill}`;
  return advDataPresent ? "—(该场未审计)" : "⚠️未跑(football-signal-verify 当日未出审计文件)";
}

// ── xlsx 25列(2026-06-11 升级:20列专业版 + 世界杯模型先验列组3列 + 让球真实裁决列 + 串关安全度列;
//    列头注明模型归属——"足球大模型"模型列 vs "市场锚"赔率列 vs "世界杯模型"先验列,两模型贡献一眼分清) ──
export const XLSX_HEADERS = ["#", "开赛", "对阵(赛事)",
  "胜负平🔶(足球大模型)", "胜平负赔率✅(市场锚)",
  "🌍世界杯模型·Elo先验三概率(洲际校正)", "🌍世界杯模型·场馆λ乘子", "🏆世界杯模型·出线/夺冠%",
  "让球方向🔶(模型真实裁决·可与胜平负不同向)",
  "竞彩让球(模型过盘vs市场)", "竞彩让球赔率✅", "博彩亚盘✅(DK+titan007双源)",
  "信号面板✅(欧赔异动·亚盘水位·让球盘资金·共振/背离·阵容)",
  "比分(盘口✅真实热门主推+模型🔶次行)", "比分赔率✅", "半全场(盘口✅真实热门主推+模型🔶次行)", "半全场赔率✅", "大小球✅", "进球分布✅",
  "主队近5✅", "客队近5✅", "H2H(本地49k历史库)", "攻防画像", "信心档", "💰建议注金🔶(基础100元分层)", "串关安全度", "🔴对抗证伪(三视角·只标注不弃赛)"];

export function buildXlsxSheets({ date, rows, banner, advDataPresent, recordLine = null, stakeNote = null }) {
  // 对阵列附加行:每场情景研判(🏆赛会 出线/夺冠% 已移到专属"世界杯模型"列,不再塞对阵格)
  const matchCell = (r) => `${r.match}(${r.comp})${r.scen ? `\n情景:${r.scen}` : ""}`;
  const xrows = rows.map((r) => [String(r.idx), r.ko, matchCell(r),
    r.wld, r.euro,
    r.wcElo ?? "—", r.wcLambda ?? "—", r.wcTourney ?? (r.wcLine || "—"),
    r.hv?.text ?? "⚠️让球真实裁决缺",
    r.hcView, r.hc, r.asian, r.signals ?? "⚠️未拼装", `${r.score}〔${r.scoreSrc}〕`, r.scoreMkt, `${r.halffull}〔${r.hfSrc}〕`, r.hfMkt, r.ouReal, r.dist,
    `${r.homeRec} ${r.homeLast5}`, `${r.awayRec} ${r.awayLast5}`, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`,
    r.stake?.text ?? "—(档位缺不给金额)",
    r.parlay?.text ?? "⚠️未评", advCellText(r, advDataPresent)]);
  // 战绩行/注金口径行紧跟 banner(2026-06-12 用户裁决:战绩透明化进表头;缺=不出该行,不留空假象)
  const headRows = [[`⚡ 神选 · 竞彩完整覆盖 · ${date}`], [banner],
    ...(recordLine ? [[recordLine]] : []), ...(stakeNote ? [[stakeNote]] : [])];
  return [{ name: "竞彩完整", rows: [...headRows, XLSX_HEADERS, ...xrows] }];
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tierColor = (t) => /一档|二档/.test(t) ? "#2e7d32" : /三档/.test(t) ? "#f9a825" : /硬币/.test(t) ? "#6b7280" : "#ea580c";
const wldS = (s) => { if (/未开售/.test(s)) return "未开售"; const m = String(s).match(/(主胜|平局|客胜)\((\d+)%\)/); return m ? `${m[1][0]}${m[2]}%` : "—"; };
const scoreS = (s) => { const m = String(s).match(/(\d+)-(\d+)/); return m ? m[0] : "—"; };
const hfS = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? `${m[1][0]}-${m[2][0]}` : "—"; };
const ouS = (s) => { const m = String(s).match(/大(\d+)%/); return m ? `大${m[1]}` : "—"; };

// ── 手机页(核心7列 + 点行展开全部;2026-06-09 用户选定专业版,绝不简化) ──
export function renderMobileHtml({ date, rows, riskNote, intlN, wcN, auditFoot, counts, degradeNote, parlayPlan = null, recordLine = null, stakeSum = null }) {
  // 头条副标题=逐赔种真计数(buildCoverageSubtitle 内部 fail-loud:counts 缺/非法直接 throw,绝不默认自吹"全覆盖")。
  const coverageSub = buildCoverageSubtitle(counts);
  // 降级句(buildDegradeNote 产物)进手机页头条 risk 块——与 xlsx banner 同口径,头条不再只有平局/硬币档提示。
  const riskBody = [degradeNote, riskNote || "模型只给信心+风险参考,买不买你定。"].filter(Boolean).map((s) => esc(s)).join("<br>");
  const br = (s) => esc(s).replace(/\n/g, "<br>");
  const detail = (r) => (r.wcLine ? `<div class="drow"><b>🏆赛会</b>${esc(r.wcLine)}</div>` : "") +
    (r.wcElo && r.wcElo !== "—" ? `<div class="drow"><b>🌍世界杯模型</b>Elo先验 ${esc(r.wcElo)}<br><span class="ind">场馆λ ${esc(r.wcLambda ?? "—")}</span></div>` : "") +
    (r.scen ? `<div class="drow"><b>情景</b>${esc(r.scen)}</div>` : "") +
    `<div class="drow"><b>胜负平</b>${esc(r.wld)}<span class="g"> · 欧赔 ${esc(r.euro)}</span></div>` +
    (r.hv ? `<div class="drow"><b>让球真实裁决</b>${br(r.hv.text)}</div>` : "") +
    `<div class="drow"><b>让球${esc(r.hcP.line)}</b>模型 ${esc(r.hcP.model)}<br><span class="ind">市场 ${esc(r.hcP.market)}${r.hcP.diverge ? ` <span class="w2">⚠️以市场为准</span>` : ""}</span></div>` +
    `<div class="drow"><b>让球赔率</b>${esc(r.hc)}<br><b>博彩亚盘</b>${esc(r.asian)}</div>` +
    (r.signals ? `<div class="drow"><b>信号面板</b>${br(r.signals)}</div>` : "") +
    `<div class="drow"><b>比分</b>${br(r.score)}<span class="g"> · 赔率 ${esc(r.scoreMkt)}</span></div>` +
    `<div class="drow"><b>半全场</b>${br(r.halffull)}<span class="g"> · 赔率 ${esc(r.hfMkt)}</span></div>` +
    `<div class="drow"><b>大小球</b>${esc(r.ouReal)}<span class="g"> · 进球分布 ${esc(r.dist)}</span></div>` +
    `<div class="drow"><b>近5</b>${esc(r.homeRec)} <span class="g">${esc(r.homeLast5)}</span><br><span class="ind">${esc(r.awayRec)} <span class="g">${esc(r.awayLast5)}</span></span></div>` +
    `<div class="drow"><b>H2H</b>${esc(r.h2h)}</div>` +
    `<div class="drow"><b>攻防</b>${esc(r.profile)}</div>` +
    (r.stake ? `<div class="drow"><b>💰建议注金🔶</b>${esc(r.stake.text)}<span class="g">(分层口径建议,买不买你定)</span></div>` : "") +
    (r.parlay ? `<div class="drow"><b>串关</b>${esc(r.parlay.text)}</div>` : "") +
    (r.adv ? `<div class="adv"><b>${esc(r.adv.label)}${r.adv.ev != null ? ` · EV=${r.adv.ev}` : ""}</b><br>${esc(r.adv.kill)}<br><span class="g">三视角对抗证伪·只标注不弃赛,下不下你定</span></div>` : "");
  const trs = rows.map((r) => `<tr class="r" onclick="tg(this)"><td class="m">${esc(r.match)}${r.adv && /证伪/.test(r.adv.label) ? ' <span class="kx">🔴</span>' : ""} <span class="ar">▾</span><i>${esc(r.ko)} · ${esc(r.comp)}</i></td><td><span class="b" style="background:${tierColor(r.tier)}">${Math.round(r.conf)}</span>${r.stake ? `<span class="stk">💰${r.stake.stake}</span>` : ""}</td><td>${esc(wldS(r.wld))}</td><td>${esc(r.hcP.line)}</td><td>${esc(scoreS(r.score))}</td><td>${esc(hfS(r.halffull))}</td><td>${esc(ouS(r.ouReal))}</td></tr><tr class="d"><td colspan="7">${detail(r)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>神选·竞彩·${date}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",system-ui,sans-serif;margin:0;background:#eef1f5;color:#1c2530;-webkit-text-size-adjust:100%}.wrap{max-width:720px;margin:0 auto;padding:14px 10px 40px}
.top{background:linear-gradient(135deg,#4A148C,#7b1fa2);color:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(74,20,140,.28)}.top h1{font-size:18px;margin:0 0 3px;font-weight:700}.top .sub{font-size:12px;opacity:.88}.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.legend span{font-size:11px;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
.risk{background:#fff;border-left:4px solid #d32f2f;border-radius:10px;padding:10px 13px;margin-bottom:12px;font-size:12.5px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06)}
.rec{background:#fff;border-left:4px solid #2e7d32;border-radius:10px;padding:9px 13px;margin-bottom:12px;font-size:12px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06);color:#2a3340}
.stk{display:block;margin-top:3px;font-size:10.5px;color:#7b1fa2;font-weight:700}
.hint{font-size:11.5px;color:#8a93a0;margin:0 4px 8px}
table.core{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(20,30,50,.08);font-size:13px}
table.core th{background:#4A148C;color:#fff;padding:10px 4px;font-weight:600;font-size:11.5px;text-align:center}table.core th:first-child{text-align:left;padding-left:12px}
.core .r{cursor:pointer;border-top:1px solid #eef0f3}.core .r td{padding:11px 4px;text-align:center;color:#1c2530;font-weight:600}
.core .r td.m{text-align:left;padding-left:12px;color:#2a1a4a}.core .r td.m i{display:block;font-style:normal;font-weight:400;color:#9097a3;font-size:10.5px;margin-top:2px}.core .r td.m .ar{color:#9333ea;font-size:11px}
.b{display:inline-block;min-width:26px;color:#fff;font-weight:700;font-size:12px;padding:3px 8px;border-radius:12px}
.core .d{display:none}.core .d.open{display:table-row}.core .d>td{padding:8px 13px 12px;background:#faf9fc}
.drow{padding:6px 0;font-size:12px;line-height:1.6;border-top:1px solid #efeaf6;color:#37404d}.drow:first-child{border-top:none}.drow b{color:#7e22ce;font-weight:700;margin-right:6px}.drow .g{color:#9aa6b4}.drow .ind{display:inline-block;margin-top:2px}.drow .w2{color:#d97706;font-weight:600}
.adv{margin-top:8px;background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #d32f2f;border-radius:8px;padding:8px 11px;font-size:11.5px;line-height:1.55;color:#7f1d1d}.adv b{color:#b91c1c;font-weight:700}.adv .g{color:#b08}.kx{display:inline-block;font-size:10px;background:#fde8e8;color:#b91c1c;border:1px solid #f5b5b5;border-radius:8px;padding:1px 6px;font-weight:700;vertical-align:middle}
.dl{display:block;text-align:center;margin:18px 2px 6px;padding:14px;background:#4A148C;color:#fff;border-radius:13px;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(74,20,140,.28)}
.foot{color:#9aa3af;font-size:11px;margin:12px 6px 0;line-height:1.55}</style></head><body><div class="wrap">
<div class="top"><h1>⚡ 神选 · 竞彩推荐</h1><div class="sub">${date} · ${rows.length}场${intlN ? ` 国际赛${intlN}` : ""}${wcN ? ` 世界杯${wcN}` : ""} · ${esc(coverageSub)}</div><div class="legend"><span>✅ 实测真盘</span><span>🔶 模型推断</span><span>⚠️ 缺口标缺不编</span></div></div>
${recordLine ? `<div class="rec">${esc(recordLine)}</div>` : ""}
<div class="risk">${riskBody}</div>
${stakeSum ? `<div class="rec" style="border-left-color:#7b1fa2">${esc(stakeSum)}</div>` : ""}
<div class="hint">👇 点任意一行 = 展开该场全部赔率/近5/H2H/攻防/建议注金</div>
<table class="core"><thead><tr><th>对阵 ▾</th><th>信心/注金</th><th>胜负平</th><th>让球</th><th>比分</th><th>半全</th><th>大小</th></tr></thead><tbody>${trs}</tbody></table>
${renderParlayHtmlSection(parlayPlan, { compact: true })}
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(20列全字段·含对抗证伪)</a>
<div class="foot">真实端到端(${date})。5赔种=500竞彩XML(欧赔/让球/比分/半全场/总进球de-vig),亚盘+未开售场欧赔=ESPN/DraftKings,近5/H2H=ESPN。让球过盘=模型与市场两套数·分歧大以市场为准。缺口(国家队真xG/老H2H)诚实标。${esc(auditFoot)}</div>
<script>function tg(r){r.nextElementSibling.classList.toggle('open');var a=r.querySelector('.ar');if(a)a.textContent=r.nextElementSibling.classList.contains('open')?'▴':'▾';}</script>
</div></body></html>`;
}

// ── 手机页/英文页固定文件名防回退守护(2026-06-10 并行交付保护):──
//   webshare 固定文件名(今日足球推荐.html / football.html)若已被更新日期的交付占用(如并行会话已出明日表),
//   重出旧日期绝不顶掉新页 —— 改写日期命名副本(足球推荐-<date>.html / football-<date>.html)。
//   纯函数:只比对现页日期与本次交付日期,返回应写路径;现页缺/无日期/同日期/更旧 → 照常写固定文件名。
export function resolveHtmlWriteTarget({ existingHtml, date, canonicalPath, datedPath, dateRe }) {
  const cur = String(existingHtml ?? "").match(dateRe)?.[1] ?? null;
  if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur) && cur > date) {
    return { path: datedPath, preservedNewer: cur };
  }
  return { path: canonicalPath, preservedNewer: null };
}

// ── 英文固定URL页 football.html(手机收藏夹固定地址;缺陷#16:跟随当日,与 xlsx/手机页同源同日期) ──
export function renderEnglishHtml({ date, rows, riskNote, intlN, wcN, banner, auditFoot, parlayPlan = null, recordLine = null, stakeSum = null }) {
  const br = (s) => esc(s).replace(/\n/g, "<br>");
  const trs = rows.map((r) => `<tr><td>${esc(r.ko)}</td><td><b>${esc(r.match)}</b><br><span style="color:#7e57c2;font-size:11px">${esc(r.comp)}</span>${r.wcLine ? `<br><span style="font-size:11px">🏆 ${esc(r.wcLine)}</span>` : ""}${r.wcElo && r.wcElo !== "—" ? `<br><span style="color:#6a1b9a;font-size:11px">🌍世界杯模型 ${esc(r.wcElo)}·λ${esc(r.wcLambda ?? "—")}</span>` : ""}${r.scen ? `<br><span style="color:#888;font-size:11px">情景:${esc(r.scen)}</span>` : ""}</td><td>${esc(r.wld)}</td><td>${r.hv ? br(r.hv.text) : "—"}</td><td>${esc(r.hcView)}</td><td>${esc(r.score)}〔${esc(r.scoreSrc)}〕</td><td>${esc(r.halffull)}〔${esc(r.hfSrc)}〕</td><td>${esc(r.ouReal)}</td><td>${esc(r.tier)}<br>${Math.round(r.conf)}</td><td>${esc(r.stake?.text ?? "—")}</td><td>${esc(r.parlay?.text ?? "—")}</td></tr>`).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡神选·足球·${date}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1a1a1a}
.wrap{max-width:960px;margin:0 auto;padding:12px}
h1{font-size:19px;margin:14px 4px}h2{font-size:16px;margin:18px 4px 8px;color:#4A148C}
.note{background:#fff8e1;border-left:4px solid #ffb300;padding:8px 10px;margin:8px 4px;font-size:13px;border-radius:4px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:12.5px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th{background:#4A148C;color:#fff;padding:8px 6px;text-align:left;font-weight:600}
td{padding:7px 6px;border-top:1px solid #eee;vertical-align:top}
tr:nth-child(even) td{background:#faf8fd}
.dl{display:inline-block;margin:14px 4px;padding:10px 18px;background:#4A148C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}
.foot{color:#888;font-size:11px;margin:16px 4px 30px}
</style></head><body><div class="wrap">
<h1>⚡ 神选 · 足球推荐 · ${date}</h1>
<div class="note" style="border-color:#d32f2f;background:#ffebee">${esc(banner)}</div>
${recordLine ? `<div class="note" style="border-color:#2e7d32;background:#f1f8e9">${esc(recordLine)}</div>` : ""}
${riskNote ? `<div class="note">${esc(riskNote)}</div>` : ""}
${stakeSum ? `<div class="note" style="border-color:#7b1fa2;background:#f3e5f5">${esc(stakeSum)}</div>` : ""}
<h2>竞彩 · ${rows.length} 场(${intlN}国际赛 + ${wcN}世界杯单场)</h2>
<table><tr><th>开赛</th><th>对阵</th><th>胜负平</th><th>让球真实裁决</th><th>让球(模型vs市场)</th><th>比分</th><th>半全场</th><th>大小球</th><th>信心</th><th>💰注金🔶</th><th>串关</th></tr>${trs}</table>
${renderParlayHtmlSection(parlayPlan)}
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(20列·含对抗证伪)</a>
<div class="foot">本页与 手机页/桌面 xlsx 同一渲染出口(today-full-coverage)生成 · 真实端到端(${date})。${esc(auditFoot)}模型只给信心+风险,买不买由你决定。</div>
</div></body></html>`;
}
