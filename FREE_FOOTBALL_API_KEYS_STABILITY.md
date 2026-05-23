# 免费足球 API Key 与每日稳定源方案

## 原则

- 只使用官方注册、免费额度、公开许可的数据源；不使用泄露 Key、共享 Key、盗刷 Key。
- 不做“攻破数据源”、绕过登录/验证码/付费墙/反爬安全策略；这类来源不稳定，也不能进入生产推荐。
- 免费源不能保证每天完整覆盖亚洲盘口，因此正式推荐仍以 `standard:check` 为硬门槛。
- 每天先跑官方赛程与实时赔率闸门，缺源则阻断正式推荐，不降级伪装成完整数据。

## 优先接入

| 优先级 | 数据源 | 用途 | 本地变量 | 说明 |
|---:|---|---|---|---|
| 0 | 中国体彩网公开官方页 | 竞彩赛程、官方开奖、竞彩赔率 | 内置 | 无需 Key，作为中国赛事硬基准 |
| 0 | 新浪胜负彩公开页 | 14 场欧赔、澳盘、欧亚对照 | `SINA_SFC_ODDS_ENABLED=1` | 无需 Key，作为 14 场免费补源 |
| 0 | football-data.co.uk CSV | 欧洲主流联赛历史欧赔/亚盘 | `FOOTBALL_DATA_CO_UK_ENABLED=1` | 无需 Key，适合回测和部分赛前赔率补源 |
| 1 | Odds-API.io | 足球欧赔/盘口补源 | `ODDS_API_IO_KEY` | 优先补亚洲盘口，适合做免费主赔率源 |
| 2 | API-Football/API-Sports | 赛程、赛果、部分赔率 | `API_FOOTBALL_KEY` | 适合作为赛程和赔率备用源 |
| 3 | The Odds API | 欧赔/盘口备用 | `ODDS_API_KEY` | 免费额度有限，按可用联赛做兜底 |
| 4 | football-data.org | 赛程/赛果备用 | `FOOTBALL_DATA_ORG_TOKEN` | 不作为盘口主源 |
| 5 | football-data.co.uk | 历史赔率/回测 | `FOOTBALL_DATA_CO_UK_ENABLED=1` | 免费公开 CSV，偏历史，不是实时盘口 |
| 6 | 自建 JSON/CSV | 你自己的授权聚合源 | `ODDS_JSON_URL`/`ODDS_CSV_URL` | 最稳定，建议把免费源聚合后输出到这里 |

## 新增免费/公开补源

| 数据源 | 用途 | 本地变量 | 状态 |
|---|---|---|---|
| ClubElo | 球队 Elo/强度 | 内置 | 已接入 `advanced:sync` |
| Open-Meteo | 天气、风速、降水 | 内置 | 已接入 `advanced:sync` |
| GDELT DOC | 新闻/战意上下文 | 内置，可用 `GDELT_NEWS_ENABLED=0` 关闭 | 已接入 `advanced:sync` |
| OpenLigaDB | 德语区赛程/赛果补源 | `OPENLIGADB_ENABLED=1` | 候选登记 |
| StatsBomb Open Data | 历史事件、xG 训练/校准 | `STATSBOMB_OPEN_DATA_ENABLED=1` | 候选登记，非实时源 |
| openfootball JSON | 历史赛程/赛果训练 | `OPENFOOTBALL_DATA_ENABLED=1` | 候选登记 |
| ScoreBat Video API | 视频/资讯上下文 | `SCOREBAT_ENABLED=1` | 候选登记，不作为硬预测源 |
| 授权伤停 JSON | 伤停/停赛 | `INJURY_SOURCE_URL` | 已接入口，需真实 URL |
| 授权首发 JSON | 预计/确认首发 | `LINEUP_SOURCE_URL` | 已接入口，需真实 URL |
| 授权 xG JSON | xG/射门质量 | `XG_SOURCE_URL` | 已接入口，需真实 URL |

## 注册入口

- Odds-API.io: https://odds-api.io/pricing/free
- API-Football/API-Sports: https://dashboard.api-football.com/register
- The Odds API: https://the-odds-api.com/
- football-data.org: https://www.football-data.org/client/register
- football-data.co.uk: https://www.football-data.co.uk/
- ClubElo: http://clubelo.com/
- Open-Meteo: https://open-meteo.com/
- GDELT: https://www.gdeltproject.org/
- OpenLigaDB: https://www.openligadb.de/
- StatsBomb Open Data: https://github.com/statsbomb/open-data
- openfootball JSON: https://github.com/openfootball/football.json
- ScoreBat Video API: https://www.scorebat.com/video-api/
- 中国体彩网: https://www.sporttery.cn/
- 新浪彩票: https://lottery.sina.com.cn/

## 已启用的免 Key 源

```env
CHINA_OFFICIAL_WEB_ENABLED=1
SINA_SFC_ODDS_ENABLED=1
FOOTBALL_DATA_CO_UK_ENABLED=1
```

## 写入配置

```powershell
npm run sources:configure -- `
  -OddsApiIoKey "你的_ODDS_API_IO_KEY" `
  -ApiFootballKey "你的_API_FOOTBALL_KEY" `
  -OddsApiKey "你的_ODDS_API_KEY" `
  -FootballDataOrgToken "你的_FOOTBALL_DATA_ORG_TOKEN"
```

## 每日稳定检查

```powershell
npm run credentials:check:live
npm run crawler:realtime:strict -- --date=YYYY-MM-DD
npm run standard:check -- --date=YYYY-MM-DD
```

通过后才允许生成正式推荐；未通过只允许输出缺口报告。
