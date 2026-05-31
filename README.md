# lottery-backup

诚实彩票统计分析产出备份(非预测)。

- `scripts/build_coldest20.py` — 每彩种出热度最低20注(全枚举/采样实跑打分,前3位分散)
- `scripts/crowding_index.py` — 热度+推进双指数(direct_winners 百分位)
- `scripts/gen_today.py` — 完整诊断流水线
- `exports/` — 生成的手机网页 + Excel

> 摇奖真随机,本仓库不预测中奖号;"热度最低"仅优化中奖时分蛋糕人数,不提高中奖率。
