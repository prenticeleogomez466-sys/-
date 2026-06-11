# 世界杯大模型 · 专业级完整闭环体系图(2026-06-11 定稿)

> 目标:从数据源读取 → 数据吸收 → 数据分析 → 输出表格 → 复盘回灌,**每个环节有探针硬闸,红灯=拒绝交付**。
> 日常入口:`npm run audit:suite`(含 probe-wc-pipeline 五层闸+喂毒守护);单独跑:`node scripts/audit-wc-pipeline.mjs`。
> 与足球大模型的边界:本文件只管世界杯模型(整届蒙特卡洛+世界杯场次的每日竞彩通路),两模型 7/19 后物理拆分。

## 体系总览(五层闭环)

```
┌─ S1 数据源读取 ──────────────────────────────────────────────┐
│ groups/bracket/format(赛制·FIFA官方495第三名分配)              │
│ team-priors(48队Elo·eloratings·≤4天) match-dates(104场·城市)   │
│ venues(16场馆海拔/恒温) worldcup-weather(Open-Meteo真预报≤48h) │
│ match-odds(ESPN core续鲜≤36h·overround合法) 500.com五赔种      │
└──────────────┬──────────────────────────────────────────────┘
┌─ S2 数据吸收 ─┴──────────────────────────────────────────────┐
│ 每日store世界杯行 → 引擎实链闭合: isWorldCup2026识别 →          │
│ worldCupVenue(队名别名→承办城市→海拔/天气λ) → teamPrior(Elo先验)│
└──────────────┬──────────────────────────────────────────────┘
┌─ S3 数据分析 ─┴──────────────────────────────────────────────┐
│ 单场: Elo先验+洲际校正 → DC/泊松λ(场馆/天气/阶段乘子) → 校准      │
│ 整届: tournament-simulator N=20000 seed=42 官方对阵表           │
│ 不变量: 夺冠和=1 出线和=32 单调链 blend=α市场+(1-α)模型          │
│ 冻结基线: 0610赛前基线sha256登记,被改/被删=作弊即红              │
└──────────────┬──────────────────────────────────────────────┘
┌─ S4 输出层 ──┴──────────────────────────────────────────────┐
│ 神选-竞彩xlsx(26列专业版·深紫FF4A148C·透明度) ↔ 今日足球推荐.html │
│ ↔ adversarial/<date>.json(三视角证伪全覆盖) 三处一致              │
│ worldcup.html ↔ worldcup-supercomputer.json Top3数字一致         │
└──────────────┬──────────────────────────────────────────────┘
┌─ S5 复盘闭环 ─┴──────────────────────────────────────────────┐
│ RecapBacktest 11:10(用户保留的唯一每日任务) → 赛果回收(>24h必有) │
│ → wc:recap-match 逐场胜平负/比分/半全场/让球命中累计表            │
│ → ledger回写 → 信号权重/校准学习域(club-only隔离,国家队不漏入)    │
└─────────────────────────────────────────────────────────────┘
```

## 每层的部件、命令与硬闸

### S1 数据源读取(谁产生数据)
| 数据 | 文件(D:\football-model-data\world-cup\2026) | 刷新命令 | 硬闸探针 |
|---|---|---|---|
| 赛制/分组 | format.json / groups.json | 一次性(华盛顿抽签) | s1-format / s1-groups / s1-zh-map |
| 官方对阵表 | bracket.json(495第三名组合) | build-worldcup-bracket.mjs | s1-bracket |
| 48队Elo先验 | team-priors.json | `npm run sync:wc-elo` | s1-priors-* / s1-elo-fresh(≤4天) |
| 赛程/承办城市 | match-dates.json / match-venues.json | `npm run sync:wc-schedule` | s1-matchdates* / s1-matchvenues |
| 16场馆海拔气候 | venues.json | 一次性 | s1-venues |
| 真实天气预报 | worldcup-weather.json | `npm run sync:wc-weather` | s1-weather-fresh(≤48h)/cover(未来5天逐场) |
| 单场赔率续鲜 | match-odds.json | `npm run refresh:wc-odds-espn`(ESPN core免配额) | s1-odds-sane/fresh(≤36h)/cover(未来36h全覆盖) |
| 夺冠外盘 | The Odds API(8账户key池轮换) | `npm run sync:wc-winner` | 超算note如实标注盘口vintage |
| 竞彩五赔种 | 500.com trade静态XML | today-full-coverage.mjs内联 | (足球大模型域)spf/nspf互换防护已内建 |

