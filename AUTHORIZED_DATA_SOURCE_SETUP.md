# 足球大模型授权数据源接入说明

正式日报必须同时满足：

1. `ODDS_API_KEY`：The Odds API，抓实时欧洲赔率和亚洲盘口。
2. `ODDS_JSON_URL` 或 `ODDS_CSV_URL`：你的自有/授权让球胜平负源，必须含初赔和即时赔。
3. `API_FOOTBALL_KEY`、`FOOTBALL_DATA_ORG_TOKEN` 或 `SPORTMONKS_API_TOKEN`：授权赛程/赛果主源。

## 一键写入凭据

```powershell
npm run sources:configure -- `
  -OddsApiKey "你的ODDS_API_KEY" `
  -OddsJsonUrl "https://你的授权源/market-YYYY-MM-DD.json" `
  -ApiFootballKey "你的API_FOOTBALL_KEY"
```

## 检查与同步

```powershell
npm run credentials:check
npm run credentials:check:live
npm run fixtures:sync -- --date=2026-05-14
npm run market:crawl -- --date=2026-05-14
npm run market:verify -- --date=2026-05-14
npm run daily -- --date 2026-05-14
```

没有真实 Key 或授权源时，正式日报会失败，这是正确行为。
