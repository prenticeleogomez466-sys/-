# -*- coding: utf-8 -*-
"""
盘口形态 -> 结果 真实回测
数据源: football-data.co.uk 5大联赛(D1/E0/F1/I1/SP1)x7季, 每场含开盘+收盘 1X2/亚盘让球/大小球真实赔率
口径: 严格用真实开盘价(B365H/D/A, AHh, B365AHH/AHA, B365>2.5)与收盘价(B365C*, AHCh, B365CAHH/AHA, B365C>2.5)
      所有结论=真实经验频率+样本量, 不估计/不兜底; 样本<200的桶标注"样本薄,仅参考"
"""
import csv, glob, os, math
from collections import defaultdict

DATA = r"D:\football-model\data\footballdata"
files = sorted(glob.glob(os.path.join(DATA, "*.csv")))

def fnum(x):
    try:
        x = (x or "").strip()
        return float(x) if x not in ("", "NA") else None
    except: return None

def devig3(h, d, a):
    """1X2 去水头, 返回归一化(ph,pd,pa); 任一缺失返回 None"""
    if not (h and d and a): return None
    ph, pd, pa = 1/h, 1/d, 1/a
    s = ph+pd+pa
    return ph/s, pd/s, pa/s

def settle_home(m, L):
    """主队让球结算: 返回主队赢盘分数 1=赢 0.5=走盘 0=输; 四分盘自动拆半"""
    if L is None: return None
    if abs((L*2) - round(L*2)) < 1e-9:   # 整数/半盘 单结算
        e = m + L
        return 1.0 if e > 0 else (0.5 if abs(e) < 1e-9 else 0.0)
    a = settle_home(m, L-0.25); b = settle_home(m, L+0.25)
    return (a+b)/2

rows = []
for fp in files:
    lg = os.path.basename(fp).split("_")[0]
    with open(fp, newline="", encoding="utf-8-sig", errors="ignore") as f:
        for r in csv.DictReader(f):
            fthg, ftag = fnum(r.get("FTHG")), fnum(r.get("FTAG"))
            ftr = (r.get("FTR") or "").strip()
            if fthg is None or ftag is None or ftr not in ("H","D","A"): continue
            rec = dict(lg=lg, m=int(fthg-ftag), ftr=ftr,
                H=fnum(r.get("B365H")), D=fnum(r.get("B365D")), A=fnum(r.get("B365A")),
                CH=fnum(r.get("B365CH")), CD=fnum(r.get("B365CD")), CA=fnum(r.get("B365CA")),
                AHh=fnum(r.get("AHh")), AHHo=fnum(r.get("B365AHH")), AHAo=fnum(r.get("B365AHA")),
                AHc=fnum(r.get("AHCh")), AHHc=fnum(r.get("B365CAHH")), AHAc=fnum(r.get("B365CAHA")),
                Oo=fnum(r.get("B365>2.5")), Uo=fnum(r.get("B365<2.5")),
                Oc=fnum(r.get("B365C>2.5")), Uc=fnum(r.get("B365C<2.5")),
                tot=int(fthg+ftag))
            rows.append(rec)

print(f"载入真实场次: {len(rows)} (5联赛x7季)\n")

def bucket_report(title, classify, outcome, rows_in=None):
    """classify(r)->桶名 or None;  outcome(r)->0/1 命中(or 分数)"""
    rows_in = rows_in if rows_in is not None else rows
    agg = defaultdict(lambda: [0.0, 0])  # sum, n
    for r in rows_in:
        b = classify(r)
        if b is None: continue
        o = outcome(r)
        if o is None: continue
        agg[b][0] += o; agg[b][1] += 1
    print(f"=== {title} ===")
    # 排序: 按桶名固定顺序若提供, 否则按n
    for b in sorted(agg, key=lambda k: (-agg[k][1])):
        s, n = agg[b]
        warn = "  ⚠️样本薄" if n < 200 else ""
        print(f"  {b:<34} 命中率 {s/n*100:5.1f}%   n={n}{warn}")
    print()

# ---------- A. 欧赔1X2 开->收漂移(以热门方为锚) -> 胜率 ----------
def fav_drift(r):
    o = devig3(r["H"],r["D"],r["A"]); c = devig3(r["CH"],r["CD"],r["CA"])
    if not o or not c: return None
    # 热门=开盘三选最高概率方
    side = max(range(3), key=lambda i: o[i])
    if side == 1: return None   # 开盘以平为最热, 跳过(罕见)
    dd = c[side] - o[side]      # 该热门方 开->收 概率变化
    name = "主队" if side==0 else "客队"
    return side, name, dd
def A_class(r):
    fd = fav_drift(r)
    if not fd: return None
    side,name,dd = fd
    if dd >= 0.02:  tag="①被加注(收盘更热)"
    elif dd <= -0.02: tag="③退烧(收盘降温)"
    else: tag="②基本没动"
    return f"{name}热门-{tag}"
