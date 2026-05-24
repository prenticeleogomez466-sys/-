# 快速官方数据源优先策略

目标：每天正式推荐先用稳定免费源快速过闸，慢速聚合站只在人工需要时临时启用。

## 默认主源

1. 中国体彩网竞彩足球计算器
   - 用途：竞彩赛程、胜平负、让球胜平负、比分、半全场、赔率历史。
   - 页面：https://www.lottery.gov.cn/jc/jsq/zqspf/
   - 接口：`https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c`

2. 竞彩网传统足彩公告
   - 用途：14 场胜负彩期号、赛程、停售时间。
   - 页面：https://www.sporttery.cn/ctzc/zcgg/

3. 新浪胜负彩公开赔率文章
   - 用途：14 场欧赔、澳盘、欧亚对照兜底。
   - 页面：https://sports.sina.com.cn/l/football/

## 默认禁用慢源

以下源默认禁用，避免每天浪费大量时间：`Odds1x2`、`SGOdds`、`BetExplorer`、`料狗`、`500.com`、`捷报/Nowscore`、`CubeGoal`。

如需临时补盘，可在 `D:\football-model-data\local.env` 把对应 `*_ENABLED` 改为 `1` 后手动运行。

## 默认环境策略

- `FOOTBALL_FAST_OFFICIAL_MODE=1`
- `SOURCE_GATE_REQUIRE_FULL_ODDS=1`
- `SINA_SFC_ODDS_ENABLED=1`
- 慢源默认 `*_ENABLED=0`
- 中国官方源和赔率源超时默认 `8000ms`、重试 `2` 次。

## 当前验证

2026-05-24 测试：严格实时闸门仍为 `39/39` 通过，快源模式耗时约 `2.8s`。
