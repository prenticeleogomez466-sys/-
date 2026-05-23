# 足球大模型结构审计 2026-05-23

状态：通过
生成时间：2026-05-23T13:59:55.817Z

| 层级 | 检查项 | 状态 | 说明 |
|---|---|---:|---|
| 结构层 | 关键文件 package.json | 通过 | 存在 |
| 结构层 | 关键文件 src/china-web-sources.js | 通过 | 存在 |
| 结构层 | 关键文件 src/realtime-source-gate.js | 通过 | 存在 |
| 结构层 | 关键文件 src/prediction-engine.js | 通过 | 存在 |
| 结构层 | 关键文件 src/monte-carlo-simulator.js | 通过 | 存在 |
| 结构层 | 关键文件 src/daily-report.js | 通过 | 存在 |
| 结构层 | 关键文件 src/recommendation-audit.js | 通过 | 存在 |
| 结构层 | 关键文件 src/evolution-backtest.js | 通过 | 存在 |
| 结构层 | 关键文件 src/server.js | 通过 | 存在 |
| 结构层 | 关键文件 src/wechat-channel.js | 通过 | 存在 |
| 结构层 | 关键文件 src/wechat-delivery.js | 通过 | 存在 |
| 结构层 | 关键文件 src/wechat-smoke.js | 通过 | 存在 |
| 结构层 | 关键文件 WECHAT_CHANNEL_SECURITY.md | 通过 | 存在 |
| 结构层 | 关键文件 scripts/run-football-automation.ps1 | 通过 | 存在 |
| 结构层 | 关键文件 scripts/install-football-automation-tasks.ps1 | 通过 | 存在 |
| 脚本层 | npm 脚本 crawler:realtime | 通过 | node src/realtime-crawler-runner.js |
| 脚本层 | npm 脚本 crawler:realtime:strict | 通过 | node src/realtime-crawler-runner.js --require-external-odds --require-full-odds |
| 脚本层 | npm 脚本 china:sources | 通过 | node src/china-web-source-runner.js |
| 脚本层 | npm 脚本 china:sources:sync | 通过 | node src/china-web-source-runner.js --sync-fixtures |
| 脚本层 | npm 脚本 daily | 通过 | node src/daily-evolution.js |
| 脚本层 | npm 脚本 daily:allow-missing | 通过 | node src/daily-evolution.js --allow-missing-odds |
| 脚本层 | npm 脚本 advanced:sync | 通过 | node src/advanced-data-runner.js |
| 脚本层 | npm 脚本 model:top-tier-audit | 通过 | node src/top-tier-model-audit.js |
| 脚本层 | npm 脚本 model:defect-audit | 通过 | node src/model-defect-audit.js |
| 脚本层 | npm 脚本 model:stage-audit | 通过 | node src/model-stage-audit.js |
| 脚本层 | npm 脚本 backtest:evolution | 通过 | node src/evolution-backtest.js |
| 脚本层 | npm 脚本 auto:health | 通过 | powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-football-automation.ps1 -Mode health |
| 脚本层 | npm 脚本 auto:daily | 通过 | powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-football-automation.ps1 -Mode daily |
| 脚本层 | npm 脚本 auto:install | 通过 | powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-football-automation-tasks.ps1 |
| 脚本层 | npm 脚本 wechat:check | 通过 | node src/wechat-smoke.js |
| 脚本层 | npm 脚本 test | 通过 | node --test |
| 数据层 | 赛程总量 | 通过 | 37 场 |
| 数据层 | 竞彩足球场次 | 通过 | 23 场 |
| 数据层 | 14场完整性 | 通过 | 14/14 |
| 数据层 | 官方数据来源 | 通过 | china-official-web:sporttery+lottery-gov-cn |
| 赔率层 | 市场快照 | 通过 | 43 个快照 |
| 赔率层 | 实时赔率覆盖 | 通过 | 37/37 |
| 闸门层 | 实时数据源闸门 | 通过 | 通过 |
| 闸门层 | 闸门新鲜度 | 通过 | 0 分钟 |
| 输出层 | 每日推荐 XLSX | 通过 | 356569 bytes |
| 输出层 | 复盘总表 XLSX | 通过 | 151510 bytes |
| 输出层 | 微信 outbox | 通过 | 626 bytes |
| 中文层 | 用户可见中文 src/prediction-engine.js | 通过 | 正常中文 |
| 中文层 | 用户可见中文 src/daily-report.js | 通过 | 正常中文 |
| 中文层 | 用户可见中文 src/recommendation-audit.js | 通过 | 正常中文 |
| 中文层 | 用户可见中文 src/wechat-channel.js | 通过 | 正常中文 |
| 中文层 | 用户可见中文 src/wechat-smoke.js | 通过 | 正常中文 |
| 中文层 | 用户可见中文 WECHAT_CHANNEL_SECURITY.md | 通过 | 正常中文 |
| 中文层 | 用户可见中文 package.json | 通过 | 正常中文 |
