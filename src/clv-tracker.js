/**
 * Closing Line Value (CLV) 追踪器
 * ──────────────────────────────────────────────────
 * CLV 是 sharp bettor 的金标准.思想:
 *   - 不看单场胜负(短期 luck)
 *   - 看「下注时的赔率 vs 临场收盘赔率」之差(closing line 是 efficient market 的最优估计)
 *   - 正 CLV ≥ 55% → 长期一定赢
 *
 * 公式:
 *   CLV (%) = (P_close - P_bet) / P_bet × 100
 *   其中 P_close = 1 / closing_odds (收盘隐含概率)
 *        P_bet   = 1 / bet_odds     (下注时隐含概率)
 *
 * 如果我们下注时 odds = 2.10 (P_bet = 0.476),临场收盘 odds = 1.95 (P_close = 0.513):
 *   CLV = (0.513 - 0.476) / 0.476 = +7.8% → 强正 CLV → 长期赚钱
 *
 * 用法:
 *   tracker.recordBet({ fixtureId, outcome, betOdds, betProbability });
 *   tracker.recordClose({ fixtureId, outcome, closingOdds });
 *   tracker.summary();  // 平均 CLV、CLV-positive 率、CLV-positive 但输的次数(校准信号)
 */

const STRONG_CLV_THRESHOLD = 0.03;  // CLV > 3% = 强信号
const POSITIVE_CLV_THRESHOLD = 0;

/**
 * 计算单条 CLV.
 * @param {number} betOdds  下注时赔率
 * @param {number} closingOdds  临场收盘赔率
 * @returns {{ clv, verdict, betImpliedProb, closingImpliedProb }}
 */
export function computeCLV(betOdds, closingOdds) {
  const b = Number(betOdds);
  const c = Number(closingOdds);
  if (!Number.isFinite(b) || !Number.isFinite(c) || b <= 1 || c <= 1) {
    return { clv: null, verdict: "invalid", betImpliedProb: null, closingImpliedProb: null };
  }
  const pBet = 1 / b;
  const pClose = 1 / c;
  // CLV = (close - bet) / bet
  // 收盘隐含概率 > 下注隐含概率 = 庄家收紧赔率,你抓到了 sharp 价格
  const clv = (pClose - pBet) / pBet;
  let verdict;
  if (clv > STRONG_CLV_THRESHOLD) verdict = "strong-positive";
  else if (clv > POSITIVE_CLV_THRESHOLD) verdict = "positive";
  else if (clv > -STRONG_CLV_THRESHOLD) verdict = "neutral";
  else verdict = "negative";
  return {
    clv: round(clv),
    verdict,
    betImpliedProb: round(pBet),
    closingImpliedProb: round(pClose),
    oddsMovementPct: round((c - b) / b * -100)  // odds 跌 = 庄家压低 = 我们抓到价
  };
}

/**
 * Tracker:维护一系列 bets,匹配 closing odds 后算 CLV summary.
 */
export function buildCLVTracker() {
  const bets = new Map();   // fixtureId+outcome → bet record
  const closings = new Map();

  return {
    recordBet({ fixtureId, outcome, betOdds, betProbability = null, stake = null }) {
      const key = `${fixtureId}__${outcome}`;
      bets.set(key, { fixtureId, outcome, betOdds: Number(betOdds), betProbability, stake });
    },
    recordClose({ fixtureId, outcome, closingOdds }) {
      const key = `${fixtureId}__${outcome}`;
      closings.set(key, Number(closingOdds));
    },
    /**
     * 汇总:平均 CLV、+CLV 比例、强 +CLV 比例
     */
    summary() {
      const records = [];
      for (const [key, bet] of bets.entries()) {
        const closingOdds = closings.get(key);
        if (closingOdds == null) continue;
        const r = computeCLV(bet.betOdds, closingOdds);
        if (r.clv == null) continue;
        records.push({ ...bet, closingOdds, ...r });
      }
      if (!records.length) return { ok: false, samples: 0 };
      const avgCLV = records.reduce((s, r) => s + r.clv, 0) / records.length;
      const positiveRate = records.filter((r) => r.clv > POSITIVE_CLV_THRESHOLD).length / records.length;
      const strongPositiveRate = records.filter((r) => r.clv > STRONG_CLV_THRESHOLD).length / records.length;
      // 长期盈利信号:平均 CLV > 0 + 正 CLV 率 ≥ 55%
      const longTermProfitable = avgCLV > 0 && positiveRate >= 0.55;
      return {
        ok: true,
        samples: records.length,
        avgCLV: round(avgCLV),
        positiveRate: round(positiveRate),
        strongPositiveRate: round(strongPositiveRate),
        longTermProfitable,
        verdict: longTermProfitable
          ? `🟢 正 CLV ${round(avgCLV*100)}%,长期盈利信号(${Math.round(positiveRate*100)}% 下注击败收盘线)`
          : `🔴 平均 CLV ${round(avgCLV*100)}%,长期盈利信号弱(${Math.round(positiveRate*100)}% 击败收盘线,需 ≥55%)`,
        records: records.slice(0, 20)  // 展示前 20
      };
    },
    /**
     * 给 ledger row 加 CLV 字段(prediction.bet → closing.match)
     */
    enrichLedgerRow(row, closingOdds) {
      return enrichLedgerRow(row, closingOdds);
    }
  };
}

