"""
美化已生成的 xlsx 文件,用 openpyxl 加专业样式:
- 表头深绿色 + 白字加粗 + 居中 + 14号字 + 行高 32
- 数据行交替灰白底 + 左/居中对齐分流 + 11号字 + 行高 24
- 胜平负列条件格式:主胜淡绿 / 平局淡黄 / 客胜淡红
- 信心列条件格式:🟢 加粗深绿 / 🔴 加粗深红
- 胆 / 双选 / 全选 类型列加 emoji 突出
- 智能列宽 + 文字自动换行 + 冻结表头 + 全表边框
"""
import sys
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.utils import get_column_letter

if len(sys.argv) < 2:
    print("用法: python polish-xlsx.py <path>", file=sys.stderr)
    sys.exit(1)

PATH = sys.argv[1]
wb = load_workbook(PATH)

# === 颜色调色板 ===
HEADER_FILL = PatternFill("solid", fgColor="FF1E5E3F")   # 深绿
HEADER_FONT = Font(name="Microsoft YaHei", size=13, bold=True, color="FFFFFFFF")
DATA_FONT   = Font(name="Microsoft YaHei", size=11, color="FF222222")
DATA_FONT_BOLD = Font(name="Microsoft YaHei", size=11, bold=True, color="FF222222")
EVEN_FILL   = PatternFill("solid", fgColor="FFF4F8F5")   # 浅绿灰
ODD_FILL    = PatternFill("solid", fgColor="FFFFFFFF")

HOME_FILL   = PatternFill("solid", fgColor="FFD4F2D9")   # 主胜淡绿
DRAW_FILL   = PatternFill("solid", fgColor="FFFFF3B0")   # 平局淡黄
AWAY_FILL   = PatternFill("solid", fgColor="FFFBD7CE")   # 客胜淡红

BANKER_FILL = PatternFill("solid", fgColor="FFFFE082")   # 胆码 深黄
DOUBLE_FILL = PatternFill("solid", fgColor="FFE3F2FD")   # 双选 浅蓝
TRIPLE_FILL = PatternFill("solid", fgColor="FFF5F5F5")   # 全选 浅灰

HIGH_CONF_FONT = Font(name="Microsoft YaHei", size=11, bold=True, color="FF1E5E3F")
LOW_CONF_FONT  = Font(name="Microsoft YaHei", size=11, color="FFC62828")

CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT   = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
THIN = Side(style="thin", color="FFD9DDE3")
BORDER = Border(top=THIN, bottom=THIN, left=THIN, right=THIN)


def is_long_text(val):
    return isinstance(val, str) and len(val) > 16


def col_width_for(header, idx):
    h = str(header or "")
    if any(k in h for k in ["选择理由", "理由", "说明", "融合判断要点"]): return 60
    if any(k in h for k in ["对阵", "比赛"]): return 28
    if "概率分布" in h or "概率(主/平/客)" in h or "主/平/客" in h: return 28
    if "信心 · 分级" in h or "信心 ·" in h: return 34
    if any(k in h for k in ["让球", "半全场", "比分"]): return 24
    if any(k in h for k in ["赛事类型", "爆冷"]): return 18
    if "胜平负" in h: return 14
    if "开赛" in h: return 14
    if "覆盖" in h: return 18
    if h in ("序", "场次", "类型", "单式"): return 12
    if idx <= 1: return 12
    if idx <= 4: return 18
    return 20


for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    if ws.max_row < 1: continue

    headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]

    # 表头行
    ws.row_dimensions[1].height = 32
    for c in range(1, ws.max_column + 1):
        cell = ws.cell(1, c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = CENTER
        cell.border = BORDER
        ws.column_dimensions[get_column_letter(c)].width = col_width_for(headers[c-1], c-1)

    # 数据行
    wld_col = next((i+1 for i, h in enumerate(headers) if "胜平负" in str(h) or h == "单式"), None)
    conf_col = next((i+1 for i, h in enumerate(headers) if "信心" in str(h)), None)
    type_col = next((i+1 for i, h in enumerate(headers) if h == "类型"), None)
    long_cols = [i+1 for i, h in enumerate(headers) if any(k in str(h or "") for k in ["选择理由", "比赛", "对阵", "说明", "融合判断要点", "Evidence", "evidence"])]

    for r in range(2, ws.max_row + 1):
        ws.row_dimensions[r].height = 26
        is_even = (r % 2 == 0)
        row_fill = EVEN_FILL if is_even else ODD_FILL

        for c in range(1, ws.max_column + 1):
            cell = ws.cell(r, c)
            cell.font = DATA_FONT
            cell.border = BORDER
            cell.fill = row_fill
            cell.alignment = LEFT if c in long_cols else CENTER

        # wld 列条件着色
        if wld_col:
            wld_val = str(ws.cell(r, wld_col).value or "")
            if "主胜" in wld_val: ws.cell(r, wld_col).fill = HOME_FILL
            elif "平局" in wld_val or wld_val.strip() == "平": ws.cell(r, wld_col).fill = DRAW_FILL
            elif "客胜" in wld_val: ws.cell(r, wld_col).fill = AWAY_FILL

        # 信心列条件字体
        if conf_col:
            conf_val = str(ws.cell(r, conf_col).value or "")
            if "🟢" in conf_val or "较高" in conf_val:
                ws.cell(r, conf_col).font = HIGH_CONF_FONT
            elif "🔴" in conf_val or "低" in conf_val and "偏低" not in conf_val:
                ws.cell(r, conf_col).font = LOW_CONF_FONT

        # 类型列条件填充
        if type_col:
            t = str(ws.cell(r, type_col).value or "").strip()
            if t == "胆":
                ws.cell(r, type_col).fill = BANKER_FILL
                ws.cell(r, type_col).font = DATA_FONT_BOLD
            elif t == "双选":
                ws.cell(r, type_col).fill = DOUBLE_FILL
            elif t == "全选":
                ws.cell(r, type_col).fill = TRIPLE_FILL

    # 冻结表头 + 自动筛选
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"

wb.save(PATH)
print(f"polished: {PATH}")
