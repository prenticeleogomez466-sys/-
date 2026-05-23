# 足球大模型能力矩阵 2026-05-23

状态：核心能力可运行
能力：ready=9 / partial=1 / candidate=2

## 能力矩阵
| 层级 | 能力 | 优先级 | 状态 | 就绪度 | 用途 | 下一步 |
|---|---|---|---|---|---|---|
| 数据闸门 | 官方赛程 + 实时赔率硬闸门 | P0 | connected | ready | 阻断陈旧赔率和缺失场次，保证正式推荐先验数据真实可追溯。 | 保持每日闸门、审计和复盘。 |
| 市场赔率 | 欧赔/让球/亚盘/大小球/赔率变化 | P0 | connected | ready | 将赔率隐含概率、盘口变化和冷热方向作为胜平负与爆冷判断核心输入。 | 保持每日闸门、审计和复盘。 |
| 球队强度 | Elo/市场派生强度 | P1 | connected-with-derived-fallback | ready | 用真实 Elo 或市场隐含强度修正基础胜率，降低纯赔率模型对热门方向的偏差。 | 继续寻找授权免费源替换代理特征，并保留代理标识。 |
| 近期状态 | 近况/赛程强度/进失球形态 | P1 | connected-with-derived-fallback | ready | 用于识别状态背离、连续赛程疲劳和赔率未充分反映的状态风险。 | 继续寻找授权免费源替换代理特征，并保留代理标识。 |
| xG/进球模型 | xG、Poisson/Skellam、蒙特卡洛比分 | P1 | connected-with-derived-fallback | partial | 把胜平负概率转换为比分、大小球、半全场路径，并审计比分/半全场不冲突。 | 继续寻找授权免费源替换代理特征，并保留代理标识。 |
| 阵容伤停 | 伤停名单/预计首发/实际首发 | P1 | derived-until-authorized-source | candidate | 真实源可直接影响强弱修正；无真实源时只作为临场复核风险，不冒充真实伤停。 | 继续寻找授权免费源替换代理特征，并保留代理标识。 |
| 战意赛程 | 升降级/杯赛轮换/赛程密度/新闻战意 | P2 | connected-with-heuristic-fallback | ready | 解释爆冷原因，识别保级、升级、欧战席位和杯赛轮换风险。 | 保持每日闸门、审计和复盘。 |
| 环境因素 | 天气/旅行/场地 | P2 | connected-partial | ready | 通过降雨、风速、温度影响节奏、总进球和冷门风险。 | 保持每日闸门、审计和复盘。 |
| 回测校准 | Brier/LogLoss/命中率/复盘闭环 | P0 | connected | ready | 每天复盘胜平负、比分、半全场，长期评估概率校准和模型退化。 | 保持每日闸门、审计和复盘。 |
| 资金风控 | EV/凯利/回撤约束 | P1 | connected-when-enabled | ready | 把推荐和投注资金分离，按 EV、凯利和最大回撤控制风险。 | 启用 BANKROLL_RISK_POLICY=1 后进入正式资金风控。 |
| 可解释性 | 多因素融合判断要点 | P0 | connected | ready | 每场输出爆冷、大小球、战意、阵容、状态、赔率变化和融合结论。 | 保持每日闸门、审计和复盘。 |
| 历史训练集 | 开放历史赛果/赔率/事件数据扩展 | P2 | candidate | candidate | 用于训练更稳定的联赛参数、xG/xT、盘口漂移和赛前冷门模型。 | 按许可证逐个启用候选适配器，先进入回测，不直接进入正式推荐。 |

## 合法公开来源
| 来源 | 地址 | 用途 |
|---|---|---|
| StatsBomb Open Data | https://github.com/statsbomb/open-data | 公开事件级数据，可用于 xG/xT/战术训练与样例验证。 |
| football-data.co.uk | https://www.football-data.co.uk/data | 历史赛果、比赛统计和赔率 CSV，适合回测和联赛状态参数。 |
| ClubElo | http://api.clubelo.com/ | 球队 Elo 强度评级，适合作为长期强弱先验。 |
| Open-Meteo | https://open-meteo.com/en/docs | 无需 key 的天气、地理编码、风雨温度输入。 |
| GDELT DOC API | https://api.gdeltproject.org/api/v2/doc/doc | 新闻与舆情检索，用于战意/突发事件提示。 |
| football-data.org | https://docs.football-data.org/general/v4/coding_client.html | 赛程、球队、积分榜和比赛 JSON API，需免费 token。 |
| The Odds API | https://the-odds-api.com/liveapi/guides/v3/ | h2h、spreads、totals 赔率补源，需 API key。 |
| OpenLigaDB | https://www.openligadb.de/api/ | 德国联赛赛程、比分和积分信息候选源。 |
| ScoreBat | https://www.scorebat.com/video-api/docs/ | 公开视频/资讯候选源，不作为赔率或赛程硬源。 |
