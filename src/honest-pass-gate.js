/**
 * 诚实过关闸门 (honest-pass-gate)
 * ──────────────────────────────────────────────────────────────────────────
 * 把 football-signal-verify 三视角对抗证伪的判据写成「确定性规则」,每注瞬间裁决
 * 过关 / 观望,逐条给理由。判据常量全部来自真实回测实证(非拍脑袋):
 *
 *   ▸ 校准可靠性档(walk-forward, big-5×~5季):
 *       33-45%  实测 gap -4.1pp(系统性高估)
 *       45-55%  实测 42.1%,gap -8.4pp(最差档,硬币区)
 *       55-65%  实测 65.4%(模型反偏保守 = 可信)
 *       65-100% gap -1.8pp(可信)
 *   ▸ 风险分层命中:高 40.9% / 中 50.0% / 低 57.1%
 *   ▸ 赛事先验:soft-international(国际/友谊/国家队)统计先验弱、信号多未学习
 *   ▸ CLV 金标准:公开数据打不过收盘线;负/零 EV=无价值;
 *     与市场同向→可信(54.2%),逆市→陷阱(22.7%);分歧越大市场越对
 *
 * 一注「诚实过关」= 必须同时清空全部 5 条硬伤(任一不过即转「观望」)。
 * 这是标注层,不抑制玩法(守 feedback_confidence_not_autosuppress):
 * 过关→进推荐池;观望→仍展示,带理由,买不买用户定。
 *
 * 纯函数,无 IO。
 *
 * 关联:[[reference_signal_backtest_findings]] [[project_hook_and_signal_verify]]
 *      [[reference_football_module_ablation_2026-06-02]] 与 clv-confidence-gate.js 互补
 *      (后者算背离/CLV 幅度,本模块出 0/1 过关裁决)。
 */

// ── 回测实证常量(改判据只改这里)────────────────────────────────────────
export const HONEST_PASS_CONST = {
  EV_MIN: 0.03,                 // 当前赔率下 EV 需 > +3% 才算有价值(覆盖抽水+噪声)
  PROB_RELIABLE_MIN: 0.55,      // 单选概率需落 55%+ 校准好的档;45-55% 是最差硬币区
  RISK_BLOCK: new Set(["高"]),  // 高风险档历史命中仅 40.9%,单选不过关
  DIVERGENCE_MAX_PP: 8,         // 与市场(去vig)分歧 > 8pp = 危险逆市区
  SOFT_LEAGUE_BLOCK: true,      // soft-international 无画像 → 单选不过关
  bands: {
    "33-45": { lo: 0.33, hi: 0.45, gap: -4.1, label: "33-45%(高估档)" },
    "45-55": { lo: 0.45, hi: 0.55, gap: -8.4, label: "45-55%(最差硬币档)" },
    "55-65": { lo: 0.55, hi: 0.65, gap: +5.0, label: "55-65%(可信·偏保守)" },
    "65-100": { lo: 0.65, hi: 1.01, gap: -1.8, label: "65%+(可信)" },
  },
};

/**
 * soft-international 判定(2026-06-18 工作流②集中化)。
 * 国家队/友谊/热身/邀请赛 等"统计先验弱、信号多未学习"的赛事 → 单选不过关。
 * 谨慎扩词:只纳入明确的国家队/友谊同义词;**不纳入 资格/预选/cup** —— 那些会误伤
 *   俱乐部资格赛(欧冠资格赛等是俱乐部赛, 有画像, 不该被 soft 拦)。WC 预选属国家队,
 *   由 isWorldCup 路由另行处理, 不靠此正则。
 * @param {string} competition
 * @returns {boolean}
 */
export function isSoftLeague(competition) {
  if (typeof competition !== "string") return false;
  return /国际|國際|友谊|友誼|友賽|友赛|热身|熱身|邀请赛|邀請賽|表演赛|国家队|國家隊|nations|friendly|exhibition/i.test(competition);
}

