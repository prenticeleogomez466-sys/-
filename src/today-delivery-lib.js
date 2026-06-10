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
  return `欧赔${counts.euro}/${n}·让球${counts.handicap}/${n}·比分${counts.score}/${n}·半全场${counts.halffull}/${n}·大小球${counts.ou}/${n}(500竞彩真盘实数)+亚盘${counts.asian}/${n}(ESPN/DraftKings)`;
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

// ── xlsx 20列(专业版固定标准:末列🔴对抗证伪;深紫表头/banner跨列/行高/冻结由 xlsx-writer 实现) ──
export const XLSX_HEADERS = ["#", "开赛", "对阵(赛事)", "胜负平🔶", "胜平负赔率✅", "竞彩让球(模型过盘vs市场)", "竞彩让球赔率✅", "博彩亚盘✅", "比分🔶", "比分赔率✅", "半全场🔶", "半全场赔率✅", "大小球✅", "进球分布✅", "主队近5✅", "客队近5✅", "H2H", "攻防画像", "信心档", "🔴对抗证伪(三视角·只标注不弃赛)"];

export function buildXlsxSheets({ date, rows, banner, advDataPresent }) {
  // 对阵列附加行(2026-06-10 自检②⑥回补,不加列保20列):世界杯场🏆赛会(出线/夺冠%)+ 每场情景研判
  const matchCell = (r) => `${r.match}(${r.comp})${r.wcLine ? `\n🏆赛会 ${r.wcLine}` : ""}${r.scen ? `\n情景:${r.scen}` : ""}`;
  const xrows = rows.map((r) => [String(r.idx), r.ko, matchCell(r),
    r.wld, r.euro, r.hcView, r.hc, r.asian, `${r.score}〔${r.scoreSrc}〕`, r.scoreMkt, `${r.halffull}〔${r.hfSrc}〕`, r.hfMkt, r.ouReal, r.dist,
    `${r.homeRec} ${r.homeLast5}`, `${r.awayRec} ${r.awayLast5}`, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`, advCellText(r, advDataPresent)]);
  return [{ name: "竞彩完整", rows: [[`⚡ 神选 · 竞彩完整覆盖 · ${date}`], [banner], XLSX_HEADERS, ...xrows] }];
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tierColor = (t) => /一档|二档/.test(t) ? "#2e7d32" : /三档/.test(t) ? "#f9a825" : /硬币/.test(t) ? "#6b7280" : "#ea580c";
const wldS = (s) => { if (/未开售/.test(s)) return "未开售"; const m = String(s).match(/(主胜|平局|客胜)\((\d+)%\)/); return m ? `${m[1][0]}${m[2]}%` : "—"; };
const scoreS = (s) => { const m = String(s).match(/(\d+)-(\d+)/); return m ? m[0] : "—"; };
const hfS = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? `${m[1][0]}-${m[2][0]}` : "—"; };
const ouS = (s) => { const m = String(s).match(/大(\d+)%/); return m ? `大${m[1]}` : "—"; };

// ── 手机页(核心7列 + 点行展开全部;2026-06-09 用户选定专业版,绝不简化) ──
export function renderMobileHtml({ date, rows, riskNote, intlN, wcN, auditFoot, counts, degradeNote }) {
  // 头条副标题=逐赔种真计数(buildCoverageSubtitle 内部 fail-loud:counts 缺/非法直接 throw,绝不默认自吹"全覆盖")。
  const coverageSub = buildCoverageSubtitle(counts);
  // 降级句(buildDegradeNote 产物)进手机页头条 risk 块——与 xlsx banner 同口径,头条不再只有平局/硬币档提示。
  const riskBody = [degradeNote, riskNote || "模型只给信心+风险参考,买不买你定。"].filter(Boolean).map((s) => esc(s)).join("<br>");
  const detail = (r) => (r.wcLine ? `<div class="drow"><b>🏆赛会</b>${esc(r.wcLine)}</div>` : "") +
    (r.scen ? `<div class="drow"><b>情景</b>${esc(r.scen)}</div>` : "") +
    `<div class="drow"><b>胜负平</b>${esc(r.wld)}<span class="g"> · 欧赔 ${esc(r.euro)}</span></div>` +
    `<div class="drow"><b>让球${esc(r.hcP.line)}</b>模型 ${esc(r.hcP.model)}<br><span class="ind">市场 ${esc(r.hcP.market)}${r.hcP.diverge ? ` <span class="w2">⚠️以市场为准</span>` : ""}</span></div>` +
    `<div class="drow"><b>让球赔率</b>${esc(r.hc)}<br><b>博彩亚盘</b>${esc(r.asian)}</div>` +
    `<div class="drow"><b>比分</b>${esc(r.score)}<span class="g"> · 赔率 ${esc(r.scoreMkt)}</span></div>` +
    `<div class="drow"><b>半全场</b>${esc(r.halffull)}<span class="g"> · 赔率 ${esc(r.hfMkt)}</span></div>` +
    `<div class="drow"><b>大小球</b>${esc(r.ouReal)}<span class="g"> · 进球分布 ${esc(r.dist)}</span></div>` +
    `<div class="drow"><b>近5</b>${esc(r.homeRec)} <span class="g">${esc(r.homeLast5)}</span><br><span class="ind">${esc(r.awayRec)} <span class="g">${esc(r.awayLast5)}</span></span></div>` +
    `<div class="drow"><b>H2H</b>${esc(r.h2h)}</div>` +
    `<div class="drow"><b>攻防</b>${esc(r.profile)}</div>` +
    (r.adv ? `<div class="adv"><b>${esc(r.adv.label)}${r.adv.ev != null ? ` · EV=${r.adv.ev}` : ""}</b><br>${esc(r.adv.kill)}<br><span class="g">三视角对抗证伪·只标注不弃赛,下不下你定</span></div>` : "");
  const trs = rows.map((r) => `<tr class="r" onclick="tg(this)"><td class="m">${esc(r.match)}${r.adv && /证伪/.test(r.adv.label) ? ' <span class="kx">🔴</span>' : ""} <span class="ar">▾</span><i>${esc(r.ko)} · ${esc(r.comp)}</i></td><td><span class="b" style="background:${tierColor(r.tier)}">${Math.round(r.conf)}</span></td><td>${esc(wldS(r.wld))}</td><td>${esc(r.hcP.line)}</td><td>${esc(scoreS(r.score))}</td><td>${esc(hfS(r.halffull))}</td><td>${esc(ouS(r.ouReal))}</td></tr><tr class="d"><td colspan="7">${detail(r)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>神选·竞彩·${date}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",system-ui,sans-serif;margin:0;background:#eef1f5;color:#1c2530;-webkit-text-size-adjust:100%}.wrap{max-width:720px;margin:0 auto;padding:14px 10px 40px}
.top{background:linear-gradient(135deg,#4A148C,#7b1fa2);color:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(74,20,140,.28)}.top h1{font-size:18px;margin:0 0 3px;font-weight:700}.top .sub{font-size:12px;opacity:.88}.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.legend span{font-size:11px;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
.risk{background:#fff;border-left:4px solid #d32f2f;border-radius:10px;padding:10px 13px;margin-bottom:12px;font-size:12.5px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06)}
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
<div class="risk">${riskBody}</div>
<div class="hint">👇 点任意一行 = 展开该场全部赔率/近5/H2H/攻防</div>
<table class="core"><thead><tr><th>对阵 ▾</th><th>信心</th><th>胜负平</th><th>让球</th><th>比分</th><th>半全</th><th>大小</th></tr></thead><tbody>${trs}</tbody></table>
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
export function renderEnglishHtml({ date, rows, riskNote, intlN, wcN, banner, auditFoot }) {
  const trs = rows.map((r) => `<tr><td>${esc(r.ko)}</td><td><b>${esc(r.match)}</b><br><span style="color:#7e57c2;font-size:11px">${esc(r.comp)}</span>${r.wcLine ? `<br><span style="font-size:11px">🏆 ${esc(r.wcLine)}</span>` : ""}${r.scen ? `<br><span style="color:#888;font-size:11px">情景:${esc(r.scen)}</span>` : ""}</td><td>${esc(r.wld)}</td><td>${esc(r.hcView)}</td><td>${esc(r.score)}〔${esc(r.scoreSrc)}〕</td><td>${esc(r.halffull)}〔${esc(r.hfSrc)}〕</td><td>${esc(r.ouReal)}</td><td>${esc(r.tier)}<br>${Math.round(r.conf)}</td></tr>`).join("");
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
${riskNote ? `<div class="note">${esc(riskNote)}</div>` : ""}
<h2>竞彩 · ${rows.length} 场(${intlN}国际赛 + ${wcN}世界杯单场)</h2>
<table><tr><th>开赛</th><th>对阵</th><th>胜负平</th><th>让球(模型vs市场)</th><th>比分</th><th>半全场</th><th>大小球</th><th>信心</th></tr>${trs}</table>
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(20列·含对抗证伪)</a>
<div class="foot">本页与 手机页/桌面 xlsx 同一渲染出口(today-full-coverage)生成 · 真实端到端(${date})。${esc(auditFoot)}模型只给信心+风险,买不买由你决定。</div>
</div></body></html>`;
}
