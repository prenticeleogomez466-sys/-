# Football AI Copilot

中文足球大模型——**所有足球数据分析的唯一大脑**:授权数据源、赔率硬门槛、竞彩/14场推荐、XLSX 日报、微信发信箱和赛后复盘。

## 唯一大模型架构(2026-06-11 融合裁决)

世界杯模型已全面融合为大模型内部的**世界杯域模块**,不再是并行的第二套模型:

- **路由在引擎里**:`prediction-engine.predictFixture` 检测到 2026 世界杯正赛场(赛事名+赛期窗+48 强 Elo 先验)自动走 `src/wc-match-model.js`(国家队 Elo+洲际校正+东道主+海拔气温→λ),1X2 取模型自主 argmax 单选;市场只作对照/风险旗标。任何入口(每日/竞彩/14 场/server)进来的世界杯场都不可能误入俱乐部市场跟随路径(0611 铁律的结构性保证,守护 `test/wc-engine-route.test.mjs`)。
- **域隔离**:世界杯路由场旁路俱乐部信号融合层/isotonic 校准/软赛事平局重校准/drawLean 防平;俱乐部场零影响。
- **整届蒙特卡洛超算**(`run-worldcup-supercomputer.mjs`,官方 bracket+市场混合)与逐场域共享同一套 `world-cup-priors`/`tournament-simulator`。
- **大扫除**:2026-06-11 永久删除 26 个生产不可达/回测证伪的死模块(conformal/markov/thompson/state-space/temperature 僵尸/ensemble-1x2 等)+ 20 个一次性证伪脚本 + 旧 champion-sim/fusion 重复链,结论存长期记忆与 `scripts/models-registry.mjs`,**勿重建**。

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
