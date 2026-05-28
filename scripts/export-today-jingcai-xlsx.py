"""
2026-05-28 竞彩 5 场推荐 XLSX 生成器.
新增: 让球胜平负方向 + 比分/半全场各 2 选 + 排版优化.
"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from itertools import combinations

OUTPUT = r"C:\Users\Administrator\Desktop\2026-05-28 竞彩足球推荐.xlsx"

# 数据已经更新为 22:11 Playwright 实时抓的(只有 #005 博卡微调)
fixtures = [
    {
        "seq": "001", "comp": "国际赛", "kickoff": "05-29 02:45",
        "home": "爱尔兰", "away": "卡塔尔",
        "odds0": (1.40, 3.88, 6.35),
        "h_line": -1, "oddsH": (2.50, 3.07, 2.48),
        "hf": {"胜胜":2.02,"胜平":18.00,"胜负":55.00,"平胜":3.90,"平平":5.90,"平负":12.50,"负胜":27.00,"负平":18.00,"负负":11.50},
        "scores_win":  {"1-0":5.50,"2-0":6.00,"2-1":6.80,"3-0":10.00,"3-1":11.00},
        "scores_draw": {"0-0":11.50,"1-1":7.00,"2-2":17.00},
        "scores_loss": {"0-1":14.50,"0-2":35.00,"1-2":18.00},
        "comp_type": "友谊赛",
        "lineup_note": "国际友谊赛,两队均可能轮换;爱尔兰主场实力略优",
        "market_read": "让 -1 后三档接近三平(2.50/3.07/2.48)→ 庄家不信爱尔兰赢超 1 球",
        "model_pick": "主胜",
        "handicap_pick": "客胜",  # 让球后客胜(爱尔兰让 1 球后,卡塔尔输不超 1 球或赢都算客胜)
        "handicap_reason": "让 -1 客胜 2.48 最低 = 庄家认为爱尔兰最多赢 1 球",
        "pick_reason": "1.40 没安全垫;友谊赛建议小注或选让球客胜博中等赔率",
        "score_top1": "1-0", "score_top1_odds": 5.50, "score_top1_why": "跟让 -1 球数一致",
        "score_top2": "2-1", "score_top2_odds": 6.80, "score_top2_why": "友谊赛常见拼盘比分",
        "hf_top1": "胜胜", "hf_top1_odds": 2.02, "hf_top1_why": "庄家半全场最低 = 庄家首选",
        "hf_top2": "平胜", "hf_top2_odds": 3.90, "hf_top2_why": "友谊赛慢热,上半场守和下半场进球",
        "upset_level": "高", "recommendation": "可选",
    },
    {
        "seq": "002", "comp": "葡超", "kickoff": "05-29 03:00",
        "home": "卡萨皮亚", "away": "托林斯",
        "odds0": (2.11, 2.73, 3.46),
        "h_line": -1, "oddsH": (5.40, 3.40, 1.54),
        "hf": {"胜胜":4.00,"胜平":15.00,"胜负":33.00,"平胜":4.15,"平平":3.85,"平负":6.75,"负胜":30.00,"负平":15.00,"负负":6.30},
        "scores_win":  {"1-0":5.40,"2-0":8.50,"2-1":7.50},
        "scores_draw": {"0-0":7.00,"1-1":5.25,"2-2":17.00},
        "scores_loss": {"0-1":7.25,"0-2":14.00,"1-2":10.50},
        "comp_type": "联赛",
        "lineup_note": "葡超低位附加赛;让 -1 主队赔率暴涨到 5.40",
        "market_read": "半全场平平 3.85 最低 + 比分 1-1 (5.25) 整场最低 → 庄家真实预期平局",
        "model_pick": "平局",  # 不是主胜
        "handicap_pick": "客胜",  # 让 -1 后客胜 1.54 极低 = 主队赢 1 球以下/输都是客胜
        "handicap_reason": "让 -1 客胜 1.54 整场最低 = 庄家几乎确信主队不会赢超 1 球",
        "pick_reason": "三档赔率证据指向平局:半全场平平最低、比分 1-1 最低、让 -1 主胜暴涨",
        "score_top1": "1-1", "score_top1_odds": 5.25, "score_top1_why": "整场最低赔率",
        "score_top2": "0-0", "score_top2_odds": 7.00, "score_top2_why": "平局组第二低,庄家预期低进球",
        "hf_top1": "平平", "hf_top1_odds": 3.85, "hf_top1_why": "整场 9 个 outcome 最低 = 庄家最自信",
        "hf_top2": "胜胜", "hf_top2_odds": 4.00, "hf_top2_why": "如果坚持选主胜的备用",
        "upset_level": "中", "recommendation": "强推平局",
    },
    {
        "seq": "003", "comp": "解放者杯", "kickoff": "05-29 06:00",
        "home": "波特诺", "away": "水晶体育",
        "odds0": (1.51, 3.40, 5.80),
        "h_line": -1, "oddsH": (3.05, 2.85, 2.22),
        "hf": {"胜胜":2.40,"胜平":17.00,"胜负":55.00,"平胜":3.50,"平平":5.00,"平负":12.50,"负胜":23.00,"负平":17.00,"负负":11.00},
        "scores_win":  {"1-0":5.50,"2-0":6.50,"2-1":6.75},
        "scores_draw": {"0-0":10.00,"1-1":6.70,"2-2":17.00},
        "scores_loss": {"0-1":11.00,"0-2":26.00,"1-2":14.50},
        "comp_type": "杯赛-小组",
        "lineup_note": "解放者杯小组赛;双方无重大伤停报告",
        "market_read": "让 -1 后客胜赔率 2.22 反成最低 → 庄家觉得水晶体育有反弹力",
        "model_pick": "主胜",
        "handicap_pick": "客胜",
        "handicap_reason": "让 -1 客胜 2.22 最低 = 庄家认为波特诺最多赢 1 球或被反扑",
        "pick_reason": "主胜 1.51 较安全;但杯赛客队拼搏 + 让 -1 客胜赔率最低 = 谨慎",
        "score_top1": "1-0", "score_top1_odds": 5.50, "score_top1_why": "跟让 -1 球数一致",
        "score_top2": "2-1", "score_top2_odds": 6.75, "score_top2_why": "杯赛对抗强度高的常见比分",
        "hf_top1": "平胜", "hf_top1_odds": 3.50, "hf_top1_why": "杯赛上半场常对峙,下半场进球",
        "hf_top2": "胜胜", "hf_top2_odds": 2.40, "hf_top2_why": "庄家最低半全场赔率",
        "upset_level": "中", "recommendation": "可选",
    },
    {
        "seq": "004", "comp": "解放者杯", "kickoff": "05-29 06:00",
        "home": "帕梅拉斯", "away": "巴兰基亚",
        "odds0": (1.14, 5.95, 12.00),
        "h_line": -2, "oddsH": (2.85, 3.45, 2.05),
        "hf": {"胜胜":1.50,"胜平":30.00,"胜负":90.00,"平胜":3.70,"平平":9.20,"平负":23.00,"负胜":24.00,"负平":30.00,"负负":22.00},
        "scores_win":  {"1-0":6.50,"2-0":5.00,"2-1":8.50,"3-0":5.50,"3-1":10.00,"4-0":10.00},
        "scores_draw": {"0-0":17.00,"1-1":11.00,"2-2":27.00},
        "scores_loss": {"0-1":30.00,"0-2":85.00,"1-2":38.00},
        "comp_type": "杯赛-小组",
        "lineup_note": "巴兰基亚队长查拉缺席(肌肉伤)、中卫蒙松出战成疑;帕梅主力齐",
        "market_read": "让 -2 主胜仍 2.85 → 庄家认为赢 2 球+正常;比分 2-0 (5.00) 整场最低",
        "model_pick": "主胜",
        "handicap_pick": "客胜",
        "handicap_reason": "让 -2 客胜 2.05 最低 = 庄家觉得帕梅赢不到 3 球(让 -2 客胜 = 主队赢 0/1/2 球或输)",
        "pick_reason": "对手 2 主力伤 + 主场 + 让 -2 还 2.85 + 概率 77.7%;5 场唯一强推",
        "score_top1": "2-0", "score_top1_odds": 5.00, "score_top1_why": "整场最低赔率,庄家首选",
        "score_top2": "3-0", "score_top2_odds": 5.50, "score_top2_why": "跟让 -2 一致,主胜组第二低",
        "hf_top1": "胜胜", "hf_top1_odds": 1.50, "hf_top1_why": "1.50 几乎极值 = 庄家几乎确信",
        "hf_top2": "平胜", "hf_top2_odds": 3.70, "hf_top2_why": "若上半场对手摆守备,下半场拿下",
        "upset_level": "低", "recommendation": "强推",
    },
    {
        "seq": "005", "comp": "解放者杯", "kickoff": "05-29 08:30",
        "home": "博卡", "away": "天主大学",
        "odds0": (1.36, 4.00, 6.95),  # Playwright 抓的最新赔率
        "h_line": -1, "oddsH": (2.53, 2.80, 2.65),
        "hf": {"胜胜":1.95,"胜平":22.00,"胜负":65.00,"平胜":3.55,"平平":6.00,"平负":14.00,"负胜":25.00,"负平":22.00,"负负":13.50},
        "scores_win":  {"1-0":5.00,"2-0":5.00,"2-1":7.75,"3-0":8.00},
        "scores_draw": {"0-0":10.00,"1-1":8.00,"2-2":25.00},
        "scores_loss": {"0-1":15.00,"0-2":40.00,"1-2":22.00},
        "comp_type": "杯赛-小组",
        "lineup_note": "博卡 3 主力伤(卡瓦尼+基万尼斯+阿斯卡西巴尔);锋线火力受损",
        "market_read": "让 -1 后三档极接近(2.53/2.80/2.65) = 庄家完全不信博卡赢超 1 球",
        "model_pick": "主胜",
        "handicap_pick": "主胜",  # 让 -1 后微妙:主胜 2.53 是最低
        "handicap_reason": "让 -1 后三档接近三平 → 让球胜选主胜赌博卡咬牙赢一球,EV 中等",
        "pick_reason": "主胜 1.36 看似稳但 3 主力伤是大变量;若投建议主胜小注或让球平局",
        "score_top1": "1-0", "score_top1_odds": 5.00, "score_top1_why": "博卡阵容残缺,1-0 比 2-0 更稳",
        "score_top2": "2-0", "score_top2_odds": 5.00, "score_top2_why": "同赔率,但需要锋线发力",
        "hf_top1": "平胜", "hf_top1_odds": 3.55, "hf_top1_why": "3 主力伤,上半场守和下半场拿下",
        "hf_top2": "胜胜", "hf_top2_odds": 1.95, "hf_top2_why": "庄家最低半全场,但跟阵容现状矛盾",
        "upset_level": "中高", "recommendation": "谨慎",
    }
]

# ───── 样式调色板 ─────
HEADER_FILL = PatternFill("solid", start_color="1F4E79")
HEADER_FONT = Font(name="微软雅黑", bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(name="微软雅黑", bold=True, size=16, color="FFFFFF")
TITLE_FILL = PatternFill("solid", start_color="1F4E79")
DEFAULT_FONT = Font(name="微软雅黑", size=11)
BOLD_FONT = Font(name="微软雅黑", bold=True, size=11)
RECOMMEND_FONT = Font(name="微软雅黑", bold=True, color="C00000", size=11)
ALT_FILL = PatternFill("solid", start_color="F2F7FC")
SECTION_FILL = PatternFill("solid", start_color="2E75B6")
SECTION_FONT = Font(name="微软雅黑", bold=True, size=13, color="FFFFFF")
THIN = Side(border_style="thin", color="9CC3E5")
MEDIUM = Side(border_style="medium", color="1F4E79")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
MEDIUM_BORDER = Border(left=MEDIUM, right=MEDIUM, top=MEDIUM, bottom=MEDIUM)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT_WRAP = Alignment(horizontal="left", vertical="center", wrap_text=True)

DIRECTION_COLORS = {
    "主胜": PatternFill("solid", start_color="A9D08E"),
    "平局": PatternFill("solid", start_color="FFD966"),
    "客胜": PatternFill("solid", start_color="F4B084"),
}
RECOMMEND_COLORS = {
    "强推": ("00B050", "FFFFFF"),
    "强推平局": ("00B050", "FFFFFF"),
    "推荐": ("92D050", "000000"),
    "可选": ("FFC000", "000000"),
    "谨慎": ("ED7D31", "FFFFFF"),
    "避坑": ("C00000", "FFFFFF"),
}
UPSET_COLORS = {
    "低": "C6E0B4", "中": "FFE699", "中高": "F8CBAD", "高": "F4B084"
}

def style_header(cell):
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = CENTER
    cell.border = BORDER

def style_section(cell):
    cell.fill = SECTION_FILL
    cell.font = SECTION_FONT
    cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    cell.border = BORDER

def style_cell(cell, alt=False, recommend=False, bold=False, wrap=False, center=True):
    if recommend:
        cell.font = RECOMMEND_FONT
    elif bold:
        cell.font = BOLD_FONT
    else:
        cell.font = DEFAULT_FONT
    cell.alignment = CENTER if center and not wrap else (LEFT_WRAP if wrap else Alignment(vertical="center"))
    cell.border = BORDER
    if alt and not cell.fill.start_color.rgb:
        cell.fill = ALT_FILL

# ───── 创建 workbook ─────
wb = Workbook()
s = wb.active
s.title = "2026-05-28 竞彩 5 场"

# ───── 标题行 ─────
s.cell(row=1, column=1, value="🏆 2026-05-28 竞彩足球 5 场综合推荐")
s.cell(row=1, column=1).font = TITLE_FONT
s.cell(row=1, column=1).fill = TITLE_FILL
s.cell(row=1, column=1).alignment = Alignment(horizontal="center", vertical="center")
s.merge_cells("A1:N1")
s.row_dimensions[1].height = 36

s.cell(row=2, column=1, value=f"数据来源: 500.com Playwright 实时抓 + 用户截图 + 球迷屋阵容信息  |  方向 = 综合赔率结构+让球盘+半全场+比分赔率+阵容判断 (不是机械挑赔率最低)")
s.cell(row=2, column=1).font = Font(name="微软雅黑", italic=True, size=10, color="595959")
s.cell(row=2, column=1).alignment = Alignment(horizontal="center", vertical="center")
s.merge_cells("A2:N2")
s.row_dimensions[2].height = 22

# ───── 区段 1: 单关推荐(主表)─────
s.cell(row=4, column=1, value="一、5 场单关推荐(综合判断)")
style_section(s.cell(row=4, column=1))
s.merge_cells("A4:N4")
s.row_dimensions[4].height = 26

headers = [
    "编号", "联赛", "性质", "对阵",
    "胜负平方向", "概率", "赔率",
    "让球方向", "让球赔率",
    "比分首选", "比分次选",
    "半全场首选", "半全场次选",
    "建议"
]
for j, h in enumerate(headers, 1):
    style_header(s.cell(row=5, column=j, value=h))
s.row_dimensions[5].height = 38

def normalize(odds):
    inv = [1/o for o in odds]
    total = sum(inv)
    return tuple(p / total for p in inv)

def prob_for_pick(f, pick):
    probs = normalize(f["odds0"])
    if pick == "主胜":
        return probs[0]
    elif pick == "平局":
        return probs[1]
    else:
        return probs[2]

def odds_for_pick(f, pick):
    if pick == "主胜":
        return f["odds0"][0]
    elif pick == "平局":
        return f["odds0"][1]
    else:
        return f["odds0"][2]

def odds_for_handicap(f, pick):
    if pick == "主胜":
        return f["oddsH"][0]
    elif pick == "平局":
        return f["oddsH"][1]
    else:
        return f["oddsH"][2]

for i, f in enumerate(fixtures, 6):
    pick = f["model_pick"]
    h_pick = f["handicap_pick"]

    pick_short = f"{pick}\n({f['home']})" if pick == "主胜" else f"{pick}\n({f['away']})" if pick == "客胜" else pick
    h_pick_short = f"{h_pick}\n({f['home']})" if h_pick == "主胜" else f"{h_pick}\n({f['away']})" if h_pick == "客胜" else h_pick

    s.cell(row=i, column=1, value=f"周四{f['seq']}")
    s.cell(row=i, column=2, value=f["comp"])
    s.cell(row=i, column=3, value=f["comp_type"])
    s.cell(row=i, column=4, value=f"{f['home']}\nVS\n{f['away']}")
    s.cell(row=i, column=5, value=pick_short)
    s.cell(row=i, column=6, value=round(prob_for_pick(f, pick), 4))
    s.cell(row=i, column=7, value=odds_for_pick(f, pick))
    s.cell(row=i, column=8, value=f"让 {f['h_line']}\n{h_pick_short}")
    s.cell(row=i, column=9, value=odds_for_handicap(f, h_pick))
    s.cell(row=i, column=10, value=f"{f['score_top1']}\n({f['score_top1_odds']})")
    s.cell(row=i, column=11, value=f"{f['score_top2']}\n({f['score_top2_odds']})")
    s.cell(row=i, column=12, value=f"{f['hf_top1']}\n({f['hf_top1_odds']})")
    s.cell(row=i, column=13, value=f"{f['hf_top2']}\n({f['hf_top2_odds']})")
    s.cell(row=i, column=14, value=f["recommendation"])

    alt = (i % 2 == 0)
    for j in range(1, 15):
        c = s.cell(row=i, column=j)
        is_rec = j in [5, 8, 10, 11, 12, 13, 14]
        style_cell(c, alt=alt, recommend=is_rec, bold=(j in [4]))
    # 列着色
    s.cell(row=i, column=5).fill = DIRECTION_COLORS.get(pick, PatternFill())
    s.cell(row=i, column=8).fill = DIRECTION_COLORS.get(h_pick, PatternFill())
    rc_fg, rc_text = RECOMMEND_COLORS.get(f["recommendation"], ("808080", "FFFFFF"))
    s.cell(row=i, column=14).fill = PatternFill("solid", start_color=rc_fg)
    s.cell(row=i, column=14).font = Font(name="微软雅黑", bold=True, size=11, color=rc_text)
    s.cell(row=i, column=6).number_format = "0.0%"
    s.cell(row=i, column=7).number_format = "0.00"
    s.cell(row=i, column=9).number_format = "0.00"
    s.row_dimensions[i].height = 60

# ───── 区段 2: 深度分析 ─────
row = 12
s.cell(row=row, column=1, value="二、深度分析(为什么选这个方向、比分、半全场)")
style_section(s.cell(row=row, column=1))
s.merge_cells(f"A{row}:N{row}")
s.row_dimensions[row].height = 26
row += 1

sub_headers = ["编号", "对阵", "市场结构解读", "胜负方向理由", "让球方向理由", "比分理由", "半全场理由", "阵容/伤停", "爆冷"]
for j, h in enumerate(sub_headers, 1):
    style_header(s.cell(row=row, column=j, value=h))
# 合并最后一列让爆冷字段宽一些
s.merge_cells(start_row=row, start_column=8, end_row=row, end_column=13)
s.cell(row=row, column=14, value="爆冷")
style_header(s.cell(row=row, column=14))
s.row_dimensions[row].height = 28
row += 1

# 重新发头(因为合并破了)
def add_analysis_row(r, f, alt):
    s.cell(row=r, column=1, value=f"周四{f['seq']}")
    s.cell(row=r, column=2, value=f"{f['home']}\nVS {f['away']}")
    s.cell(row=r, column=3, value=f["market_read"])
    s.cell(row=r, column=4, value=f["pick_reason"])
    s.cell(row=r, column=5, value=f["handicap_reason"])
    s.cell(row=r, column=6, value=f"{f['score_top1_why']} / {f['score_top2_why']}")
    s.cell(row=r, column=7, value=f"{f['hf_top1_why']} / {f['hf_top2_why']}")
    s.cell(row=r, column=8, value=f["lineup_note"])
    s.cell(row=r, column=14, value=f["upset_level"])
    for j in range(1, 15):
        c = s.cell(row=r, column=j)
        style_cell(c, alt=alt, wrap=(j in [2, 3, 4, 5, 6, 7, 8]))
    s.merge_cells(start_row=r, start_column=8, end_row=r, end_column=13)
    s.cell(row=r, column=14).fill = PatternFill("solid", start_color=UPSET_COLORS.get(f["upset_level"], "FFFFFF"))
    s.cell(row=r, column=14).font = BOLD_FONT
    s.row_dimensions[r].height = 78

for f in fixtures:
    alt = (row % 2 == 0)
    add_analysis_row(row, f, alt)
    row += 1

# ───── 区段 3: 串关 ─────
row += 1
s.cell(row=row, column=1, value="三、串关组合(基于真方向:#002 平局,其余 4 主胜)")
style_section(s.cell(row=row, column=1))
s.merge_cells(f"A{row}:N{row}")
s.row_dimensions[row].height = 26
row += 1

combo_headers = ["类型", "组合内容", "联合赔率", "联合概率", "联合 EV", "10 元回报", "10 元净盈", "建议"]
for j, h in enumerate(combo_headers, 1):
    style_header(s.cell(row=row, column=j, value=h))
s.row_dimensions[row].height = 28
row += 1

legs = [{"seq": f["seq"], "home": f["home"], "away": f["away"], "pick": f["model_pick"],
         "odds": odds_for_pick(f, f["model_pick"]), "prob": prob_for_pick(f, f["model_pick"]),
         "rec": f["recommendation"]} for f in fixtures]

def fmt_leg(l):
    if l["pick"] == "主胜":
        return f"#{l['seq']}{l['home']}胜"
    elif l["pick"] == "客胜":
        return f"#{l['seq']}{l['away']}胜"
    return f"#{l['seq']}{l['home']}-{l['away']}平"

def combo_stats(combo):
    co = 1; cp = 1
    for l in combo:
        co *= l["odds"]; cp *= l["prob"]
    return co, cp, cp * co - 1

def combo_advice(combo, ev):
    if any(l["rec"] == "避坑" for l in combo):
        return "不建议(含避坑)"
    if any("强推" in l["rec"] for l in combo) and all(l["rec"] != "谨慎" for l in combo):
        return "可考虑"
    if sum(1 for l in combo if l["rec"] == "谨慎") and len(combo) >= 3:
        return "谨慎(多腿+含谨慎)"
    if ev < -0.35:
        return "EV 太负"
    return "可考虑"

def fill_combo_row(r, label, combo_list, alt=False, bold=False):
    co, cp, ev = combo_stats(combo_list)
    s.cell(row=r, column=1, value=label)
    s.cell(row=r, column=2, value=" + ".join(fmt_leg(l) for l in combo_list))
    s.cell(row=r, column=3, value=round(co, 3))
    s.cell(row=r, column=4, value=round(cp, 4))
    s.cell(row=r, column=5, value=round(ev, 4))
    s.cell(row=r, column=6, value=round(10 * co, 2))
    s.cell(row=r, column=7, value=round(10 * co - 10, 2))
    s.cell(row=r, column=8, value=combo_advice(combo_list, ev))
    for j in range(1, 9):
        style_cell(s.cell(row=r, column=j), alt=alt, recommend=(j == 8), bold=bold)
    s.cell(row=r, column=3).number_format = "0.00"
    s.cell(row=r, column=4).number_format = "0.0%"
    s.cell(row=r, column=5).number_format = "0.0%;[Red](0.0%)"
    s.cell(row=r, column=6).number_format = "0.00"
    s.cell(row=r, column=7).number_format = "0.00"
    s.row_dimensions[r].height = 24

# 五串一
fill_combo_row(row, "五串一(全方向)", legs, bold=True); row += 1

# 四串一 top 3
four = sorted([(combo_stats(c), c) for c in combinations(legs, 4)], key=lambda x: x[0][2], reverse=True)[:3]
for k, ((co, cp, ev), combo) in enumerate(four):
    fill_combo_row(row, f"四串一 #{k+1}", combo, alt=(row % 2 == 0)); row += 1

# 三串一 top 5
three = sorted([(combo_stats(c), c) for c in combinations(legs, 3)], key=lambda x: x[0][2], reverse=True)[:5]
for k, ((co, cp, ev), combo) in enumerate(three):
    fill_combo_row(row, f"三串一 #{k+1}", combo, alt=(row % 2 == 0)); row += 1

# 二串一 top 5
two = sorted([(combo_stats(c), c) for c in combinations(legs, 2)], key=lambda x: x[0][2], reverse=True)[:5]
for k, ((co, cp, ev), combo) in enumerate(two):
    fill_combo_row(row, f"二串一 #{k+1}", combo, alt=(row % 2 == 0)); row += 1

# 清掉超出 8 列的 cells(防止串关区段误用其他列)
# (跳过)

# ───── 区段 4: 重要说明 ─────
row += 1
s.cell(row=row, column=1, value="四、关键说明(读图必看)")
style_section(s.cell(row=row, column=1))
s.merge_cells(f"A{row}:N{row}")
s.row_dimensions[row].height = 26
row += 1

notes = [
    ("胜负平方向 vs 让球方向", "胜负平方向 = 让 0 球;让球方向 = 让 -N 球。两个方向可不同,独立投注。如 #002 让 0 推平局、让 -1 推客胜"),
    ("比分两个选择的逻辑", "首选 = 整场比分赔率最低 / 跟方向 + 让球盘一致;次选 = 备用方案,赔率次低且符合杯赛/阵容预期"),
    ("半全场两个选择的逻辑", "首选 = 跟方向一致的最低赔率;次选 = 考虑战术(杯赛常上半场对峙)或阵容残缺(慢热)的备用"),
    ("#002 真方向是平局不是主胜", "三个独立信号:半全场平平 3.85 整场最低 + 比分 1-1 (5.25) 整场最低 + 让 -1 主胜暴涨到 5.40,庄家真实预期就是平局"),
    ("#004 比分 2-0 不是 1-0", "让 -2 后主胜仍 2.85,庄家认为帕梅赢 2 球+正常;2-0 (5.00) 是整场所有比分里最低"),
    ("#005 博卡谨慎 + 半全场平胜", "3 主力伤后火力不足,即便主场赔率 1.36 仍有爆冷风险;半全场平胜(上半场守和)比胜胜更符合现实"),
    ("爆冷指数", "低=赔率与实力吻合 / 中=有反扑风险 / 中高=关键阵容残缺 / 高=不建议追"),
    ("建议色阶", "🟢 强推 / 🟢 强推平局 / 🟠 可选 / 🟠 谨慎 / 🔴 避坑")
]
for label, txt in notes:
    s.cell(row=row, column=1, value=label).font = Font(name="微软雅黑", bold=True, size=10)
    s.cell(row=row, column=1).alignment = Alignment(horizontal="left", vertical="top")
    s.cell(row=row, column=2, value=txt).font = Font(name="微软雅黑", size=10)
    s.cell(row=row, column=2).alignment = LEFT_WRAP
    s.cell(row=row, column=1).fill = ALT_FILL
    s.cell(row=row, column=2).fill = ALT_FILL
    s.merge_cells(start_row=row, start_column=2, end_row=row, end_column=14)
    s.row_dimensions[row].height = 26
    row += 1

# ───── 列宽 ─────
widths = {
    "A": 10, "B": 11, "C": 11, "D": 16,
    "E": 13, "F": 9, "G": 9,
    "H": 13, "I": 11,
    "J": 12, "K": 12, "L": 12, "M": 12,
    "N": 12,
}
for letter, w in widths.items():
    s.column_dimensions[letter].width = w

# 冻结前 5 行
s.freeze_panes = "A6"

wb.save(OUTPUT)
print(f"Saved: {OUTPUT}")
print()
print("=== 5 场最终推荐 ===")
for f in fixtures:
    print(f"#{f['seq']} {f['home']:6} VS {f['away']:6} | 让0 {f['model_pick']:4} ({odds_for_pick(f, f['model_pick'])}) | 让{f['h_line']} {f['handicap_pick']:4} ({odds_for_handicap(f, f['handicap_pick'])}) | 比分 {f['score_top1']}/{f['score_top2']} | 半全 {f['hf_top1']}/{f['hf_top2']} | {f['recommendation']}")