function bandOf(p) {
  for (const k of Object.keys(HONEST_PASS_CONST.bands)) {
    const b = HONEST_PASS_CONST.bands[k];
    if (p >= b.lo && p < b.hi) return { key: k, ...b };
  }
  return { key: "<33", lo: 0, hi: 0.33, gap: null, label: "<33%(冷门方向)" };
}

/**
 * 裁决一注是否诚实过关。
 * @param {object} row 归一化推荐行:
 *   { prob (0-1或百分), ev, risk, competition|softLeague(bool), divergencePp,
 *     aligned(bool), confidence }
 * @returns {{ pass, verdict, band, checks:[{name,ok,detail}], failReasons:[] }}
 */
export function honestPass(row) {
  let p = Number(row.prob);
  if (p > 1.5) p /= 100;
  const ev = row.ev == null ? null : Number(row.ev);
  const risk = row.risk ?? null;
  const div = row.divergencePp == null ? null : Math.abs(Number(row.divergencePp));
  const aligned = row.aligned;
  const soft = row.softLeague === true || isSoftLeague(row.competition);
  const band = bandOf(p);
  const C = HONEST_PASS_CONST;

  const checks = [];
  const fail = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // ① 市场效率 / EV:当前赔率下需正 EV(非负非零)
  fail("EV价值", ev != null && ev > C.EV_MIN,
    ev == null ? "无 EV(缺当前赔率,无法验证价值)"
      : ev > C.EV_MIN ? `EV ${ev.toFixed(3)} > +${C.EV_MIN}` : `EV ${ev.toFixed(3)} ≤ +${C.EV_MIN}(无价值/负值)`);

  // ② 校准档:单选概率需落可信档(≥55%),避开 45-55 / 33-45 高估区
  fail("校准档", p >= C.PROB_RELIABLE_MIN,
    p >= C.PROB_RELIABLE_MIN ? `概率 ${(p * 100).toFixed(1)}% 落 ${band.label}` :
      `概率 ${(p * 100).toFixed(1)}% 落 ${band.label}${band.gap != null ? `,实测 gap ${band.gap}pp` : ""} → 单选高估`);

  // ③ 风险档:高风险档历史命中仅 40.9%,单选不过
  fail("风险档", !(risk != null && C.RISK_BLOCK.has(risk)),
    risk == null ? "风险未知" : C.RISK_BLOCK.has(risk) ? `风险=${risk}(高风险档历史命中仅 40.9%)` : `风险=${risk}(可接受)`);

  // ④ 赛事先验:soft-international 无画像、信号未学习
  fail("赛事先验", !(C.SOFT_LEAGUE_BLOCK && soft),
    soft ? "soft-international(国际/友谊·统计先验弱、信号多未学习)" : "有联赛画像/俱乐部赛");

  // ⑤ 市场一致性:同向 + 分歧不过大(逆市/大分歧=陷阱)
  const alignOk = aligned !== false && (div == null || div <= C.DIVERGENCE_MAX_PP);
  fail("市场一致", alignOk,
    aligned === false ? "逆市场选项(实证逆市命中仅 22.7%)" :
      div != null && div > C.DIVERGENCE_MAX_PP ? `与市场分歧 ${div}pp > ${C.DIVERGENCE_MAX_PP}pp(分歧越大市场越对)` :
        div != null ? `与市场同向·分歧 ${div}pp` : "与市场同向");

  const failReasons = checks.filter((c) => !c.ok).map((c) => `[${c.name}] ${c.detail}`);
  const pass = failReasons.length === 0;
  return {
    pass,
    verdict: pass ? "✅ 诚实过关(进推荐池)" : `🔻 观望(${failReasons.length}/5 条硬伤)`,
    band: band.label,
    checks,
    failReasons,
  };
}

/** 给定全场,过滤出诚实过关的注(推荐池)与观望池。 */
export function splitHonestPool(rows) {
  const judged = rows.map((r) => ({ ...r, honest: honestPass(r) }));
  return {
    pass: judged.filter((r) => r.honest.pass),
    watch: judged.filter((r) => !r.honest.pass),
    judged,
  };
}
