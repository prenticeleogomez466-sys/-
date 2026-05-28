/**
 * Online Incremental DC Update
 * ──────────────────────────────────────────────────
 * Dixon-Coles 引擎当前是 batch 训练(全量重新拟合).Online 模式:
 *   - 维护当前球队 attack/defense 状态
 *   - 每场新比赛后用 gradient step 更新该比赛涉及球队
 *   - 比 batch 重训快几个数量级
 *
 * 算法:
 *   预测 λ_h = baseRate × atk_h × def_a × HA
 *   误差 = goals_actual - λ
 *   atk_h += η × error_home(关于 atk_h 的偏导:正向)
 *   def_a += η × error_home(关于 def_a 的偏导:正向)
 *   ...
 *
 * 用途:
 *   - daily-evolution 跑完后立刻 online-update 当天的比赛结果
 *   - 不用等周一 batch 重训
 *   - 配合 Kalman tracker 形成完整 online learning 栈
 */

const DEFAULT_LR = 0.05;
const DEFAULT_HOME_ADV = 1.28;

/**
 * 创建一个 online DC 学习器,可从空 state 开始或从现有 fitted state 接管.
 */
export function createOnlineDcLearner(opts = {}) {
  const state = {
    baseRate: opts.baseRate ?? 1.35,
    homeAdvantage: opts.homeAdvantage ?? DEFAULT_HOME_ADV,
    teams: opts.teams ?? {},  // { teamName: { attack, defense, observations } }
    lr: opts.learningRate ?? DEFAULT_LR,
    decay: opts.decay ?? 0.5,  // 半衰期天数
    matchesProcessed: 0
  };

  function ensure(team) {
    if (!state.teams[team]) state.teams[team] = { attack: 1, defense: 1, observations: 0 };
    return state.teams[team];
  }

  return {
    state,
    /**
     * Online update:消费单个比赛.
     */
    update(match) {
      if (!match.home || !match.away) return null;
      const gh = Number(match.homeGoals);
      const ga = Number(match.awayGoals);
      if (!Number.isFinite(gh) || !Number.isFinite(ga)) return null;

      const th = ensure(match.home);
      const ta = ensure(match.away);

      // 预测 λ
      const lambdaH = state.baseRate * th.attack * ta.defense * state.homeAdvantage;
      const lambdaA = state.baseRate * ta.attack * th.defense;

      // 误差(对数 lambda 的更新更稳)
      // d log λ_h / d atk_h = 1
      // d log λ_h / d def_a = 1
      // d log λ_a / d atk_a = 1
      // d log λ_a / d def_h = 1
      const errH = gh - lambdaH;
      const errA = ga - lambdaA;

      // Multiplicative update(类似 DC fit 内的 damp)
      const damp = 0.5;
      const ratioH = (gh + 0.5) / (lambdaH + 0.5);
      const ratioA = (ga + 0.5) / (lambdaA + 0.5);

      th.attack *= Math.pow(ratioH, state.lr * damp);
      ta.defense *= Math.pow(ratioH, state.lr * damp);
      ta.attack *= Math.pow(ratioA, state.lr * damp);
      th.defense *= Math.pow(ratioA, state.lr * damp);

      th.observations++;
      ta.observations++;
      state.matchesProcessed++;

      // Bound 防漂(对数 ratio 限制)
      th.attack = clamp(th.attack, 0.3, 3.0);
      th.defense = clamp(th.defense, 0.3, 3.0);
      ta.attack = clamp(ta.attack, 0.3, 3.0);
      ta.defense = clamp(ta.defense, 0.3, 3.0);

      return {
        team1: { name: match.home, attack: round(th.attack), defense: round(th.defense) },
        team2: { name: match.away, attack: round(ta.attack), defense: round(ta.defense) },
        predicted: { home: round(lambdaH), away: round(lambdaA) },
        actual: { home: gh, away: ga },
        errors: { home: round(errH), away: round(errA) }
      };
    },

    /**
     * Batch from sequence(按时间排序消费).
     */
    feedMatches(matches) {
      const sorted = [...matches].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const updates = [];
      for (const m of sorted) {
        const r = this.update(m);
        if (r) updates.push(r);
      }
      return updates;
    },

    /**
     * 预测一场比赛.
     */
    predict(home, away) {
      const th = state.teams[home] ?? { attack: 1, defense: 1 };
      const ta = state.teams[away] ?? { attack: 1, defense: 1 };
      const lambdaH = state.baseRate * th.attack * ta.defense * state.homeAdvantage;
      const lambdaA = state.baseRate * ta.attack * th.defense;
      return {
        lambdaHome: round(lambdaH),
        lambdaAway: round(lambdaA),
        expectedGoals: round(lambdaH + lambdaA)
      };
    },

    /**
     * 导出当前状态(可序列化).
     */
    dump() {
      return {
        baseRate: state.baseRate,
        homeAdvantage: state.homeAdvantage,
        matchesProcessed: state.matchesProcessed,
        teams: Object.fromEntries(Object.entries(state.teams).map(([k, v]) => [k, {
          attack: round(v.attack),
          defense: round(v.defense),
          observations: v.observations
        }]))
      };
    }
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
