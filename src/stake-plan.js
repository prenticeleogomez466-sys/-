// 信心档注金分层(2026-06-12 用户三裁决:基础注100元/注;每场只挂"最可信的一个玩法";硬币档×0.5减半不弃赛)。
// 倍率:🟢一档×2 / 🟢二档×1 / 🟡三档×1 / 🟠偏弱×0.5 / ⚪硬币档×0.5(单调不增;档位缺=不给金额,诚实)。
// 玩法挑选:胜负平主选概率 vs 让球真实裁决方向概率(模型口径),取高者;比分/半全场/总进球天花板低不挂金额。
// 铁律对齐:金额=🔶分层口径建议非下注指令,不替用户弃赛(feedback_confidence_not_autosuppress);概率全为模型派生🔶。
export const STAKE_BASE = 100;

const MULTS = [[/一档/, 2], [/二档/, 1], [/三档/, 1], [/偏弱/, 0.5], [/硬币/, 0.5]];
export function stakeMultiplier(tierLabel) {
  for (const [re, m] of MULTS) if (re.test(String(tierLabel ?? ""))) return m;
  return null;
}

const HW_KEY = { "3": "home", "1": "push", "0": "away" };
export function buildStakeSuggestion(p) {
  const tier = p.selectionTier?.label ?? "";
  const mult = stakeMultiplier(tier);
  if (mult == null) return null;
  // 候选1:胜负平主选(模型三概率最大项)
  const probs = p.probabilities ?? {};
  const wldProb = Math.max(probs.home ?? 0, probs.draw ?? 0, probs.away ?? 0);
  const wldSel = p.pick?.label ?? null;
  // 候选2:让球真实裁决方向(模型过盘概率;与 handicapVerdictParts 同源字段,不另算)
  const hw = p.handicapPick?.handicapWld;
  const hwProb = hw?.probability ?? (hw?.pickCode ? hw?.probabilities?.[HW_KEY[hw.pickCode]] : null);
  const line = p.marketSnapshot?.jingcaiHandicap?.line ?? p.handicapPick?.line ?? null;
  const useHandicap = Number.isFinite(hwProb) && hwProb > wldProb && hw?.pick && line != null;
  const market = useHandicap ? `让球(${line > 0 ? `+${line}` : line})` : "胜负平";
  const sel = useHandicap ? hw.pick : wldSel;
  const prob = useHandicap ? hwProb : wldProb;
  if (!sel || !(prob > 0)) return null;
  const stake = Math.round(STAKE_BASE * mult);
  const pct = Math.round(prob * 100);
  return { market, sel, prob: pct, tier, mult, stake, text: `${stake}元→${market}「${sel}」(模型${pct}%·${tier}×${mult})` };
}

export function stakeSummary(stakes) {
  const live = (stakes ?? []).filter(Boolean);
  const total = live.reduce((t, s) => t + s.stake, 0);
  return {
    total, n: live.length,
    note: `💰注金口径🔶(2026-06-12裁决):基础注${STAKE_BASE}元,🟢一档×2/🟢二档×1/🟡三档×1/🟠偏弱×0.5/⚪硬币×0.5;每场只挂最可信玩法(胜负平vs让球按模型概率高者),比分/半全场天花板低不挂金额。今日合计${total}元/${live.length}场。金额只是分层口径建议,买不买/买多少你定(硬币档减半不替你弃赛)。`,
  };
}
