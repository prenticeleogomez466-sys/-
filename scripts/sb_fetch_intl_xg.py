# -*- coding: utf-8 -*-
"""
国家队事件级 xG 桥接 — 从 StatsBomb 开放数据(免费,无反爬)抓世界杯/欧洲杯射门级 xG,
聚合到【每场队级 xG for/against】+【每队汇总画像】,落 CSV/JSON 供 Node 模型读取。

为什么不用 soccerdata/FBref:本机(数据中心 IP)FBref 被 Cloudflare 403 挡;
  StatsBomb 开放数据是 GitHub 公开 JSON,零反爬,且是真【射门级 xG】(比 FBref 聚合值更底层)。
覆盖:有 xG 的现代大赛(WC2018/WC2022 + Euro2020/Euro2024 若开放)。
输出:
  data/soccerdata-bridge/intl-team-xg-matches.csv   每场每队 xg_for/xg_against/goals/shots
  data/soccerdata-bridge/intl-team-xg-summary.json  每队跨赛汇总(场均xG/净xG/临门质量finishing)
用法: python scripts/sb_fetch_intl_xg.py
"""
import os, json, warnings
warnings.filterwarnings("ignore")
from statsbombpy import sb
import pandas as pd

OUTDIR = r"D:\football-model-data\soccerdata-bridge"  # 对齐 getDataSubdir(D盘数据目录)
os.makedirs(OUTDIR, exist_ok=True)

# (赛事名, competition_id, season_id) —— 仅取有 xG 的现代大赛
TOURNAMENTS = [
    ("WorldCup-2022", 43, 106),
    ("WorldCup-2018", 43, 3),
    ("Euro-2024", 55, 282),
    ("Euro-2020", 55, 43),
]

def fetch_tournament(name, comp, season):
    try:
        matches = sb.matches(competition_id=comp, season_id=season)
    except Exception as e:
        print(f"  [skip] {name}: matches 失败 {type(e).__name__}")
        return []
    rows = []
    for _, m in matches.iterrows():
        mid = int(m["match_id"])
        try:
            ev = sb.events(match_id=mid)
        except Exception as e:
            print(f"    [skip match {mid}] {type(e).__name__}")
            continue
        if "shot_statsbomb_xg" not in ev.columns:
            continue
        shots = ev[ev["type"] == "Shot"]
        xg_by_team = shots.groupby("team")["shot_statsbomb_xg"].sum().to_dict()
        ht, at = m["home_team"], m["away_team"]
        hs, as_ = int(m["home_score"]), int(m["away_score"])
        sh_by_team = shots.groupby("team").size().to_dict()
        for team, opp, gf, ga in [(ht, at, hs, as_), (at, ht, as_, hs)]:
            rows.append({
                "tournament": name, "date": str(m.get("match_date", "")), "match_id": mid,
                "team": team, "opponent": opp,
                "xg_for": round(float(xg_by_team.get(team, 0.0)), 3),
                "xg_against": round(float(xg_by_team.get(opp, 0.0)), 3),
                "goals_for": gf, "goals_against": ga,
                "shots_for": int(sh_by_team.get(team, 0)),
            })
    print(f"  {name}: {len(matches)} 场 → {len(rows)} 队场记录")
    return rows

def main():
    allrows = []
    for name, comp, season in TOURNAMENTS:
        allrows += fetch_tournament(name, comp, season)
    if not allrows:
        print("无数据,退出"); return
    df = pd.DataFrame(allrows)
    csv = os.path.join(OUTDIR, "intl-team-xg-matches.csv")
    df.to_csv(csv, index=False, encoding="utf-8")
    print("SAVED:", csv, df.shape)

    # 每队跨赛汇总画像
    g = df.groupby("team")
    summary = {}
    for team, sub in g:
        n = len(sub)
        summary[team] = {
            "matches": n,
            "xgForPerGame": round(sub["xg_for"].mean(), 3),
            "xgAgainstPerGame": round(sub["xg_against"].mean(), 3),
            "xgDiffPerGame": round((sub["xg_for"] - sub["xg_against"]).mean(), 3),
            "goalsForPerGame": round(sub["goals_for"].mean(), 3),
            # 临门质量:实际进球 − 期望进球(>0=把握机会好/运气;<0=浪费机会)
            "finishingPerGame": round((sub["goals_for"] - sub["xg_for"]).mean(), 3),
            "tournaments": sorted(sub["tournament"].unique().tolist()),
        }
    js = os.path.join(OUTDIR, "intl-team-xg-summary.json")
    with open(js, "w", encoding="utf-8") as f:
        json.dump({"source": "StatsBomb Open Data (free, event-level xG)",
                   "note": "国家队大赛射门级 xG 聚合;小样本(每队 3-7 场/届),作独立强度交叉验证非命中率保证",
                   "asOf": str(df["date"].max()), "teams": summary}, f, ensure_ascii=False, indent=1)
    print("SAVED:", js, f"{len(summary)} 队")
    # 打印 xG 净值前 12(强度榜)
    top = sorted(summary.items(), key=lambda kv: kv[1]["xgDiffPerGame"], reverse=True)[:12]
    print("\n净 xG/场 前12(事件级强度):")
    for t, v in top:
        print(f"  {t:18} 净xG {v['xgDiffPerGame']:+.2f}  攻 {v['xgForPerGame']:.2f} 防 {v['xgAgainstPerGame']:.2f}  临门 {v['finishingPerGame']:+.2f} ({v['matches']}场)")

if __name__ == "__main__":
    main()
