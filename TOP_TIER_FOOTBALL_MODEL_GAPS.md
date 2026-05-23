# 顶级足球模型差距与补齐清单

当前模型已经具备官方赛程、实时赔率闸门、竞彩/14 场分离、比分与半全场一致性校验、14 场定胆限量规则。要接近顶级模型，还必须补齐以下真实数据层，不能用推测值冒充。

## 已补强

- 市场微结构特征：欧赔隐含概率、初赔到即时赔率漂移、亚盘水位与盘口移动、庄家水位偏斜。
- 高级风险标签：大幅赔率漂移、盘口大跳、低概率差、高水位边际、缺比分/半全场赔率。
- 质量分：每场输出 `advancedFeatures.quality`，用于降低置信度和提升风险等级。
- 高级数据同步器：`npm run advanced:sync -- --date=YYYY-MM-DD`，会写入 `data/advanced/YYYY-MM-DD.json`。
- 已接免费公开源：football-data.co.uk 近期状态、ClubElo 球队 Elo、Open-Meteo 天气、GDELT 新闻检索。
- 预测引擎已读取同步层：`recommendFixtures()` 会把当天高级数据传入 `advancedFeatures.external.fixtureData`。
- 顶级就绪审计：`npm run model:top-tier-audit -- --date=YYYY-MM-DD`。

## 接入状态

| 层级 | 当前接入 | 授权兜底入口 | 不补的影响 |
|---|---|---|---|
| 球队强度 | ClubElo 公共 API；可按球队别名匹配 | `TEAM_ELO_SOURCE_URL` | 只能靠赔率反推，缺独立实力基线 |
| 近期状态 | football-data.co.uk CSV；可按联赛和球队别名匹配 | `TEAM_FORM_SOURCE_URL` | 对轮换、疲劳、状态拐点不敏感 |
| 人员信息 | 已接通通用 fixture JSON 入口；无免费稳定权威源时不造数 | `INJURY_SOURCE_URL`、`LINEUP_SOURCE_URL` | 临场阵容变化无法量化 |
| 技战术质量 | 已接通通用 fixture JSON 入口；xG 需要授权数据源 | `XG_SOURCE_URL` | 比分和冷门判断偏盘口驱动 |
| 环境 | Open-Meteo 地理编码+天气预报；可用自有源覆盖 | `WEATHER_SOURCE_URL` | 极端天气/远征影响无法建模 |
| 战意 | GDELT 新闻检索；可用自有源覆盖 | `NEWS_SOURCE_URL` | 保级/争冠/轮换动机不足 |
| 风控 | EV、凯利、回撤约束 | `BANKROLL_RISK_POLICY=1` | 只能推荐方向，不能做到专业资金管理 |

## 硬标准

- 未通过 `standard:check`：不生成正式推荐。
- 未通过 `model:top-tier-audit`：可以生成严格推荐，但不能宣称“顶级模型已就绪”。
- 任何缺失数据必须显示为缺口，不能自动造数。
