# 中国网站数据源自动读取

本项目默认读取公开、稳定、可自动化的中国官方网页源，不绕过登录、验证码、付费墙或安全拦截。

## 已接入源

- `中国体彩网竞彩足球计算器`：读取竞彩足球受注赛程、胜平负、让球胜平负、比分、半全场和赔率历史。
- `竞彩网赛事公告`：读取竞彩开售/停售公告。
- `竞彩网传统足彩公告`：读取 14 场胜负彩官方期号和 14 场对阵。
- `500.com`：默认禁用，只作为人工参考；自动化不依赖它。

## 命令

- `npm run china:sources -- --date=2026-05-14`：读取并生成数据源分析。
- `npm run china:sources:sync -- --date=2026-05-14`：读取后同步到 `data/fixtures` 和 `data/market`。

## 输出

- `data/china-web/YYYY-MM-DD.json`：原始归一化数据。
- `data/exports/china-web-source-analysis-YYYY-MM-DD.json`：机器审核结果。
- `data/exports/china-web-source-analysis-YYYY-MM-DD.md`：中文数据源分析报告。
