# -*- coding: utf-8 -*-
"""扫AI味:对一篇小说正文(.md/.txt)做禁用词/句式扫描,按毒级输出命中行号。
用法: python deslop_scan.py <文件> [--quiet]
退出码: 命中★★★★★ 任意一处 或 ★★★★ ≥2 处 -> 2(重度,必改); 仅轻度 -> 1; 干净 -> 0。
规则提炼自网文去AI味实践(参考 oh-story banned-words),按"玄幻热血系统爽流"口味裁剪。
"""
import sys, re, io

# (毒级, 名称, 正则) —— 毒级越高越必须改
RULES = [
    (5, "不是A而是B", r"不是[^,，。！？]{1,14}[,，]\s*而是"),
    (5, "不是A不是B而是C", r"不是[^,，]{1,12}[,，]不是[^,，]{1,12}[,，]而是"),
    (4, "万能状语·带着", r"[,，]\s*带着[^。！？]{0,10}(一丝|一抹|些许|几分|一种)"),
    (4, "声音不大却带着", r"声音不大[,，]却带着"),
    (4, "告诉而非展示·他知道/意识到/感到", r"(他|她|它)(知道|意识到|感到|明白)[^。！？，]{0,18}(来不及|不对|失落|一切)"),
    (3, "仿佛犹如宛若一般", r"(仿佛|犹如|宛若|宛如|如同)[^。！？]{1,18}一般"),
    (3, "眼中闪过一丝", r"(眼中|眼里)闪过一[丝抹]"),
    (3, "嘴角勾起一抹", r"嘴角(勾起|扬起|浮起)一抹"),
    (3, "心中涌起/心头一震", r"(心中涌起一[股丝]|心头一震|心底泛起|心下了然|心中暗道)"),
    (2, "章末空泛预告", r"(他|她)不知道的是[,，]"),
    (2, "总结升华句", r"(这一刻|此刻)[,，][^。！？]{0,12}(终于|这才|明白|意识到|知道)"),
    (2, "原来式顿悟", r"(他|她)(终于明白|这才意识到|这才明白)"),
]
# 一级禁用词(出现即可疑,按密度计)
L1_WORDS = ["仿佛","犹如","宛若","如同","一丝","一抹","些许","几分","隐约",
            "深吸一口气","缓缓","不禁","微微","轻轻","淡淡",
            "眼中闪过","嘴角勾起","眉头微皱","瞳孔微缩",
            "心中一动","心头一震","心下了然","心中暗道","不由得","不由自主","情不自禁",
            "不容置疑","不易察觉","显而易见","毫无疑问",
            "闪烁着光芒","狡黠","深邃","凛冽"]

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    if not args:
        print("用法: python deslop_scan.py <文件> [--quiet]"); sys.exit(3)
    path = args[0]
    try:
        with io.open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception as e:
        print(f"读不开: {e}"); sys.exit(3)

    hits = []  # (lineno, sev, name, frag)
    for i, ln in enumerate(lines, 1):
        if ln.lstrip().startswith("#"):   # 跳过标题/markdown 结构行
            continue
        for sev, name, pat in RULES:
            for m in re.finditer(pat, ln):
                hits.append((i, sev, name, m.group(0)[:24]))

    # 一级禁用词密度
    text = "\n".join(l for l in lines if not l.lstrip().startswith("#"))
    word_hits = {w: text.count(w) for w in L1_WORDS if text.count(w) > 0}
    total_words = sum(word_hits.values())
    body_chars = max(sum(1 for c in text if not c.isspace()), 1)
    density = round(1000 * total_words / body_chars, 2)  # 每千字禁用词数

    sev5 = sum(1 for h in hits if h[1] == 5)
    sev4 = sum(1 for h in hits if h[1] == 4)

    if not quiet:
        print(f"=== 去AI味扫描: {path} ===")
        print(f"正文约 {body_chars} 字 | 句式命中 {len(hits)} 处(★5×{sev5} ★4×{sev4}) | 一级禁用词 {total_words} 个 / 密度 {density}‰\n")
        for lineno, sev, name, frag in sorted(hits, key=lambda x: (-x[1], x[0])):
            print(f"  L{lineno:>4} {'★'*sev} [{name}] …{frag}…")
        if word_hits:
            top = sorted(word_hits.items(), key=lambda x: -x[1])[:12]
            print("\n  高频禁用词: " + " ".join(f"{w}×{c}" for w, c in top))
        verdict = "重度AI味·必改" if (sev5 >= 1 or sev4 >= 2) else ("轻度·建议清" if (hits or density > 8) else "干净")
        print(f"\n判定: {verdict}  (密度阈值: 优<3‰ / 可接受<8‰ / 偏高≥8‰)")

    if sev5 >= 1 or sev4 >= 2:
        sys.exit(2)
    sys.exit(1 if (hits or density > 8) else 0)

if __name__ == "__main__":
    main()
