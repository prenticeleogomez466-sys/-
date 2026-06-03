# novel-writer · 小说大模型(可执行封装)

把"小说大模型"(D:\novels\升级 的 100 模块/10 层方法论)封装成一套照着跑的 Claude Code Skill,
并补上原系统最大的洞——**长篇连续性**,以及把文笔规则升级成**能跑的脚本**。

## 内容
- `SKILL.md` — 编排:玄幻热血系统爽流口味 + L0→L9 流程 + 四项新机制
- `references/去AI味扫描表.md` — 禁用词/句式分级表(★评级)+ 替换策略
- `references/钩子工具箱.md` — 章末13式 / 章首7式 + 实战模板 + 装逼打脸节奏 + 爽点公式
- `references/文风锚定与爽点引擎.md` — 黄金配方表 + 对标书文风锚定 SOP
- `references/长篇状态追踪.md` — 最简记忆包 + 角色状态快照 + 伏笔表(防遗忘/防幻觉)
- `scripts/deslop_scan.py` — 扫AI味,输出命中行号+毒级,定稿前必跑(退出码2=重度)
- `scripts/style_stats.py` — 测句长分布/标点密度/对白占比,锚定文风/自检节奏

## 用法
放进 `~/.claude/skills/novel-writer/`,写小说时自动触发。
定稿前:`python scripts/deslop_scan.py <稿子>` + `python scripts/style_stats.py <稿子>`。

## 来源
方法论本体=用户自建 100 模块;可运行机制提炼自全网网文 skill 生态
(worldwonderer/oh-story-claudecode 的去AI味词表/章级钩子/文风SOP/状态追踪、
lingfengQAQ/webnovel-writer 的长篇状态管理),融入时已按"玄幻热血系统爽流"口味重构。
