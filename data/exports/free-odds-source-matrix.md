# 免费赔率数据源矩阵

生成时间：2026-05-24T03:08:52.961Z
默认策略：只用免费源

| 数据源 | 类型 | 环境变量 | 层级 | 免费额度 | 已配置 | 下一步 |
|---|---|---|---|---|---|---|
| API-Football / API-SPORTS 免费层 | free-api-key | API_FOOTBALL_KEY | fixtures, results, odds | 100 requests/day | 否 | 配置 API_FOOTBALL_KEY |
| Odds-API.io 免费层 | free-api-key | ODDS_API_IO_KEY | live-odds, pre-match-odds, moneyline, spreads, totals | 100 requests/hour | 否 | 配置 ODDS_API_IO_KEY |
| The Odds API 免费层 | free-api-key | ODDS_API_KEY | live-odds, pre-match-odds | limited free tier | 否 | 配置 ODDS_API_KEY |
| football-data.co.uk 免费 CSV | free-public-download | FOOTBALL_DATA_CO_UK_ENABLED | historical-results, historical-odds, fixtures-csv, asian-handicap-archive | public CSV downloads | 是 | 已可用于免费模式 |
| ClubElo 公共球队评级 | free-public-api | 无需 | team-elo, team-strength | public CSV-style API | 是 | 已可用于免费模式 |
| Open-Meteo 免费天气 API | free-public-api | 无需 | weather, geo-coding | free for non-commercial/open usage per official terms | 是 | 已可用于免费模式 |
| GDELT DOC 2.1 新闻检索 | free-public-api | 无需 | news, motivation-context | public API | 是 | 已可用于免费模式 |
| OpenLigaDB 免费公开 API | free-public-api | OPENLIGADB_ENABLED | fixtures, results | public API | 否 | 配置 OPENLIGADB_ENABLED |
| StatsBomb Open Data | free-public-download | STATSBOMB_OPEN_DATA_ENABLED | historical-events, historical-xg, model-training | GitHub open data license | 否 | 配置 STATSBOMB_OPEN_DATA_ENABLED |
| openfootball JSON 公共数据 | free-public-download | OPENFOOTBALL_DATA_ENABLED | historical-fixtures, historical-results | GitHub public data | 否 | 配置 OPENFOOTBALL_DATA_ENABLED |
| ScoreBat 免费视频 API | free-public-api | SCOREBAT_ENABLED | match-videos, news-context | public video API | 否 | 配置 SCOREBAT_ENABLED |
| 新浪胜负彩欧洲四大机构公开页 | free-public-web | 无需 | 14场胜负彩, pre-match-odds, odds-european | public web pages | 是 | 已可用于免费模式 |
| Odds1x2 ????? | free-public-web | ODDS1X2_ODDS_ENABLED | pre-match-odds, odds-european, odds-asian | public web pages, polite crawl required | 否 | 配置 ODDS1X2_ODDS_ENABLED |
| 500?????????? | free-public-web | FIVEHUNDRED_SFC_ASIAN_ENABLED | 14????, pre-match-odds, odds-european, odds-asian | public web pages, may throttle requests | 否 | 配置 FIVEHUNDRED_SFC_ASIAN_ENABLED |
| CubeGoal ?????? | free-public-web-api | CUBEGOAL_ODDS_ENABLED | pre-match-odds, odds-asian, totals, match-discovery | public web API, polite crawl required | 是 | 已可用于免费模式 |
| 自有免费 JSON 赔率源 | owned-or-authorized-free-url | ODDS_JSON_URL | odds-european, odds-asian, odds-handicap | 由你自己的授权源决定 | 否 | 配置 ODDS_JSON_URL |
| 自有免费 CSV 赔率源 | owned-or-authorized-free-url | ODDS_CSV_URL | odds-european, odds-asian, odds-handicap | 由你自己的授权源决定 | 否 | 配置 ODDS_CSV_URL |