def A_out(r):
    fd = fav_drift(r)
    if not fd: return None
    side,name,dd = fd
    win = (r["ftr"]=="H") if side==0 else (r["ftr"]=="A")
    return 1.0 if win else 0.0
bucket_report("A. 欧赔热门 开->收漂移 -> 该热门最终获胜率", A_class, A_out)

# ---------- B. 收盘欧赔大热分档 -> 实际胜率(校准/赔率高低->结果) ----------
def B_class(r):
    c = devig3(r["CH"],r["CD"],r["CA"])
    if not c: return None
    p = max(c[0], c[2]); name="主"if c[0]>=c[2] else "客"
    if   p>=0.75: lvl="A 超大热 >75%"
    elif p>=0.60: lvl="B 大热 60-75%"
    elif p>=0.50: lvl="C 小热 50-60%"
    elif p>=0.40: lvl="D 接近五五 40-50%"
    else: lvl="E 双弱(最热<40%)"
    return lvl
def B_out(r):
    c = devig3(r["CH"],r["CD"],r["CA"])
    if not c: return None
    if c[0]>=c[2]: return 1.0 if r["ftr"]=="H" else 0.0
    return 1.0 if r["ftr"]=="A" else 0.0
bucket_report("B. 收盘欧赔最热方分档 -> 实际命中率(赔率高低=胜率校准)", B_class, B_out)

# ---------- C. 平局: 什么盘口最容易平 ----------
def C_class(r):
    c = devig3(r["CH"],r["CD"],r["CA"])
    if not c: return None
    gap = abs(c[0]-c[2])
    if   gap<0.08: return "①两队极接近(主客概率差<8pp)"
    elif gap<0.20: return "②略有偏向(8-20pp)"
    elif gap<0.40: return "③一方较热(20-40pp)"
    else: return "④一边倒(>40pp)"
bucket_report("C. 主客强弱差 -> 实际打平率", C_class, lambda r: 1.0 if r["ftr"]=="D" else 0.0)

# ---------- 亚盘 favorite-归一 ----------
def fav_frame(r):
    """返回 热门方让球线/开收水位; 以 AHh 符号定热门(负=主热)"""
    if r["AHh"] is None or r["AHHo"] is None or r["AHAo"] is None: return None
    if r["AHh"] < 0:   # 主热
        fav="H"; line_o=r["AHh"]; line_c=r["AHc"]
        wo, wc = r["AHHo"], r["AHHc"]; uo, uc = r["AHAo"], r["AHAc"]
        cov = settle_home(r["m"], r["AHh"])           # 主让, 用开盘线结算
        cov_c = settle_home(r["m"], r["AHc"]) if r["AHc"] is not None else None
    elif r["AHh"] > 0: # 客热
        fav="A"; line_o=-r["AHh"]; line_c=(-r["AHc"] if r["AHc"] is not None else None)
        wo, wc = r["AHAo"], r["AHAc"]; uo, uc = r["AHHo"], r["AHHc"]
        ch = settle_home(r["m"], r["AHh"])
        cov = (1-ch) if ch is not None else None      # 客赢盘=主不赢盘
        chc = settle_home(r["m"], r["AHc"]) if r["AHc"] is not None else None
        cov_c = (1-chc) if chc is not None else None
    else:              # 平手盘
        fav="PK"; line_o=0.0; line_c=(r["AHc"] if r["AHc"] is not None else None)
        wo, wc = r["AHHo"], r["AHHc"]; uo, uc = r["AHAo"], r["AHAc"]
        cov = settle_home(r["m"], 0.0); cov_c = cov
    return dict(fav=fav, line_o=line_o, line_c=line_c, wo=wo, wc=wc, uo=uo, uc=uc, cov=cov, cov_c=cov_c)

# ---------- D. 大热低水让球(让1球+, 上盘低水) -> 过盘率 ----------
def D_class(r):
    ff = fav_frame(r)
    if not ff or ff["fav"]=="PK": return None
    L = abs(ff["line_o"]); w = ff["wo"]
    if w is None: return None
    if L >= 1.0 and w <= 1.85:   return "①深盘(让1球+)低水(<=1.85)"
    if L >= 1.0 and w >  1.85:   return "②深盘(让1球+)高水(>1.85)"
    if 0.5<=L<1.0 and w <= 1.85: return "③半一球内 低水"
    if 0.5<=L<1.0:               return "④半一球内 高水"
    if L < 0.5:                  return "⑤浅盘(平半内)"
    return None
def D_cov(r):
    ff = fav_frame(r); return ff["cov"] if ff else None
bucket_report("D. 让球深浅x上盘水位高低 -> 热门方过盘率(开盘线结算)", D_class, D_cov)

