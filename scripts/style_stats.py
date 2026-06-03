# -*- coding: utf-8 -*-
"""测文风:句长分布 + 标点密度 + 对白占比。用于①锚定对标书文风 ②自检自己节奏够不够"砸"。
用法: python style_stats.py <文件>
爽流要的是短句多、节奏快。参考线: short_lt15 ≥55% 为佳; avg_len ≤18; 对白占比 ≥25%。
"""
import sys, re, io, statistics

def main():
    if len(sys.argv) < 2:
        print("用法: python style_stats.py <文件>"); sys.exit(1)
    with io.open(sys.argv[1], encoding="utf-8") as f:
        text = "".join(l for l in f if not l.lstrip().startswith("#"))
    sents = [s for s in re.split(r"[。！？\n]+", text) if s.strip()]
    total = max(len(sents), 1)
    lens = [len(s) for s in sents]
    short = sum(1 for L in lens if L < 15)
    mid   = sum(1 for L in lens if 15 <= L <= 30)
    lng   = sum(1 for L in lens if L > 30)
    chars = max(sum(1 for c in text if not c.isspace()), 1)
    puncts = sum(1 for c in text if c in "，。！？；：、…—""''")
    avg = sum(lens) // total
    stdev = round(statistics.pstdev(lens), 1) if len(lens) > 1 else 0.0  # 句长标准差=节奏方差
    # 对白占比(带引号的句子字数 / 总字数)
    dlg = sum(len(m) for m in re.findall(r"[「『][^」』]*[」』]|[""][^""]*[""]|\"[^\"]*\"", text))
    dlg_pct = 100 * dlg // chars

    print(f"=== 文风测量: {sys.argv[1]} ===")
    print(f"句数={total} | 短句<15字={100*short//total}% | 中句15-30={100*mid//total}% | 长句>30={100*lng//total}%")
    print(f"平均句长={avg}字 | 句长方差(stdev)={stdev} | 标点密度={100*puncts//chars}% | 对白占比≈{dlg_pct}%")
    flags = []
    if 100*short//total < 55: flags.append("短句偏少→节奏不够砸,拆长句")
    if avg > 18: flags.append("平均句长偏长→爽流要更短促")
    if stdev < 6: flags.append("句长方差过低→匀速流水句(深层AI腔!)长短句交错砸节奏")
    if dlg_pct < 25: flags.append("对白偏少→加带潜台词的对白提速")
    print("自检: " + ("; ".join(flags) if flags else "节奏达标(短句多/长短交错/对白足)"))

if __name__ == "__main__":
    main()
