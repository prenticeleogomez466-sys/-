# 赔率数据源稳定性系统(ODDS_STABILITY_SYSTEM)

> 目标:消除"同一批比赛连抓两次,结果忽好忽坏、推荐跟着漂移"。
> 建于 2026-06-02 过夜专项,核心原则:**抓到过的真实盘口只升不降、永不丢失**。

## 一、问题根因

竞彩/胜负彩盘口靠十几个公开 HTML 源抓取,每个源都可能"这次成、下次挂"
(反爬节流、网络抖动、文章发现失败)。叠加三个放大器:

1. **无跨轮兜底**:某源这轮挂了,就丢这场盘口,下轮可能又好了 → 覆盖场次每次不同。
2. **真实被派生顶替**:抓不到真实欧赔时回退到对称占位(如 `2.55/2.9/2.55`),主客赔率相等、无真实平局价。
3. **无"只升不降"保证**:一轮质量差的抓取会把上一轮的好数据覆盖掉。

国际赛/友谊赛尤其惨:新浪、football-data、付费 API 常年抓不到欧赔,只剩 500 单源 + 派生。

## 二、解法总览(四层)

```
实时抓取(500/ESPN/新浪/…)
        │
        ▼
① 单调稳定缓存 ──── 抓到真实值存 last-good(带质量分),缺失/更差的用 last-good 回填
        │            → 实时源全挂也能复现最高质量数据
        ▼
② ESPN 冗余源 ──── 国际赛/友谊赛免 key 拿 DraftKings 真实主/平/客 + 大小球盘
        │            → 补单源洞,按每场开赛日预缓存未来 14 场
        ▼
③ 监控账本 ──────── 每 10 分钟实跑,记每源 ok/fail/na 滚动成功率
        │            → 谁稳谁该修一目了然
        ▼
④ 验收脚本 ──────── 只读核验:每场真实欧赔 + 让球线 + 大小球 + 缓存覆盖
```

## 三、各组件

### ① 单调稳定缓存 `src/odds-stability-cache.js`
- 按 `日期__主队__客队` 落盘 last-good,每个市场(欧赔/亚盘/让球/竞彩让球线/大小球)带**质量分**:
  真实双向(3)> 单向(2)> 派生对称/fallback(1)> 无(0)。
- `updateStabilityCache`:质量 **≥** 旧值才覆盖(只升不降),并 `cleanSource` 防源串嵌套膨胀。
- `backfillFromStabilityCache`:本轮缺失或更差的市场,用 last-good 顶上;整场没抓到的可凭缓存造一条。
- `pruneStabilityCache`:剪掉超 `STABILITY_CACHE_MAX_AGE_DAYS`(默认 21)天的旧条目,防文件无限增长。
- 开关:`ODDS_STABILITY_CACHE_ENABLED=0` 关闭。
- 效果验证:实时源全宕机 + 删 market json,仍由缓存复现同一盘口;同批连抓两次盘口完全一致。

### ② ESPN 冗余赔率源 `src/espn-odds-source.js`
- ESPN 公开 JSON 免 key。`scoreboard` 列赛程 → `canonicalTeamName` 英↔中归一匹配 fixtures + 主客校正
  → `core API` 取 DraftKings 完整主/平/客 decimal 赔率 + 大小球 O/U(line + 大/小水位)。
- 抓取日期戳 = crawl 当天±1 ∪ **每场自己的开赛日**(`kickoff`)→ 未来 14 场提前拿真实盘并缓存。
- 覆盖联赛:`fifa.friendly / uefa.nations / 各大洲世预赛 / 国家队杯赛` 等。
- 开关:`ESPN_ODDS_ENABLED=0` 关闭。
- 团队别名在 `src/team-aliases.js`(已补 30+ 国家队)。

### ③ 数据源稳定性监控 `scripts/source-stability-monitor.mjs`
- 实跑赔率抓取 + 免源探测,按 **ok / fail / na** 三态记滚动账本
  `D:/football-model-exports/source-stability-ledger.json`。
- `na`(不计入成功率)= 付费源故意没配 key、今日无该市场、数据尚未发布(期号未开)等"没东西可抓"。
- 输出每源成功率/连失/最近错误,最差排前便于盯修。

### ④ 过夜循环 + 验收
- `scripts/overnight-stability-loop.mjs`:每 N 分钟跑一次监控,到次日 08:00(北京)止,用真实账本证明不再漂移。
- `scripts/verify-odds-stability.mjs`:只读验收——每场真实(非对称)欧赔 + 让球线 + 大小球 totals + 缓存 last-good。
  `--repro` 可赛前连抓两次比对可复现。

## 四、常用命令

```bash
node scripts/jingcai-daily.mjs                 # 当日竞彩推荐(内含上述稳定链路)
node scripts/source-stability-monitor.mjs      # 跑一次监控,刷新账本
node scripts/overnight-stability-loop.mjs 10   # 每 10 分钟一轮跑到次日 08:00
node scripts/verify-odds-stability.mjs 2026-06-02 [--repro]   # 验收某日
```

## 五、已知缺口 / 待办
- **大小球真实盘已存进 `snapshot.totals`,但模型尚未消费**:让大小球玩法真正用上这个真实 line/水位,
  需改 `prediction-engine.js`(有他人未提交改动,待其落定后接入 + 回测)。
- Understat(xG)被反爬,免费拿不到,非关键源,暂缺。
- ESPN 大小球水位为美式 DraftKings,与亚盘水位口径不同,仅作参考方向。
