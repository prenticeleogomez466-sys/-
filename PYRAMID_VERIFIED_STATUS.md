# 足球大模型 · 金字塔已验证真实状态(2026-06-01)

> 本文 **取代** overnight-pyramid-plan.md(2026-05-31)的"缺口"列 —— 该计划已过时:其标注的多数缺口在 5-31 通宵轮已完成。
> 本文每条都经代码 import 图核对 + 回测实测,不靠计划稿臆测。诚实纪律:有市场处打不过市场如实标、不虚标 edge。

## 一、各层真实状态(代码核对)

| 层 | 规划状态 | **2026-06-01 实测** |
|---|---|---|
| **L0 数据底座** | "扩到10万场" | ✅ **超额**:fixture-store **134,330 场 / 57 联赛**;经验库 668KB;赔率薄竞彩联赛已覆盖(瑞超1540/挪超1560/日职2234/澳超1082/美职3073/巴甲2433/阿甲2441) |
| **L1 数据审计** | 统一化待办 | ✅ realtime-source-gate + λ物理闸门 + pre-export-selfcheck + provenance 戳(在产) |
| **L2 模型层** | "爆冷+诱盘本轮""联赛专家收缩" | ✅ **均已接线**:爆冷 `prediction-engine:579`、联赛专家 `:636`(leagueExpertFromFitted 收缩门控);评级动物园 pi/massey/colley/bivariate/hierarchical;信号融合 28 路 |
| **L3 大融合** | "权重按复盘自学" | ✅ deep-fusion-analysis + multimodal-collab + isotonic 校准 + wld 锚守护;权重离线 run-optimize-loop 调优后落 profile(非在线自学) |
| **L4 审计闸门** | "第9道待加" | ✅ **第9道已落地** `comprehensive-audit:143`(爆冷/诱盘 roll-up) |
| **L5 输出端** | "爆冷列待加" | ✅ daily-report 爆冷列 `:96/:119`、多玩法、14场胆双全、手机页 |
| **横切** | 记忆模块化待办 | ✅ daily-recap 闭环 + RecapBacktest 计划任务 + lineup-watch;记忆模块化未做(低优先) |

## 二、部件回测验证(2026-06-01 实测,leak-safe walk-forward)

| 部件 | 样本 | 结果 | 判定 |
|---|---|---|---|
| **爆冷检测** | ~10.9k | 风险低/中/高→实际爆冷 30.9%/49.1%/59.3%(单调);预测44.9% vs 实际45.7% | ✅ **真有用**:可区分 + 校准准 |
| **诱盘识别** | ~8.8k | "诱盘嫌疑"桶 实际−隐含 = -0.1pp(≈0) | ✅ **诚实**:市场高效,标为透明读数而非假 edge |
| **逐联赛 DC** | 32,719 | 全局 RPS 0.4244 vs 分联赛 0.4245(各层 ❌微退) | ⚠️ 裸分联赛无增益 → 故生产用**收缩门控**塌回全局(不退化) |
| **联赛平局校准** | ~14k | 有赔率联赛全 ❌(市场已 price 平局) | ⚠️ 仅对赔率薄小联赛有益,有市场处不接 |

**统一结论(与 reference-signal-backtest-findings / data-change-5yr 实证一致)**:
有赔率的胜负平市场已高效,模型各路在其上 ≈0 或微负;真 edge 只在 **①爆冷风险校准 ②赔率薄/无的小联赛 DC ③多玩法覆盖+诚实信心**。模型如实标注、未虚构 edge。

## 三、真实残余限制(免费源可得性所限,非工程缺失)

- **芬超赛果**:ESPN `fin.1` 无赛果(代码 espn-results-source.js:22 已记录),免费源拿不到 → 芬超仅 25 场,无法补全。
- **伤停/阵容**:仅 FPL(英超)稳定;ESPN 五大联赛 feed 休赛期空、Understat 反爬 → 非英超伤停覆盖薄。
- 以上属"免费源天花板",非可由本地工程修复;遵 free-only-no-paid 不接付费源。

## 四、当前体征
- src 模块 155 · 测试 **669 全过/0 失败** · 孤儿/死import边 **0/0** · 模型评分 **91.6/100(A)**
- 生产真链路:`daily-report → prediction-engine(+deep-fusion/multimodal)→ comprehensive-audit/pre-export-selfcheck → xlsx/wechat`
