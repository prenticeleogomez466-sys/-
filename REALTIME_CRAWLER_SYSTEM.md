# 足球实时爬虫闸门

目标：每次生成推荐前，必须先实时抓取官方足球数据源，并生成可审计的“数据源闸门”证明；没有证明、证明失败或证明过期，都不允许生成正式推荐。

## 默认数据源

- 中国体彩网竞彩足球计算器：竞彩足球赛程、胜平负、让球胜平负、比分、半全场、赔率历史。
- 竞彩网赛事公告：竞彩开售/停售公告。
- 竞彩网传统足彩公告：14场胜负彩期号和 14 场官方对阵。
- 外部免费赔率/API：作为补强源；没有配置时，系统只允许 `--allow-missing-odds` 的降级模式。

## 核心命令

- `npm run crawler:realtime -- --date=YYYY-MM-DD`：实时抓取、同步赛程/市场、生成闸门。
- `npm run crawler:realtime -- --date=YYYY-MM-DD --allow-missing-odds --no-external-odds`：只用中国官方公开源生成闸门。
- `npm run crawler:realtime:strict -- --date=YYYY-MM-DD`：要求外部赔率和全量赔率覆盖，失败即阻断。
- `npm run daily -- --date YYYY-MM-DD`：正式生成，会先跑实时爬虫闸门。
- `npm run daily:allow-missing -- --date YYYY-MM-DD`：允许外部赔率缺口，但仍强制实时抓取官方源。

## 硬规则

- 正式生成禁止直接 `--no-web`；如需离线演示，必须显式使用 `--offline-demo`。
- `data/fixtures/YYYY-MM-DD.json` 必须来自本次 `china-official-web` 同步。
- 竞彩足球必须有本次抓取的实时赔率快照。
- 14场必须识别完整 14 场官方对阵。
- 闸门默认 `30` 分钟过期，可用 `SOURCE_GATE_MAX_AGE_MINUTES` 调整。
- 如设置 `SOURCE_GATE_REQUIRE_FULL_ODDS=1`，全量赔率缺失会直接阻断生成。

## 输出文件

- `data/crawler/realtime-source-YYYY-MM-DD.json`
- `data/exports/realtime-source-gate-YYYY-MM-DD.json`
- `data/exports/realtime-source-gate-YYYY-MM-DD.md`
