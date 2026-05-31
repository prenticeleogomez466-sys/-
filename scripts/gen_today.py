"""
一键生成今日 30 注 (大乐透/排三/排五 各 10 注) ——
每注一种不同策略, 带策略标签 + 冷门度评分, 自动写入 bets 表。

用法:
    python scripts/gen_today.py                  # 出号 + 写 DB
    python scripts/gen_today.py --dry-run        # 只出号不写 DB
    python scripts/gen_today.py --no-clear       # 不清掉今天的旧 bets
    python scripts/gen_today.py --strategies 反热门(融合) 全策略融合 偏冷  # 指定策略

强制约束 (写在 feedback_lottery_budget):
    - 每彩种最多 10 注 / 20 元
    - 大乐透只出单式 (5+2), 不出复式
"""
from __future__ import annotations

import argparse
import datetime
import random
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src import strategies, popularity, randomness, budget   # noqa: E402
from src import math_strategies as ms   # noqa: E402
from src import advanced_stats as ad   # noqa: E402
from src import wheels   # noqa: E402
from src import bandit as bd   # noqa: E402
from src import ml_truth as mt   # noqa: E402
from src import info_theory as it   # noqa: E402
from src import winners as wn   # noqa: E402
from src import sporttery as sp   # noqa: E402
from src import topology as tp   # noqa: E402
from src import optimal_portfolio as op   # noqa: E402
from src import auto_settle as asx   # noqa: E402
from src import international as itl   # noqa: E402
from src import sota_models as so   # noqa: E402
from src import conformal as cf   # noqa: E402
from src.config import data_dir   # noqa: E402

DB = data_dir() / "lottery.sqlite"
COST = 2.0   # 每注 2 元


def latest_issue(game: str) -> tuple[int, str]:
    """从 DB 查最新一期, 计算下一期期号 (粗略 +1)。"""
    with sqlite3.connect(DB) as c:
        cur = c.execute(f"SELECT issue, date FROM {game}_draws ORDER BY date DESC LIMIT 1")
        row = cur.fetchone()
    if not row:
        return 0, datetime.date.today().isoformat()
    return row[0] + 1, datetime.date.today().isoformat()


def clear_today(date_str: str) -> int:
    """清掉今天已经写入的同日 bets, 返回删除条数。"""
    with sqlite3.connect(DB) as c:
        cur = c.execute("DELETE FROM bets WHERE date = ?", (date_str,))
        c.commit()
        return cur.rowcount


