# -*- coding: utf-8 -*-
"""
为今日推荐的排三/排五计算两个真实指数 (越低越好):
  · 热度指数 popularity_score —— 取自 gen_today 写入 bets 的 note (基于近期出现频率, 0-100)
  · 推进指数 拥挤度        —— 用真实历史"直选中奖注数 direct_winners"估算该号/形态多少人买
                              0-100 = 在全部历史开奖注数里的百分位 (越低=抢的人越少=独中越好)

排三: direct_winners 全量真实 (2005/2005)。某组合若历史出现过, 用其精确平均注数;
      否则回退到同形态(组六/组三/豹子)的历史中位注数。
排五: 注数无逐组合数据, 只能用其"前3位"(=排三组合)的真实注数估算; 后2位按稀释处理,
      因此排五推进指数标注"(基于前3位真实注数)"。

用法: python scripts/crowding_index.py
"""
from __future__ import annotations
import sqlite3, datetime, sys
from collections import defaultdict
from statistics import mean, median
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.config import data_dir

DB = data_dir() / "lottery.sqlite"
TODAY = datetime.date.today().isoformat()


def form(a, b, c):
    s = len({a, b, c})
    return "豹子" if s == 1 else ("组三" if s == 2 else "组六")


def build_p3_model():
    c = sqlite3.connect(DB)
    rows = c.execute("SELECT d1,d2,d3,direct_winners FROM p3_draws WHERE direct_winners IS NOT NULL").fetchall()
    c.close()
    all_dw = sorted(w for *_, w in rows)
    combo_samples = defaultdict(list)
    form_samples = defaultdict(list)
    for a, b, d, w in rows:
        combo_samples[(a, b, d)].append(w)
        form_samples[form(a, b, d)].append(w)
    form_median = {k: median(v) for k, v in form_samples.items()}
    return all_dw, combo_samples, form_median


def percentile(all_sorted, x):
    """x 在 all_sorted 里的百分位 (<=x 的占比 *100)。"""
    import bisect
    return bisect.bisect_right(all_sorted, x) / len(all_sorted) * 100


def estimate_p3(digits, model):
    all_dw, combo_samples, form_median = model
    a, b, d = digits
    samples = combo_samples.get((a, b, d))
    if samples:
        est = mean(samples)
        src = f"该组合历史{len(samples)}次精确均值"
    else:
        est = form_median[form(a, b, d)]
        src = f"{form(a,b,d)}形态历史中位"
    idx = round(percentile(all_dw, est), 1)
    return round(est), idx, src


def fetch_today(game):
    c = sqlite3.connect(DB)
    rows = c.execute("SELECT combo,note FROM bets WHERE game=? AND date=? ORDER BY id", (game, TODAY)).fetchall()
    c.close()
    return rows


def heat_from_note(note):
    # note 形如 "策略|热度40(中性)"
    try:
        seg = note.split("|")[1].replace("热度", "")
        score = int("".join(ch for ch in seg if ch.isdigit()))
        label = seg[seg.find("(") + 1: seg.find(")")] if "(" in seg else ""
        return score, label
    except Exception:
        return None, ""


def main():
    model = build_p3_model()
    print(f"日期 {TODAY} · 期号见下 · 两指数均越低越好 · 推进指数=真实直选注数百分位\n")

    print("=== 排列三 ===")
    print(f"{'#':>2} {'号码':<6} {'策略':<12} {'热度指数':>8} {'推进指数':>8} {'估计注数':>8}  说明")
    for i, (combo, note) in enumerate(fetch_today("p3"), 1):
        digits = tuple(int(x) for x in combo)
        heat, hlabel = heat_from_note(note)
        strat = note.split("|")[0]
        est, idx, src = estimate_p3(digits, model)
        print(f"{i:>2} {combo:<6} {strat:<12} {heat:>5}({hlabel}) {idx:>8} {est:>8}  {src}")

    print("\n=== 排列五 (推进指数基于前3位真实注数) ===")
    print(f"{'#':>2} {'号码':<8} {'策略':<14} {'热度指数':>8} {'推进指数':>8} {'前3注数':>8}")
    for i, (combo, note) in enumerate(fetch_today("p5"), 1):
        front3 = tuple(int(x) for x in combo[:3])
        heat, hlabel = heat_from_note(note)
        strat = note.split("|")[0]
        est, idx, src = estimate_p3(front3, model)
        print(f"{i:>2} {combo:<8} {strat:<14} {heat:>5}({hlabel}) {idx:>8} {est:>8}")


if __name__ == "__main__":
    main()
