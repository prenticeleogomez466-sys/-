# -*- coding: utf-8 -*-
"""量化同质化检测(免费,无需API):对一批立项包/正文 .md 两两算相似度,揪撞车。
用法: python similarity_check.py <目录或多个文件> [阈值=0.30]
方法: 提取金手指/设定关键词的字符3-gram集合,算 Jaccard 相似度。高于阈值=疑似撞车。
"""
import sys, os, re, io, glob, itertools

def load(path):
    with io.open(path, encoding="utf-8") as f:
        t = f.read()
    # 优先取"设定/金手指"段,没有就取全文前2000字
    m = re.search(r"(金手指|设定|一句话开局)[\s\S]{0,1500}", t)
    seg = m.group(0) if m else t[:2000]
    seg = re.sub(r"[#*\->\|\s]", "", seg)
    return seg

def grams(s, n=3):
    return set(s[i:i+n] for i in range(max(len(s)-n+1, 0)))

def jac(a, b):
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def main():
    args = [a for a in sys.argv[1:] if not a.replace(".","").isdigit()]
    nums = [a for a in sys.argv[1:] if a.replace(".","").isdigit()]
    thr = float(nums[0]) if nums else 0.30
    files = []
    for a in args:
        if os.path.isdir(a):
            files += sorted(glob.glob(os.path.join(a, "*.md")))
        else:
            files.append(a)
    if len(files) < 2:
        print("需要至少2个文件/一个含多md的目录"); sys.exit(1)
    G = {f: grams(load(f)) for f in files}
    pairs = []
    for f1, f2 in itertools.combinations(files, 2):
        s = jac(G[f1], G[f2])
        if s >= thr:
            pairs.append((s, f1, f2))
    pairs.sort(reverse=True)
    print(f"=== 同质化检测: {len(files)} 篇, 阈值={thr} ===")
    if not pairs:
        print("✅ 无两两相似度超阈值的撞车对,题材机制分布健康")
    else:
        print(f"⚠ {len(pairs)} 对疑似撞车(相似度降序):")
        for s, f1, f2 in pairs[:30]:
            print(f"  {s:.2f}  {os.path.basename(f1)}  ↔  {os.path.basename(f2)}")
        print("\n建议: 撞车对里挑一篇换金手指家族或题材簇(见 题材矩阵.md / 金手指机制图谱.md)")
    sys.exit(2 if pairs else 0)

if __name__ == "__main__":
    main()