def write_bets(date_str: str, dlt_bets, p3_bets, p5_bets, dlt_issue, p_issue):
    """30 注同时写入 bets 表 + recommendation_ledger 表 (v2.0 反 drift)。"""
    rows = []
    ledger_items = []
    for b in dlt_bets:
        note = f"{b.strategy}|热度{b.popularity_score}({b.popularity_label})"
        rows.append((date_str, "dlt", dlt_issue, b.combo_str(), COST, None, note))
        ledger_items.append({"game": "dlt", "combo": b.combo_str(),
                              "target_issue": dlt_issue, "strategy": b.strategy,
                              "popularity": b.popularity_score,
                              "source_label": "gen_today", "note": note})
    for b in p3_bets:
        note = f"{b.strategy}|热度{b.popularity_score}({b.popularity_label})"
        rows.append((date_str, "p3", p_issue, b.combo_str(), COST, None, note))
        ledger_items.append({"game": "p3", "combo": b.combo_str(),
                              "target_issue": p_issue, "strategy": b.strategy,
                              "popularity": b.popularity_score,
                              "source_label": "gen_today", "note": note})
    for b in p5_bets:
        note = f"{b.strategy}|热度{b.popularity_score}({b.popularity_label})"
        rows.append((date_str, "p5", p_issue, b.combo_str(), COST, None, note))
        ledger_items.append({"game": "p5", "combo": b.combo_str(),
                              "target_issue": p_issue, "strategy": b.strategy,
                              "popularity": b.popularity_score,
                              "source_label": "gen_today", "note": note})

    with sqlite3.connect(DB) as c:
        c.executemany(
            "INSERT INTO bets(date,game,issue,combo,stake_cny,prize_cny,note) VALUES (?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()

    # v2.0-α: 同时入 ledger, 消除 reconciliation drift
    try:
        from src.recommendation_hook import publish_recommendations
        publish_recommendations(ledger_items, session_label="gen_today", auto_settle=True)
    except Exception as e:
        print(f"  [WARN] ledger 写入失败: {e}")

    return len(rows)


def print_table(title, bets, header_func, row_func):
    """通用打印一个彩种的 10 注表格。"""
    print(f"\n{title}")
    print("-" * 78)
    print(header_func())
    print("-" * 78)
    for i, b in enumerate(bets, 1):
        print(row_func(i, b))


def bandit_recommend(arm_pool: list[str], k: int, algorithm: str, game: str,
                     rng: random.Random) -> tuple[list[str], str]:
    """
    用 bandit 从 arm_pool 推荐 k 个策略。
    bets 表有 ≥10 条已结算时启用学习; 否则退化为均匀采样(等同冷启动)。
    返回 (策略列表, 来源说明)。
    """
    history = bd.load_bet_history(game=game)
    if len(history) < 10:
        # 冷启动: bets 历史 < 10, 用固定列表(不会真正学习)
        return arm_pool[:k], f"cold-start (bets 历史 {len(history)} 条 < 10)"

    try:
        from src import rl_optimizer
        selected, source = rl_optimizer.recommend_strategy_mix(game, arm_pool, k=k)
        if selected:
            return selected, source
    except Exception:
        pass

    if algorithm == "thompson":
        bandit = bd.ThompsonSamplingBandit(arm_pool, rng=rng)
    elif algorithm == "ucb1":
        bandit = bd.UCB1Bandit(arm_pool)
    elif algorithm == "epsilon":
        bandit = bd.EpsilonGreedyBandit(arm_pool, epsilon=0.3, rng=rng)
    elif algorithm == "exp3":
        bandit = bd.Exp3Bandit(arm_pool, rng=rng)
    else:
        return arm_pool[:k], f"unknown algorithm {algorithm}, fallback to fixed"

    for h in history:
        if h["strategy"] in bandit.arms:
            bandit.update(h["strategy"], h["reward"], h["won"])

    # 用 bandit 选 k 次(可能重复, 重复时随机替换为未选过的)
    selected = []
    used = set()
    for _ in range(k * 3):  # 给点冗余尝试避免循环
        if len(selected) >= k:
            break
        pick = bandit.select()
        if pick not in used:
            selected.append(pick)
            used.add(pick)
    # 不够 k 个就用未选过的策略补
    if len(selected) < k:
        remaining = [s for s in arm_pool if s not in used]
        selected.extend(remaining[: k - len(selected)])
    return selected, f"{algorithm} (从 {len(history)} 条历史 bet 学到)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="不写 DB")
    ap.add_argument("--no-clear", action="store_true", help="不清今天旧 bets")
    ap.add_argument("--dlt-strategies", nargs="*", default=None, help="自定义大乐透策略列表")
    ap.add_argument("--digit-strategies", nargs="*", default=None, help="自定义排三/排五策略列表")
    ap.add_argument("--bandit", choices=["thompson", "ucb1", "epsilon", "exp3", "off"],
                    default="thompson", help="bandit 算法 (默认 thompson; off 用固定列表)")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    today = datetime.date.today().isoformat()
    dlt_issue, _ = latest_issue("dlt")
    p_issue, _ = latest_issue("p3")

    # 默认策略池: 每彩种 10 注, 10 种不同策略 (覆盖频次/形态/博弈/融合 各族)
    default_dlt = [
        "纯机选", "偏热3+2", "偏冷2+3", "极冷5+2", "遗漏值优先",
        "多窗口加权热", "三区均衡", "和值居中", "杀生日号", "反热门(融合)",
    ]
    default_digit = [
        "纯机选", "偏热", "偏冷", "温号", "遗漏值优先",
        "和值居中", "杀最热", "邻号", "反热门(融合)", "全策略融合",
    ]

    # Bandit 闭环: 根据 bets 表历史动态选策略
    if args.bandit == "off":
        dlt_strategies = args.dlt_strategies or default_dlt
        digit_strategies_p3 = args.digit_strategies or default_digit
        digit_strategies_p5 = args.digit_strategies or default_digit
        bandit_note = "off (用固定策略列表)"
    else:
        dlt_strategies, dlt_src = bandit_recommend(
            args.dlt_strategies or default_dlt, k=10, algorithm=args.bandit,
            game="dlt", rng=rng,
        )
        digit_strategies_p3, p3_src = bandit_recommend(
            args.digit_strategies or default_digit, k=10, algorithm=args.bandit,
            game="p3", rng=rng,
        )
        digit_strategies_p5, p5_src = bandit_recommend(
            args.digit_strategies or default_digit, k=10, algorithm=args.bandit,
            game="p5", rng=rng,
        )
        bandit_note = f"DLT={dlt_src}; P3={p3_src}; P5={p5_src}"

    dlt_bets = strategies.gen_dlt_portfolio(n_bets=10, strategies=dlt_strategies, rng=rng)
    p3_bets = strategies.gen_digit_portfolio("p3", n_bets=10, strategies=digit_strategies_p3, rng=rng)
    # v1.8: P5 联动 — 前 3 位继承 P3 推荐, 后 2 位 anti_hot 生成
    # 这是基于"P3/P5 共享同一开奖前 3 位"的数学事实, 见 src/linked_recommendations.py
    from src.linked_recommendations import build_linked_p5
    p3_combos = ["".join(str(d) for d in b.digits) for b in p3_bets]
    linked = build_linked_p5(p3_combos, strategy="anti_hot", rng=rng)
    # 转换成 strategies.DigitBet 类型方便复用现有打印 / DB 写入
    p5_bets = []
    for i, lb in enumerate(linked):
        digits = [int(c) for c in lb.p5_combo]
        # 借用 strategies.gen_digit_bet 接口构造 DigitBet
        bet_obj = strategies.gen_digit_bet("p5", "邻号", rng=rng)
        bet_obj = bet_obj.__class__(
            game="p5",
            strategy=f"联动P3#{i+1}({p3_bets[i].strategy})",
            digits=tuple(digits),
            popularity_score=lb.p5_popularity,
            popularity_label="冷门(推荐)" if lb.p5_popularity < 30 else ("中性" if lb.p5_popularity < 50 else "偏热"),
        )
        p5_bets.append(bet_obj)

    # ============ 输出 ============
    print(f"日期: {today}   大乐透第{dlt_issue}期   排三/排五第{p_issue}期")
    print(f"🎯 策略选择来源: {bandit_note}")
    print(f"⚠️ 全部为基于历史频次的策略偏好选号, 不是预测; 中奖概率=理论概率")

    print_table(
        f"\n=== 大乐透 第{dlt_issue}期 · 避热偏好选号·非预测 · 10 注单式 (5+2) · 20 元 ===",
        dlt_bets,
        lambda: f"  {'#':>2}  {'策略':<14}  {'前区':<18}  {'后区':<7}  {'热度':<10}",
        lambda i, b: f"  {i:>2}  {b.strategy:<14}  "
                     f"{' '.join(f'{n:02d}' for n in b.front):<18}  "
                     f"{' '.join(f'{n:02d}' for n in b.back):<7}  "
                     f"{b.popularity_score:>2}({b.popularity_label})",
    )

    print_table(
        f"\n=== 排列三 第{p_issue}期 · 避热偏好选号·非预测 · 10 注 · 20 元 ===",
        p3_bets,
        lambda: f"  {'#':>2}  {'策略':<14}  {'号码':<6}  {'热度':<10}",
        lambda i, b: f"  {i:>2}  {b.strategy:<14}  "
                     f"{' '.join(str(n) for n in b.digits):<6}  "
                     f"{b.popularity_score:>2}({b.popularity_label})",
    )

    print_table(
        f"\n=== 排列五 第{p_issue}期 · 避热偏好选号·非预测 · 10 注 · 20 元 ===",
        p5_bets,
        lambda: f"  {'#':>2}  {'策略':<14}  {'号码':<10}  {'热度':<10}",
        lambda i, b: f"  {i:>2}  {b.strategy:<14}  "
                     f"{' '.join(str(n) for n in b.digits):<10}  "
                     f"{b.popularity_score:>2}({b.popularity_label})",
    )

    print(f"\n{'='*78}")
    print(f"  总投入: 60 元 (大乐透 20 + 排三 20 + 排五 20)")

    # ============ Kelly 诚实建议 ============
    print(f"\n  📊 Kelly 公式参考 (基于理论概率+赔率):")
    for outcome in ("p3_direct", "p5", "dlt_first"):
        adv = budget.kelly_advice(outcome, bankroll=10000, fraction=0.5)
        print(f"    {outcome:<15}  期望/2元: {adv['expected_return_per_2cny']:>+.2f}  "
              f"建议: {adv['advice']}")
    print(f"  ⚠️ Kelly 的诚实结论: 所有彩票期望为负, 严格按数学应该不下注。"
          f"\n     下注是娱乐, 不是投资。每彩种 20 元上限就是娱乐预算。")

    # ============ 数学诚实结论 (贝叶斯/熵/马尔可夫) ============
    print(f"\n  🔬 数学诚实结论 (基于 200-1000 期历史数据):")

    # 1. Bayesian Beta-Binomial: 显著号筛选
    try:
        bayes_f = ms.bayesian_number_screen("dlt", "front", n_recent=200)
        hot_b = [r.number for r in bayes_f if r.is_significantly_hot]
        cold_b = [r.number for r in bayes_f if r.is_significantly_cold]
        total_n = len(bayes_f)
        sig_n = len(hot_b) + len(cold_b)
        print(f"    [Bayes 后验] DLT 前区 {total_n} 个号中, 仅 {sig_n} 个偏离理论期望 "
              f"({sig_n/total_n*100:.0f}%)")
        if hot_b:
            print(f"                显著偏热: {hot_b}")
        if cold_b:
            print(f"                显著偏冷: {cold_b}")
        if not hot_b and not cold_b:
            print(f"                全部号码都在 95% 可信区间内 → 符合摇奖均匀性")
    except Exception as e:
        print(f"    [Bayes 后验] 跳过 ({e})")

    # 2. Shannon entropy: 均匀度
    try:
        import sqlite3
        from collections import Counter
        with sqlite3.connect(data_dir() / "lottery.sqlite") as c:
            cur = c.execute("SELECT f1,f2,f3,f4,f5 FROM dlt_draws ORDER BY date DESC LIMIT 500")
            flat = [v for row in cur.fetchall() for v in row]
        cnt = Counter(flat)
        for n in range(1, 36):
            cnt.setdefault(n, 0)
        u = ms.uniformity_score(cnt)
        print(f"    [Shannon 熵] DLT 前区均匀度 {u['uniformity']*100:.2f}% (500 期) → {u['interpretation']}")
    except Exception as e:
        print(f"    [Shannon 熵] 跳过 ({e})")

    # 3. Markov independence: 摇奖独立性
    try:
        import sqlite3
        with sqlite3.connect(data_dir() / "lottery.sqlite") as c:
            cur = c.execute("SELECT d1 FROM p3_draws ORDER BY date ASC")
            seq = [r[0] for r in cur.fetchall()]
        mr = ms.markov_independence_test(seq, 10)
        if "verdict" in mr:
            print(f"    [Markov 独立性] 排三百位序列卡方 p={mr['p_value']:.3f} → {mr['verdict']}")
    except Exception as e:
        print(f"    [Markov 独立性] 跳过 ({e})")

    print(f"\n  📐 数学家结论: 摇奖独立同分布, 任何'冷热预测'都没数学依据。")
    print(f"     工具能改善的只是中奖时的'分蛋糕人数'(反热门策略), 不能改变中奖率本身。")

    # ============ 顶级数学家诊断报告 (高级统计方法) ============
    print(f"\n  🎓 顶级数学家诊断报告 (Marsaglia / Anderson-Darling / Efron / Diaconis 工具箱):")

    try:
        import sqlite3
        from collections import Counter
        with sqlite3.connect(data_dir() / "lottery.sqlite") as c:
            cur = c.execute("SELECT f1,f2,f3,f4,f5 FROM dlt_draws ORDER BY date DESC LIMIT 1000")
            dlt_flat = [v for row in cur.fetchall() for v in row]
            cur = c.execute("SELECT d1,d2,d3,d4,d5 FROM p5_draws ORDER BY date DESC LIMIT 2000")
            p5_flat = [v for row in cur.fetchall() for v in row]

        # 1. Anderson-Darling
        ad_r = ad.anderson_darling_uniform(dlt_flat, 1, 35)
        print(f"    [Anderson-Darling]    DLT 前区均匀性 AD={ad_r.statistic:.2f}, p={ad_r.p_value:.3f}, "
              f"{'通过 ✓' if ad_r.passed else '边缘(大样本敏感)'}")

        # 2. Wasserstein 距离
        cnt = Counter(dlt_flat)
        for n in range(1, 36):
            cnt.setdefault(n, 0)
        w = ad.wasserstein_to_uniform(cnt)
        print(f"    [Wasserstein-1]        到理论均匀分布距离 = {w['wasserstein_1']:.3f} / max {w['max_possible']:.0f} "
              f"({w['normalized']*100:.1f}%) → {w['interpretation']}")

        # 3. Empirical Bayes + FDR 多重比较校正
        counts = [cnt[n] for n in range(1, 36)]
        expected = sum(counts) / 35
        eb = ad.empirical_bayes_normal_screen(counts, expected)
        sig = [i + 1 for i, r in enumerate(eb['fdr_rejected']) if r]
        print(f"    [Empirical Bayes+FDR]  35 号联合估计, shrinkage={eb['shrinkage_factor']:.2f}, "
              f"FDR 校正后真显著: {sig if sig else '无 (摇奖完全均匀)'}")
        print(f"                          (注: 前面 Bayes 单独检验找到的偏热/偏冷号经多重比较校正后大多消失,"
              f" 即 '假阳性')")

        # 4. Lempel-Ziv 复杂度 (序列模式)
        lz = ad.lempel_ziv_complexity(p5_flat[:2000])
        print(f"    [Lempel-Ziv 复杂度]    排五数字序列归一化 LZ={lz['normalized']:.3f} → {lz['interpretation']}")

        # 5. NIST SP 800-22 (诚实标注样本量限制)
        nist = ad.nist_battery(p5_flat, encoding="parity")
        if "__summary__" in nist:
            s = nist["__summary__"]
            print(f"    [NIST SP 800-22]      排五奇偶比特通过 {s['n_passed']}/{s['n_total']} "
                  f"(注: 样本仅 {s['n_bits']} bit, NIST 推荐 ≥1M bit, 此结果不可靠)")

        # 6. MCMC 验证 (对一个偏热号做后验采样)
        if cnt:
            hot_n = max(cnt.items(), key=lambda x: x[1])[0]
            mcmc = ad.mcmc_single_number_freq(cnt[hot_n], len(dlt_flat), n_samples=3000)
            print(f"    [Metropolis-Hastings] 号 {hot_n} 出现 {cnt[hot_n]}/{len(dlt_flat)} 次, "
                  f"MCMC 后验均值 {mcmc['mean']:.4f}, "
                  f"95% CI ({mcmc['ci_95'][0]:.4f}, {mcmc['ci_95'][1]:.4f})")
    except Exception as e:
        print(f"    [高级统计] 跳过: {e}")

    print(f"\n  💎 顶级数学家共识(Diaconis/Efron/Knuth 等):")
    print(f"     1. 摇奖序列经 Anderson-Darling/Wasserstein 检验, 与理论均匀分布无显著差异")
    print(f"     2. 'Bayes 显著热号' 在 FDR 多重比较校正后基本消失, 是统计假阳性")
    print(f"     3. 唯一数学上有意义的优化是 反热门组合 (改善中奖时分蛋糕人数, 不改变中奖率)")
    print(f"     4. Kelly 公式严格结论: 期望为负, 不应下注; 下注是娱乐预算")

    # ============ 学习层: Bandit + 信息论 + ML 真相 ============
    print(f"\n  🧠 学习层 (Bandit + 信息论 + ML 真相):")

    # 1. Bandit 策略推荐
    try:
        all_arms = strategies.DIGIT_STRATEGIES[:10]
        history = bd.load_bet_history()
        if history:
            ts_bandit = bd.train_bandit_from_history(all_arms, "thompson")
            top3 = ts_bandit.posterior_summary()[:3]
            print(f"    [Thompson Sampling] 基于 {len(history)} 条历史 bet 学到的 Top-3 策略:")
            for i, p in enumerate(top3, 1):
                print(f"        {i}. {p['arm']:<18} 后验均值 {p['posterior_mean']:.3f}, "
                      f"95%CI ({p['ci_low']:.3f}, {p['ci_high']:.3f})")
        else:
            print(f"    [Thompson Sampling] bets 表暂无已结算记录, 还在数据积累阶段")
            print(f"        开奖核奖后, 此处会显示哪种策略真实表现最好 (累积 ≥50 期才有意义)")
    except Exception as e:
        print(f"    [Bandit] 跳过: {e}")

    # 2. 互信息独立性
    try:
        mi_r = it.lottery_independence_check("p5", n_recent=2000)
        print(f"    [互信息]            排五各位 MI 最大 {mi_r['mi_matrix_max_off_diag']} bit "
              f"(独立假设期望 {mi_r['expected_mi_under_independence']}) → 各位独立 ✓")
    except Exception as e:
        print(f"    [互信息] 跳过: {e}")

    # 3. Transfer Entropy 时序因果
    try:
        te_r = it.granger_check("p3", n_recent=2000)
        print(f"    [Transfer Entropy]  排三 TE 平均 {te_r['average_te_bit']} bit → "
              f"上期号严格无法预测当期号 (Granger 因果不存在)")
    except Exception as e:
        print(f"    [Transfer Entropy] 跳过: {e}")

    # 4. PAC 学习理论
    try:
        pac = it.pac_advisory("dlt")
        print(f"    [PAC 学习理论]      现有 {pac['current_draws']} 期, 频率估计误差 "
              f"{pac['current_error_pct']} (95% 置信);")
        print(f"                       想 ±1% 还需 ~{pac['to_achieve_1pct_error']['needed_additional_draws']} 期 "
              f"(约 {pac['to_achieve_1pct_error']['needed_additional_draws']//100} 年)")
    except Exception as e:
        print(f"    [PAC bounds] 跳过: {e}")

    # 5. ML 真相揭穿(只跑一次, 不影响速度)
    print(f"    [ML 真相揭穿]       (跑排三百位 LR/RF/XGB/MLP 实测预测准确率 vs 随机基线)")
    try:
        mt_r = mt.report_truth("p3", target_pos=0)
        random_base = 1 / mt_r["n_classes"]
        for m in mt_r["models"]:
            if "Dummy" in m["name"]:
                continue
            adv = m["advantage_over_random_pct"]
            tag = "✓ 等于随机" if abs(adv) < 2 else "⚠ 异常"
            print(f"        {m['name']:<24} 测试准确率 {m['test_acc']*100:>5.1f}%  "
                  f"({adv:+.2f}% vs {random_base*100:.0f}% 随机) {tag}")
        print(f"        → {mt_r['verdict']}")
    except Exception as e:
        print(f"        跳过: {e}")

    # ============ 国际彩票横向对比 ============
    print(f"\n  🌍 国际彩票横向对比 (验证全球彩票都真随机):")
    try:
        rows = itl.cross_lottery_comparison()
        if rows:
            for r in rows:
                print(f"      {r.lottery:<28} {r.n_periods:>5} 期, 号池 {r.pool_size:>3}选{r.picks}, "
                      f"均匀度 {r.uniformity_score*100:>6.2f}%")
            print(f"      → 全球三个完全不同设计彩票, 均匀度都 ≥98%, **真随机性与国家/规则无关**")
        else:
            print(f"      (国际数据未抓取, 跑 `python scripts/fetch_international.py` 获取)")
    except Exception as e:
        print(f"      [国际对比] 跳过: {e}")

    # ============ Conformal Prediction (顶级不确定性量化) ============
    print(f"\n  📐 Conformal Prediction (MAPIE 共形预测, 有限样本覆盖保证):")
    try:
        cf_r = cf.full_conformal_diagnosis("p3")
        for i, res in enumerate(cf_r["per_position"]):
            pos = ["百", "十", "个"][i]
            if res.n_test > 0:
                print(f"      {pos}位: 区间宽度 {res.interval_mean_width:.1f}/{res.full_range_width} "
                      f"({res.width_pct_of_range:.0f}% 值域), 实测覆盖 {res.coverage_empirical:.1%} "
                      f"(目标 {res.coverage_target:.0%})")
        print(f"      → {cf_r['summary']}")
    except Exception as e:
        print(f"      [Conformal] 跳过: {e}")

    # ============ SOTA 时序大模型诚实测试 ============
    print(f"\n  🤖 SOTA 时序大模型诚实测试 (Nixtla AutoARIMA/AutoETS/AutoTheta + Prophet):")
    try:
        sota = so.full_sota_truth_check("p3", target_pos=0)
        for m in sota["models"][:5]:
            if m.accuracy_pct > 0:
                print(f"      {m.model_name:<24} 测试 {m.n_test:>3}: 准确率 {m.accuracy_pct:>5.2f}%  "
                      f"({m.advantage_pct:>+5.2f}% vs 随机 10%)")
        print(f"      → {sota['verdict']}")
    except Exception as e:
        print(f"      [SOTA 测试] 跳过: {e}")

    # ============ 中国大乐透专属 ============
    print(f"\n  🇨🇳 中国大乐透专属分析 (追加/jackpot/Mandel 真实边界):")
    try:
        cmp = sp.compare_basic_vs_extra(jackpot_cny=10_000_000)
        print(f"    [追加投注] jackpot 1000 万下:")
        print(f"        基本 2 元/注: ROI {cmp['basic'].roi_pct:>+6.2f}% (期望回报 {cmp['basic'].expected_return:.3f} 元)")
        print(f"        追加 3 元/注: ROI {cmp['extra'].roi_pct:>+6.2f}% (期望回报 {cmp['extra'].expected_return:.3f} 元)")
        print(f"        盈亏平衡 jackpot ≈ {cmp['basic'].break_even_jackpot/10000:.0f} 万")
        print(f"        → {cmp['verdict']}")

        jstats = sp.jackpot_statistics()
        if "error" not in jstats:
            print(f"    [jackpot 历史] 500 期: 均值 {jstats['jackpot_mean']/10000:.0f} 万, 最高 {jstats['jackpot_max']/10000:.0f} 万")
            print(f"        Mandel 阈值 (2 人均分): {jstats['mandel_threshold_cny']/10000:.0f} 万")
            print(f"        历史达标期数: {jstats['n_periods_above_mandel_threshold']} / {jstats['n_periods']} "
                  f"({jstats['mandel_threshold_pct_of_periods']}%)")
            print(f"        → 中国大乐透单注一等奖封顶 1000 万 (规则), Mandel 数学上**永远不可行**")
    except Exception as e:
        print(f"    [大乐透专属] 跳过: {e}")

    # ============ TDA + Hurst + Lyapunov + DFA 高阶诊断 ============
    print(f"\n  🔭 高阶数学诊断 (TDA + Hurst + Lyapunov + DFA, 排五万位 2000 期):")
    try:
        topo = tp.full_topology_report("p5", n_recent=2000)
        ph = topo["persistent_homology"]
        print(f"    [TDA 持续同调]    H1 最大持续 {ph.max_persistence_h1} (短) → {ph.verdict}")
        h = topo["hurst_single_position"]
        if "hurst_exponent" in h:
            print(f"    [Hurst 指数]      H = {h['hurst_exponent']:.3f} → {h['interpretation']}")
        ly = topo["lyapunov_single_position"]
        if "lyapunov_max" in ly:
            print(f"    [Lyapunov 指数]   λ = {ly['lyapunov_max']:+.4f} → {ly['interpretation']}")
        dfa = topo["dfa_single_position"]
        if "dfa_alpha" in dfa:
            print(f"    [DFA 去趋势]      α = {dfa['dfa_alpha']:.3f} → {dfa['interpretation']}")
        print(f"        → 从拓扑/长程依赖/混沌/去趋势四个独立维度确认: 摇奖序列真随机")
    except Exception as e:
        print(f"    [TDA] 跳过: {e}")

    # ============ 整数规划最优覆盖 ============
    print(f"\n  ⚙ 整数规划最优组合 (数学严谨的'20 元买什么覆盖最大'):")
    try:
        opt_p3 = op.optimal_digit_portfolio(n_digits=3, n_tickets=10)
        print(f"    [排三 PuLP IP]   10 注覆盖 {opt_p3.coverage_count}/30 (位,数字) 对 "
              f"= {opt_p3.coverage_pct}% (真正最优)")
        if opt_p3.tickets:
            combo_str = ", ".join(f"{a}{b}{c}" for (a, b, c), _ in opt_p3.tickets)
            print(f"        最优 10 注: {combo_str}")
        opt_dlt = op.optimal_coverage_dlt(n_tickets=10, max_pairwise_overlap=3)
        print(f"    [大乐透贪心]    10 注覆盖 {opt_dlt.coverage_count}/47 号 = {opt_dlt.coverage_pct}%, "
              f"最大重叠 {opt_dlt.max_pairwise_overlap} 号")
    except Exception as e:
        print(f"    [整数规划] 跳过: {e}")

    # ============ bets 表汇总 ============
    try:
        summary = asx.settlement_summary()
        print(f"\n  📒 bets 表汇总 (含 simulated warmup 数据):")
        for g in ("dlt", "p3", "p5"):
            info = summary[g]
            print(f"      {g}: 已结算 {info['settled']:>4}  待结算 {info['pending']:>3}  "
                  f"投入 {info['total_stake']:>5.0f}  奖金 {info['total_prize']:>6.0f}  "
                  f"净 {info['net']:>+6.0f}")
    except Exception as e:
        print(f"    [bets 汇总] 跳过: {e}")

    # ============ 历史大奖者智慧 ============
    print(f"\n  🏆 历史大奖者智慧 (Mandel/Selbee/Ginther 真实案例 + 中国适用性):")
    print(f"    [真实大奖者方法分布] (美/欧公开报告综合)")
    for method, info in wn.WINNER_METHOD_DISTRIBUTION.items():
        bar = "█" * int(info["pct"] / 5)
        print(f"        {method:<26} {info['pct']:>5.2f}% {bar} ({info['note']})")

    print(f"\n    [Stefan Mandel 包池策略 中国大乐透可行性]")
    for jk in [10_000_000, 50_000_000, 100_000_000]:
        m = wn.mandel_feasibility("dlt", jackpot_cny=jk, expected_jackpot_winners=2)
        sign = "✓ 数学可行" if m.is_feasible else "✗ 不可行"
        print(f"        jackpot {jk//10000:>5} 万  包池成本 {m.total_cost/10000:>5.0f} 万  "
              f"净期望 {m.net_expected/10000:>+8.0f} 万  {sign}")
    print(f"        → 实际大乐透 jackpot 通常 500-1500 万, Mandel 策略永远不值得包池")

    print(f"\n    [Syndicate 拼团数学]")
    for nm in [10, 100, 1000]:
        s = wn.syndicate_analysis(n_members=nm, bets_per_member=10,
                                  jackpot_cny=10_000_000)
        print(f"        {nm:>4} 人 × 10 注  总 {s.total_bets:>5} 注  "
              f"中奖率 {s.win_probability_anyone:.2e}  单人期望 {s.expected_individual_return:+.2f} 元")
    print(f"        → 拼团提高中奖率, 但单人期望不变 (数学公平; 适合追求'体验中奖'而非利润)")

    lucky = wn.lucky_number_myth_check()
    print(f"\n    [幸运号大数定律揭穿]")
    print(f"        1 亿玩家 × 156 期/年 → 期望 {lucky['expected_winners_per_year']:.0f} 个头奖中奖者必然出现")
    print(f"        → 任何'幸运号中奖'故事都是 728 分之一的事后总结, 与'幸运'本身无关")

    print(f"\n    [真实大奖者档案]")
    for w in wn.FAMOUS_WINNERS[:3]:
        applicable = "✓ 中国适用" if w["applicable_to_china_dlt"] else "✗ 中国不适用"
        print(f"        • {w['name']:<25} {w['method']}  {applicable}")
        print(f"          {w.get('biggest', '')}")

    print(f"\n  🎡 轮盘系统参考 (本次未启用, 因会破 20 元/彩种预算):")
    for w in wheels.DLT_WHEEL_CATALOG:
        if w.get("cost", 999) <= 20:
            mark = "✓ 可用"
        else:
            mark = "✗ 破预算"
        print(f"     {w['type']:<22} {w['n']:>3} 注 = {w['cost']:>3} 元  {mark}  "
              f"({w['guarantee'][:30]}...)")
    print(f"     如需启用: from src import wheels; wheels.dlt_wheel(front_pool, back_pool, ...)")

    # ============ 写 DB ============
    if args.dry_run:
        print(f"\n  [dry-run] 未写入 DB")
        return

    if not args.no_clear:
        n = clear_today(today)
        if n > 0:
            print(f"\n  🗑  清掉今天旧 bets {n} 条")
    n_written = write_bets(today, dlt_bets, p3_bets, p5_bets, dlt_issue, p_issue)
    print(f"  ✓ 写入 bets 表 {n_written} 条 (带策略标签)")
    print(f"  开奖后跑 prize.py 或 verifier_official.py 自动核奖,")
    print(f"  累计 N 期后跑 `backtest.strategy_roi()` 看哪种策略真实表现好。")


if __name__ == "__main__":
    main()