# ---------- E. 盘口水位变化(同线净水位信号) -> 过盘 ----------
def E_class(r):
    ff = fav_frame(r)
    if not ff or ff["fav"]=="PK": return None
    if ff["line_c"] is None or ff["wc"] is None or ff["wo"] is None: return None
    # 仅取 让球线开收不变 的场, 隔离纯水位信号
    if abs(ff["line_c"] - ff["line_o"]) > 1e-9: return None
    d = ff["wc"] - ff["wo"]      # 上盘水位 开->收 变化
    if   d <= -0.04: return "①上盘降水(被追,>=0.04)"
    elif d >=  0.04: return "③上盘升水(被抛,>=0.04)"
    else:            return "②水位基本不动"
def E_cov(r):
    ff = fav_frame(r); return ff["cov_c"] if ff else None
bucket_report("E. [让球线不变]纯上盘水位 开->收变化 -> 热门方过盘率", E_class, E_cov)

# ---------- F. 让球线变化(升盘/降盘) -> 过盘 ----------
def F_class(r):
    ff = fav_frame(r)
    if not ff or ff["fav"]=="PK" or ff["line_c"] is None: return None
    d = abs(ff["line_c"]) - abs(ff["line_o"])   # 热门让球加深为正
    if   d >=  0.24: return "①升盘(让球加深,机构更看好热门)"
    elif d <= -0.24: return "③降盘(让球变浅,热门被看淡)"
    else:            return "②盘口不变"
bucket_report("F. 让球线 开->收 升降 -> 热门方过盘率(收盘线结算)", F_class,
              lambda r:(fav_frame(r) or {}).get("cov_c"))
# F2: 升降盘 -> 热门直接获胜率(非过盘)
def F_win(r):
    ff = fav_frame(r)
    if not ff or ff["fav"]=="PK": return None
    if ff["fav"]=="H": return 1.0 if r["ftr"]=="H" else 0.0
    return 1.0 if r["ftr"]=="A" else 0.0
bucket_report("F2. 让球线 升降 -> 热门方直接获胜率", F_class, F_win)

# ---------- G. 大小球 2.5 开->收漂移 -> 大球命中 ----------
def G_class(r):
    if not (r["Oo"] and r["Oc"]): return None
    # 大球隐含概率(单边粗略 1/赔, 不devig双边因只需方向)
    po, pc = 1/r["Oo"], 1/r["Oc"]
    d = pc - po
    if   d >= 0.02: return "①大球被加注(大球赔率走低)"
    elif d <= -0.02:return "③大球退烧(转向小球)"
    else:           return "②没动"
bucket_report("G. 大小球2.5 开->收漂移 -> 实际打出大球(>2.5)率", G_class,
              lambda r: 1.0 if r["tot"]>=3 else 0.0)

# G2: 收盘大小球赔率分档 -> 大球率(校准)
def G2_class(r):
    if not (r["Oc"] and r["Uc"]): return None
    po = (1/r["Oc"])/((1/r["Oc"])+(1/r["Uc"]))
    if   po>=0.62: return "A 强力大球盘 >62%"
    elif po>=0.55: return "B 偏大球 55-62%"
    elif po>=0.45: return "C 中性 45-55%"
    else:          return "D 偏小球 <45%"
bucket_report("G2. 收盘大小球盘倾向 -> 实际大球率(校准)", G2_class,
              lambda r: 1.0 if r["tot"]>=3 else 0.0)

# ---------- H. 关键交叉: 升盘+降水 / 升盘+升水 等组合 -> 过盘(检验"诱盘"玄学) ----------
def H_class(r):
    ff = fav_frame(r)
    if not ff or ff["fav"]=="PK" or ff["line_c"] is None or ff["wc"] is None or ff["wo"] is None:
        return None
    dl = abs(ff["line_c"]) - abs(ff["line_o"])   # 升盘>0
    dw = ff["wc"] - ff["wo"]                      # 升水>0
    L = "升盘" if dl>=0.24 else ("降盘" if dl<=-0.24 else "盘不变")
    W = "升水" if dw>=0.04 else ("降水" if dw<=-0.04 else "水不变")
    return f"{L}+{W}"
bucket_report("H. [组合]让球线x水位 开->收 -> 热门过盘率(收盘线结算) ※检验诱盘玄学", H_class,
              lambda r:(fav_frame(r) or {}).get("cov_c"))

print("\n基准线(全样本): 主胜 %.1f%% / 平 %.1f%% / 客胜 %.1f%% | 大球(>2.5) %.1f%%" % (
    sum(1 for r in rows if r['ftr']=='H')/len(rows)*100,
    sum(1 for r in rows if r['ftr']=='D')/len(rows)*100,
    sum(1 for r in rows if r['ftr']=='A')/len(rows)*100,
    sum(1 for r in rows if r['tot']>=3)/len(rows)*100))
