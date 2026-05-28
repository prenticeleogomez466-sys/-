/**
 * Line Movement Tracker(临场赔率变化信号)
 * ──────────────────────────────────────────────────
 * Sharp 玩家公认的最强信号之一:开盘到临场赔率的移动方向 = 庄家真实判断.
 *
 *   - Sharp money 移动赔率:开盘 2.10,临场 1.85 → 主胜方向有 sharp 钱
 *   - 公众钱反方向:Bet365 等公众盘相反移动 = 公众加注客胜,sharp 不同意
 *   - Steam move(蒸汽移动):短时间内多家盘口同向移动 = 极强信号
 *
 * 命中率提升:用线移信号过滤推荐 — 跟 sharp 移动一致的更值得投.
 */

/**
 * 单一 fixture 的 line movement 分析.
 *
 * @param {Object} input
 *   { fixtureId, snapshots: [{ source, timestamp, odds: { home, draw, away } }] }
 *   snapshots 按时间升序
 * @returns {Object} 分析结果
 */
export function analyzeLineMovement(input) {
  const snapshots = (input?.snapshots ?? []).filter((s) => s.odds && Number.isFinite(Number(s.odds.home)));
  if (snapshots.length < 2) return { ok: false, reason: "need-≥2-snapshots" };

  const sorted = [...snapshots].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const open = sorted[0];
  const close = sorted[sorted.length - 1];

  // 每个 outcome 的赔率移动
  const movements = {};
  for (const outcome of ["home", "draw", "away"]) {
    const openOdds = Number(open.odds[outcome]);
    const closeOdds = Number(close.odds[outcome]);
    if (!Number.isFinite(openOdds) || !Number.isFinite(closeOdds)) continue;
    const change = closeOdds - openOdds;
    const changePct = openOdds > 0 ? change / openOdds : 0;
    const direction = change < -0.05 ? "down" : change > 0.05 ? "up" : "flat";
    // odds 下降 → 庄家收紧 → 这个 outcome 上有 sharp money
    const implicitSignal = direction === "down" ? "sharp-money-on" : direction === "up" ? "sharp-money-off" : "neutral";
    movements[outcome] = {
      open: openOdds,
      close: closeOdds,
      change: round(change),
      changePct: round(changePct),
      direction,
      implicitSignal
    };
  }

  // Steam move 检测:超过 1 个 outcome 同向 + ≥ 5% 变动
  const sharpOnOutcomes = Object.entries(movements).filter(([, m]) => m.direction === "down").map(([o]) => o);
  const isSteam = sharpOnOutcomes.length >= 1 && sharpOnOutcomes.some((o) => Math.abs(movements[o].changePct) >= 0.08);

  // Reverse line movement: 公众钱在 outcome A,但庄家把 A 的赔率往上推(反公众)
  // 简化版:开盘最低赔率方向 ≠ 收盘最低赔率方向
  const openFav = Object.entries(open.odds).sort((a, b) => Number(a[1]) - Number(b[1]))[0][0];
  const closeFav = Object.entries(close.odds).sort((a, b) => Number(a[1]) - Number(b[1]))[0][0];
  const reverseLineMove = openFav !== closeFav;

  return {
    ok: true,
    fixtureId: input.fixtureId,
    open: { timestamp: open.timestamp, odds: open.odds, source: open.source },
    close: { timestamp: close.timestamp, odds: close.odds, source: close.source },
    snapshotsCount: sorted.length,
    movements,
    sharpOnOutcomes,
    isSteam,
    reverseLineMove,
    interpretation: buildInterpretation(movements, isSteam, reverseLineMove, openFav, closeFav)
  };
}

function buildInterpretation(movements, isSteam, reverseLineMove, openFav, closeFav) {
  const sharpOutcomes = Object.entries(movements)
    .filter(([, m]) => m.direction === "down")
    .map(([o]) => o);

  if (reverseLineMove) {
    const cnHome = closeFav === "home" ? "主胜" : closeFav === "draw" ? "平局" : "客胜";
    const cnOpen = openFav === "home" ? "主胜" : openFav === "draw" ? "平局" : "客胜";
    return `🔄 反向线移:开盘最热是 ${cnOpen},临场最热变成 ${cnHome} — 强 sharp 信号,跟随 ${cnHome}`;
  }
  if (isSteam) {
    const cn = sharpOutcomes.map((o) => o === "home" ? "主胜" : o === "draw" ? "平局" : "客胜").join("/");
    return `💨 Steam move:${cn} 方向赔率显著收紧,sharp money 大量进入,值得跟随`;
  }
  if (sharpOutcomes.length) {
    const cn = sharpOutcomes.map((o) => o === "home" ? "主胜" : o === "draw" ? "平局" : "客胜").join("/");
    return `📊 ${cn} 方向略有 sharp money,可作辅助信号`;
  }
  return "📊 赔率稳定,无明显 sharp 信号";
}

/**
 * 多场比赛 batch 分析,找出有最强 steam move 的 top-K.
 */
export function batchAnalyzeMovements(fixturesSnapshots, opts = {}) {
  const k = opts.topK ?? 5;
  const results = fixturesSnapshots.map(analyzeLineMovement).filter((r) => r.ok);
  // 排序:reverseLineMove > steam > 普通 sharp > flat
  results.sort((a, b) => {
    const scoreA = (a.reverseLineMove ? 100 : 0) + (a.isSteam ? 50 : 0) + a.sharpOnOutcomes.length * 10;
    const scoreB = (b.reverseLineMove ? 100 : 0) + (b.isSteam ? 50 : 0) + b.sharpOnOutcomes.length * 10;
    return scoreB - scoreA;
  });
  return {
    total: results.length,
    topMoves: results.slice(0, k),
    reverseLineMoves: results.filter((r) => r.reverseLineMove),
    steamMoves: results.filter((r) => r.isSteam)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
