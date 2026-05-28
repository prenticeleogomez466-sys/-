/**
 * Live 概率追踪器
 * ──────────────────────────────────────────────────
 * 比赛进行中,根据事件流(进球/红牌/换人/时间过去)实时更新概率.
 * 用 markov-match-simulator 的 inPlayProbabilities 作为基底引擎.
 *
 * 事件类型:
 *   - "goal-home" / "goal-away": 进球
 *   - "red-home" / "red-away": 红牌(对应队 λ 折扣 30%)
 *   - "minute": 时间过去
 *   - "halftime": 中场休息(状态记录,不变 λ)
 *
 * 用法:
 *   const t = createLiveTracker({ lambdaHomeFull: 1.5, muAwayFull: 0.9 });
 *   t.advance(15);             // 推进到 15 分钟
 *   t.event("goal-home");      // 主队进球
 *   t.advance(30);             // 推进到 30 分钟
 *   t.event("red-away");       // 客队红牌
 *   t.snapshot();              // { home, draw, away } 概率
 */

import { inPlayProbabilities } from "./markov-match-simulator.js";

export function createLiveTracker({ lambdaHomeFull, muAwayFull, opts = {} }) {
  const state = {
    homeGoals: 0,
    awayGoals: 0,
    minute: 0,
    homeRedCard: false,
    awayRedCard: false,
    history: [],
    lambdaHomeFull: Number(lambdaHomeFull),
    muAwayFull: Number(muAwayFull),
    log: []
  };

  function snapshot() {
    return inPlayProbabilities(
      { home: state.homeGoals, away: state.awayGoals, minute: state.minute },
      state.lambdaHomeFull,
      state.muAwayFull,
      { homeRedCard: state.homeRedCard, awayRedCard: state.awayRedCard, ...opts }
    );
  }

  return {
    state,
    snapshot,
    advance(minutes) {
      state.minute = Math.min(90, state.minute + minutes);
      state.history.push({ minute: state.minute, ...snapshot().probabilities });
      state.log.push(`Advanced to ${state.minute}'`);
      return this;
    },
    event(type, opts = {}) {
      if (type === "goal-home") {
        state.homeGoals += 1;
        state.log.push(`${state.minute}' GOAL home (now ${state.homeGoals}-${state.awayGoals})`);
      } else if (type === "goal-away") {
        state.awayGoals += 1;
        state.log.push(`${state.minute}' GOAL away (now ${state.homeGoals}-${state.awayGoals})`);
      } else if (type === "red-home") {
        state.homeRedCard = true;
        state.log.push(`${state.minute}' RED CARD home`);
      } else if (type === "red-away") {
        state.awayRedCard = true;
        state.log.push(`${state.minute}' RED CARD away`);
      } else if (type === "halftime") {
        state.minute = 45;
        state.log.push(`HALFTIME at ${state.homeGoals}-${state.awayGoals}`);
      } else if (type === "minute") {
        state.minute = Math.min(90, Math.max(state.minute, Number(opts.value ?? state.minute)));
      }
      state.history.push({ minute: state.minute, event: type, ...snapshot().probabilities });
      return this;
    },
    /**
     * 一次性消费一组事件,返回每步快照
     */
    replay(events) {
      const snapshots = [{ minute: 0, label: "kickoff", ...snapshot().probabilities }];
      for (const ev of events) {
        if (ev.advance) this.advance(ev.advance);
        if (ev.event) this.event(ev.event, ev);
        snapshots.push({ minute: state.minute, label: ev.event ?? `t+${ev.advance}'`, ...snapshot().probabilities });
      }
      return snapshots;
    },
    /**
     * 时间衰减后的概率
     */
    expectedFinal() {
      const snap = snapshot();
      return {
        ...snap,
        homeGoalsExpected: snap.expectedFinal?.home,
        awayGoalsExpected: snap.expectedFinal?.away,
        currentScore: `${state.homeGoals}-${state.awayGoals}`,
        minute: state.minute
      };
    },
    getLog() {
      return [...state.log];
    }
  };
}

/**
 * 给一个完整比赛事件序列,产出概率随时间的轨迹.
 * 用于复盘"比赛中我的下注 EV 怎么变"
 */
export function buildLiveProbabilityTrajectory(lambdaHome, muAway, events) {
  const tracker = createLiveTracker({ lambdaHomeFull: lambdaHome, muAwayFull: muAway });
  return tracker.replay(events);
}