### S2 数据吸收(数据怎么进引擎)
- 入口:`src/world-cup-priors.js`(两模型共享)——`worldCupLambdaContext`(场馆海拔/真温/阶段→λ乘子)、`teamPrior`(中英名+别名→Elo)、`isWorldCup2026`(必须用真实比赛日,不能用销售日)。
- 已知雷(都有探针守着):队名命名差异(USA/United States、Congo DR/DR Congo、刚果(金)全角括号)→ `WC_TEAM_ALIASES`/`ZH_TEAM_ALIASES`;venue恒null静默失效(2026-06-07根修);胜负彩腿销售日≠比赛日。
- 硬闸:s2-iswc-closure / s2-venue-closure / s2-prior-closure——**直接调用生产函数实测**,不重造解析。

### S3 数据分析(模型怎么算)
- 单场(每日竞彩世界杯场):prediction-engine → Elo先验(洲际校正+1.08pp)+DC攻防(club-only学习域隔离)+市场融合(分歧大信市场)→ 平局盲区双选0.70阈值、中信心客胜不当胆。
- 整届(超算):`run-worldcup-supercomputer.mjs --n 20000`,FIFA官方对阵表推进,点球=50/50(学界:点球与强度无关),夺冠盘=比例归一(Shin只在逐场融合)。
- 硬闸:s3-sc-invariants(夺冠和=1/出线和=32/48队单调链/blend公式逐队复核)、s3-sc-fresh(≤72h)、s3-sc-teams(与先验表一致)、s3-baseline-freeze(**0610赛前基线sha256,重冻=作弊即红**,登记在 scripts/wc-baseline-freeze.json)。

### S4 输出层(用户看到什么)
- 产物(稳定子文件夹 桌面\足球推荐\<date>\):神选-竞彩推荐xlsx(26列专业版)+今日足球推荐.html+神选-世界杯超算xlsx;站点常驻 worldcup.html(webshare)。
- 口径(2026-06-10用户裁决):**四玩法独立裁决可不同向,但必须透明**——让球列必须带 过盘%(模型)vs%(市场)+与胜平负同/不同向标注;比分/半全场标"盘口主推"来源;比分与半全场方向可合法不同(单格众数vs聚合格,不是bug)。
- 硬闸:s4-xlsx(`scripts/check-wc-xlsx.py`:自动定位列头/26列不缺/深紫FF4A148C/双选含主选方向锚/Elo三项和=100/比分前3档降序/渲染垃圾)、s4-html-consist(xlsx↔html逐场对阵)、s4-adversarial(三视角证伪逐场全覆盖)、s4-wchtml(worldcup.html↔超算json Top3数字)。
- ⚠️ python+openpyxl 断=闸断,按FAIL处理不降级SKIP。

### S5 复盘闭环(预测怎么回灌)
- RecapBacktest 计划任务 11:10(0611用户裁决保留的唯一每日任务)→ recap:backfill 赛果回收 → `wc:recap-match` 逐场命中累计表(桌面\足球推荐\世界杯复盘\,复用updateLedgerRow硬闸不假结算)。
- 硬闸:s5-recap-task(任务在线+上次退出0)、s5-result-closure(完赛>24h必须有赛果,断链即红)、s5-recap-table(首战完赛后必须有累计表)。
- 学习域纪律:DC拟合club-only(国家队不漏入,probe-dc-club-isolation);国际赛画像ESPN六年seed不被短窗顶掉(probe-league-profile-seed)。

## 守护(防闸本身坏掉)
`test/audit-wc-pipeline-guard.test.mjs`(已纳入 audit:suite):
毒①单调链破必拦 / 毒②冻结基线篡改必拦 / 毒③坏赔率(≤1.01)必拦 / 净④真实数据S3必须能过(防"永远红"废闸)。

## 出表标准流程(SOP)
1. 刷新源:`sync:wc-elo` + `sync:wc-weather` + `refresh:wc-odds-espn`(+500.com五赔种由生成器内联抓)。
2. 生成:`node scripts/today-full-coverage.mjs --jconly`(+超算重跑视赛果变动)。
3. 审计:`npm run audit:suite`——**16项探针,任何FAIL=拒绝交付**,修完重跑直到全绿。
4. 交付:稳定子文件夹+手机链接;对抗证伪已在 adversarial/<date>.json。
5. 次日 11:10 复盘自动回灌;s5探针守回收断链。

## 诚实边界(体系保证的是"不出错",不是"赢市场")
- 1X2命中天花板≈55%(市场赔率自身),国际赛50-55%;模型无收盘线edge,分歧越大市场越对。
- 点球大战≈抛硬币,Elo不可外推;凡宣称世界杯>60%命中=泄漏。
- 本体系的价值:概率诚实校准、链路零静默失效、输出零渲染垃圾、复盘可信可追溯。盈亏由注金纪律决定,模型只给校准概率+风险标注。
