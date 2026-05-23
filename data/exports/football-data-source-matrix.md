# 足球数据源矩阵（默认免费模式）

生产状态：通过

| 数据源 | 层级 | 凭据 | 默认免费 | 状态 | 下一步 |
|---|---|---|---|---|---|
| 中国体彩网竞彩足球计算器（公开官方源） | fixtures-jingcai, odds-win-draw-loss, odds-handicap-win-draw-loss, score-odds, half-full-odds | ok | 是 | connected | 已接入免费模式每日健康检查 |
| 竞彩网传统足彩公告（14场官方源） | fixtures-shengfucai, issue-14, announcement | ok | 是 | connected | 已接入免费模式每日健康检查 |
| 竞彩网赛事公告（竞彩开售停售） | sales-window, bulletin | ok | 是 | connected | 已接入免费模式每日健康检查 |
| The Odds API 免费层 | odds-european, odds-asian | missing-env | 是 | connected | 配置 ODDS_API_KEY |
| Odds-API.io 免费层 | odds-european, odds-asian | missing-env | 是 | connected | 配置 ODDS_API_IO_KEY |
| API-Football 免费层 | fixtures, results, odds | missing-env | 是 | connected | 配置 API_FOOTBALL_KEY |
| football-data.org 免费层 | fixtures, results | missing-env | 是 | connected | 配置 FOOTBALL_DATA_ORG_TOKEN |
| football-data.co.uk 免费 CSV | historical-results, historical-odds | ok | 是 | connected | 已接入免费模式每日健康检查 |
| ClubElo 公共评级 | team-elo, team-strength | ok | 是 | connected | 已接入免费模式每日健康检查 |
| Open-Meteo 免费天气 | weather, geo-coding | ok | 是 | connected | 已接入免费模式每日健康检查 |
| GDELT DOC 新闻检索 | news, motivation-signal | ok | 是 | connected | 已接入免费模式每日健康检查 |
| OpenLigaDB 免费公开 API | fixtures, results, germany-leagues | missing-env | 是 | candidate | 配置 OPENLIGADB_ENABLED |
| ScoreBat 免费视频/资讯 API | match-videos, news-context | missing-env | 是 | candidate | 配置 SCOREBAT_ENABLED |
| StatsBomb Open Data | historical-events, historical-xg, model-training | missing-env | 是 | candidate | 配置 STATSBOMB_OPEN_DATA_ENABLED |
| openfootball GitHub 公共数据 | historical-fixtures, historical-results | missing-env | 是 | candidate | 配置 OPENFOOTBALL_DATA_ENABLED |
| 授权伤停 JSON 源 | injuries | missing-env | 是 | connected | 配置 INJURY_SOURCE_URL |
| 授权首发 JSON 源 | lineups | missing-env | 是 | connected | 配置 LINEUP_SOURCE_URL |
| 授权 xG JSON 源 | xg, shot-quality | missing-env | 是 | connected | 配置 XG_SOURCE_URL |
| 自有免费 JSON/CSV 赔率源 | odds-european, odds-asian, odds-handicap | missing-env | 是 | connected | 配置 ODDS_JSON_URL 或 ODDS_CSV_URL |
