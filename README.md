# Football AI Copilot

中文足球大模型落地骨架：授权数据源、赔率硬门槛、竞彩/14场推荐、XLSX 日报、微信发信箱和赛后复盘。

## 核心命令

```powershell
npm run credentials:check
npm run freeodds:audit
npm run sources:configure -- -OddsApiKey 免费TheOddsAPI_Key -OddsApiIoKey 免费OddsAPIIO_Key -ApiFootballKey 免费API_Football_Key
npm run fixtures:sync -- --date=2026-05-14
npm run market:crawl -- --date=2026-05-14
npm run market:verify -- --date=2026-05-14
npm run daily -- --date 2026-05-14
npm run daily:no-web -- --date 2026-05-14
npm run auto:install
npm run auto:health
npm run auto:daily
npm run auto:recap
```

默认只使用免费源：免费 API Key、免费公开 CSV、或你自己的免费授权 JSON/CSV。免费模式默认不强制让球胜平负三类完整赔率；如果你要重新强制三类完整赔率，把 `FREE_MODE_REQUIRE_HANDICAP=1`。

## 自动化定时任务

`npm run auto:install` 会注册 4 个 Windows 定时任务：

- `FootballModel-DailyEvolution`：每天 08:30 自动数据源检查、赛程赛果同步、免费赔率抓取、日报/XLSX/微信。
- `FootballModel-HealthMonitor`：每天 10:00 开始每 3 小时检查一次免费源、凭据、赔率覆盖、微信通道。
- `FootballModel-RecapBacktest`：每天 11:30 同步赛果、回测、刷新复盘总表。
- `FootballModel-WeeklyEvolution`：每周日 12:00 全量测试、免费源矩阵复核、回测复盘。

日志保存在 `data/logs`，最新摘要保存在 `data/exports/automation-*-latest.json`。
