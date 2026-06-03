# 世界杯大模型升级 · 资源/技能吸收档(2026-06-03)

两路并行调研(免费信息资源 + GitHub 开源技能)成果汇总,**按"是否已验证净增益"分层**。
铁律:每项接入前必跑 leak-safe 回测,净增益才接,无益如实标 SKIP,不为"显得优化"乱改。
国际赛胜平负命中天花板 ~50-55%,**下方无一项声称突破它**;真增益都在校准/分布/数据底座/覆盖完整性。

---

## A. 已落地并验证(本轮完成)

| 项 | 来源 | 做法 | 验证结果 | 状态 |
|---|---|---|---|---|
| **martj42 国际赛全量结果(49,363场,1872-2026)** | github.com/martj42/international_results (Public Domain) | 下载落 `data/intl-results/results.csv`,作国际赛 leak-safe 回测底座 | 远超原 732 场世界杯样本,含中立场/赛事/比分 | ✅ 已入库 |
| **World Football Elo 全套**(赛事K档60/50/40/30/20 + 净胜球指数 + 主场+100/中立场0) | eloratings.net 公式 + martj42 数据 | `scripts/run-intl-elo-backtest.mjs` 对比朴素平K | **14,841场(2011-26):命中 58.0%→59.5%(+1.5pp)、logloss −0.0316、Brier −0.0206** | ✅ 验证净增益(现产 Elo 已取 eloratings.net=内置此套,验证=方法论背书+底座) |
| **淘汰赛平局软重校准**(待办#2) | 库内描述统计 | `scripts/run-worldcup-knockout-draw-check.mjs` 测残余+boost净增益 | 残余描述上+4.9pp,但 boost 实际 logloss −0.0004(噪声内) | ⚖️ **SKIP**(有据,不接) |
| **名单维基残渣清洗** | 数据质量 | team-priors.json 清 114 处 `[[链接` 残渣,34队 | Elo/排名/预测数值零改动 | ✅ 已清 |
| **多模型融合**(Opta+预测市场+本模型) | 上一轮 | 对数意见池,市场共识塌缩防重复计票 | 西班牙22% | ✅ 已上线 |

---

## B. 已验证可接、待实现(下一刀,均免费+小改动+likely净增益)

> 来自 GitHub 调研,优先级高、改动集中在 Dixon-Coles λ 层 / 市场净化层,符合"删拖后腿/小改回测快"经验。

1. **Shin / power method 去抽水**(penaltyblog, MIT)— 替当前"1/赔率按比例归一"。Shin 假设有内幕交易者,从赔率提隐含概率更准 → **所有市场融合上游提质**,直接惠及本轮的融合引擎。改动小、纯数学。
2. **Rue-Salvesen γ 调整**(goalmodel)— 按双方实力差对进球强度做收缩(强队对弱队不无限刷分)。**国际赛实力差极大,正对世界杯场景**。一行强度调整,可在 49k 样本测总进球/大小球净增益。
3. **expg_from_probabilities 市场→λ 反推**(goalmodel)— 从市场 1X2 反解隐含 λ,在 **λ 层而非概率层**与模型融合,比意见池更物理一致;惠及比分/大小球市场。
4. **Pi-rating 第二评分源**(Constantinou-Fenton, football-predictor MIT)— 分主客、按进球差动态更新,喂 λ 做评分多样性集成。
5. **CMP(Conway-Maxwell-Poisson)**(goalmodel)— 处理进球欠离散(低分赛)。**需先查国际赛进球是否真欠离散再上**,否则白做。

## C. 数据/工程底座(中期,扩能力)

6. **`soccerdata` Python 库**(Apache-2.0)— 一库通吃 FBref/Sofascore/ClubElo/Understat,**已确认支持世界杯/欧洲杯**,自带缓存+反爬。补"国家队 xG/球员评分"事件级缺口的免费通道。落 `data/soccerdata-bridge/` 出 CSV 喂特征层(离线,不进实时闸门)。
7. **ClubElo 免费 API**(api.clubelo.com)— 俱乐部 Elo + 自带比分概率分布,作俱乐部路径第五路交叉验证(**不覆盖国家队**)。
8. **ESPN 隐藏 JSON API**(site.api.espn.com)免key — 比抓 HTML 稳的首发触发器(已部分接入,可固化)。

## D. 校准/方法论(择机,纯改善分布非命中)

9. **市场-模型凸组合最优权重 + 指数时间下权**(Egidi/Pauli 2018, EURO2024)— 用历史(模型p,市场p,真值)最小化 Brier 解融合系数,替手调 alpha。离线拟合脚本放融合层旁。
10. **Skellam + isotonic 校准**(Wilkens 2026)— λ_home−λ_away 的 Skellam 直接出 1X2,比逐格累加更稳;接现有有界 isotonic 重校准。
11. **双向对角膨胀**(Karlis-Ntzoufras)— Dixon-Coles 的 τ 从常数改 scenario 自适应(联赛性质×实力差),允许负向,改善平局精度。

---

## E. 明确避雷(免费拿不到 / 已验证无益 / 花架子)

| 项 | 判定 | 理由 |
|---|---|---|
| 国家队"预测XI/伤停"结构化免费源 | 拿不到 | 免费源只给赛前确认首发,预测阵容+伤停几乎全付费 |
| FiveThirtyEight SPI | 半坑 | 2023 年中已停更,只可作历史回测基线,不接实时 |
| Understat | 不适用国际赛 | 只覆盖欧洲俱乐部,无国家队 |
| API-Football/Sportmonks 的 xG/预测/伤停 | 付费降级 | 违反"只要免费"硬规则 |
| conformal/markov/knn 再接 prediction-engine | 已验证 SKIP | 10 模块 workflow 验证净增益0或负,别重复踩 |
| soccer_xg(事件级 xG 建模) | 用不上 | 需 StatsBomb/Opta 射门事件,国际赛免费拿不到 |
| Footy4.0/SportsBet 等 | 花架子 | 无 margin removal/校准/CLV,声称 edge 不可信 |
| 任何"破 50-55% 国际赛命中"的方法 | 物理不可达 | 学界一致结论,赔率极难超越 |

---

## 落地路径(对齐既有纪律)

- **第一刀(已做)**:martj42 底座 + WFE 验证 + 淘汰赛平局检验 + 名单清洗 + 多模型融合。
- **第二刀**:B 组 1-3(Shin 去抽水 / Rue-Salvesen / 市场→λ)——改动小、回测快,逐项 leak-safe 验证,过了才接。
- **第三刀**:C 组 soccerdata 桥接(国家队 xG/评分),为 B 组 4-5 与 D 组提供事件级特征。
- 全程:禁假编、实时跑通、改完回测、缺真实盘口只跳过不编造、无净增益不上线。

**来源**:见各项标注 URL。两份完整调研原文存于本次会话 agent 输出。
