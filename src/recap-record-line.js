// 模型战绩行(2026-06-12 用户裁决:每天表头透明化战绩,让用户知道该信几分)。
// 只读 recommendation-ledger 已结算行(hit!=null 且 actualScore 为真实比分),绝不在此重结算、绝不编;
// 让球命中由 actualScore+handicapLine 派生(与结算同口径纯算术);半全场需半场真值(ledger 无)→诚实不算,指到复盘总表。
const SCORE_RE = /^(\d+)-(\d+)$/;
const WLD_CODE = { 主胜: "3", 平局: "1", 客胜: "0" };

function handicapHit(r) {
  if (r.handicapLine == null || r.handicapLine === "") return null; // 线缺≠平手盘(Number(null)=0 陷阱)
  const line = Number(r.handicapLine);
  const m = String(r.actualScore ?? "").match(SCORE_RE);
  if (!Number.isFinite(line) || !m || !r.handicapWldCode) return null; // 不可判=不计入分母(诚实)
  const adj = Number(m[1]) + line - Number(m[2]);
  const code = adj > 0 ? "3" : adj === 0 ? "1" : "0";
  return code === String(r.handicapWldCode);
}

function tally(rows) {
  const frac = (h, n) => (n ? `${h}/${n}` : "—");
  const wldN = rows.length, wldH = rows.filter((r) => r.hit === true).length;
  const hc = rows.map(handicapHit).filter((x) => x !== null);
  const hcH = hc.filter(Boolean).length;
  const scN = rows.filter((r) => SCORE_RE.test(String(r.scorePrimary ?? ""))).length;
  const scH = rows.filter((r) => r.scorePrimary && r.scorePrimary === r.actualScore).length;
  const dcRows = rows.filter((r) => r.doubleChanceRecommended && Array.isArray(r.doubleChanceCodes) && WLD_CODE[r.actual]);
  const dcH = dcRows.filter((r) => r.doubleChanceCodes.map(String).includes(WLD_CODE[r.actual])).length;
  return { text: `胜负平${frac(wldH, wldN)}·让球${frac(hcH, hc.length)}·比分${frac(scH, scN)}·双选接住${frac(dcH, dcRows.length)}`, wldN };
}

export function buildRecordLine(ledger, todayIso) {
  const settled = (ledger ?? []).filter((r) => r.hit !== null && r.hit !== undefined && SCORE_RE.test(String(r.actualScore ?? "")));
  if (!settled.length) {
    return { text: "📊模型战绩:复盘ledger暂无已结算场(诚实空态),首批赛果结算后此行自动出现。", latest: null, settledN: 0 };
  }
  const latest = settled.map((r) => r.date).sort().at(-1);
  const cutoff = new Date(`${todayIso}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(cutoff);
  const win7 = settled.filter((r) => r.date >= cutoffIso);
  const latestRows = settled.filter((r) => r.date === latest);
  const t1 = tally(latestRows), t7 = tally(win7);
  return {
    latest, settledN: settled.length,
    text: `📊模型战绩✅(只读复盘ledger已结算行):最近结算日${latest}(${t1.wldN}场)${t1.text} ｜ 近7天(${t7.wldN}场)${t7.text} ｜ 半全场命中需半场真值,见复盘总表;让球=按实际比分+盘口线纯算术派生。`,
  };
}