/**
 * 给单条 ledger row 计算并附加 CLV 字段。
 * @param {Object} row 含 primaryOdds(下注时该选项的小数赔率)
 * @param {number} closingOdds 收盘小数赔率
 * @param {{measured?: boolean}} opts measured=false 表示无真收盘快照(收盘=下注同价/同次捕获),
 *   仅占位不计入 CLV 统计,避免单次捕获把 CLV 误报成 0/🔴。
 * @returns {Object} 带 closingOdds/clv/clvVerdict/clvMeasured 的新 row(无法计算时原样返回)
 */
export function enrichLedgerRow(row, closingOdds, opts = {}) {
  if (!row || closingOdds == null || !Number.isFinite(Number(row.primaryOdds))) return row;
  const r = computeCLV(row.primaryOdds, closingOdds);
  if (r.clv == null) return row;
  const measured = opts.measured ?? true;
  return { ...row, closingOdds: Number(closingOdds), clv: r.clv, clvVerdict: r.verdict, clvMeasured: measured };
}

/**
 * 汇总一批已结算 ledger row 的 CLV(分析师建议的真 KPI:看下注价 vs 收盘线,而非短期命中率)。
 * 只统计 clvMeasured===true 的行;无真收盘数据时诚实返回 measurable:false 而非误报亏损。
 * @param {Array} rows
 * @returns {{ok, samples, avgCLV?, positiveRate?, strongPositiveRate?, longTermProfitable?, verdict, measurable}}
 */
export function summarizeLedgerCLV(rows = []) {
  const clvRows = (Array.isArray(rows) ? rows : []).filter((r) => r && r.clvMeasured === true && Number.isFinite(Number(r.clv)));
  if (!clvRows.length) {
    return { ok: false, samples: 0, measurable: false, verdict: "⚪ 暂无可测 CLV(需收盘赔率快照;单次捕获无法测 CLV)" };
  }
  const clvs = clvRows.map((r) => Number(r.clv));
  const avgCLV = clvs.reduce((s, v) => s + v, 0) / clvs.length;
  const positiveRate = clvs.filter((v) => v > POSITIVE_CLV_THRESHOLD).length / clvs.length;
  const strongPositiveRate = clvs.filter((v) => v > STRONG_CLV_THRESHOLD).length / clvs.length;
  const longTermProfitable = avgCLV > 0 && positiveRate >= 0.55;
  return {
    ok: true,
    samples: clvRows.length,
    measurable: true,
    avgCLV: round(avgCLV),
    positiveRate: round(positiveRate),
    strongPositiveRate: round(strongPositiveRate),
    longTermProfitable,
    verdict: longTermProfitable
      ? `🟢 平均 CLV ${round(avgCLV * 100)}%,${Math.round(positiveRate * 100)}% 击败收盘线 → 长期盈利信号`
      : `🔴 平均 CLV ${round(avgCLV * 100)}%,${Math.round(positiveRate * 100)}% 击败收盘线(需 ≥55%)→ 长期盈利信号弱`
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
