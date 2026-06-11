# -*- coding: utf-8 -*-
"""check-wc-xlsx —— 竞彩交付xlsx结构/透明度/概率合法性检查器(audit-wc-pipeline S4 调用)。
用法: python scripts/check-wc-xlsx.py <xlsx路径>
输出: 单行JSON {ok, cols, errors[], warnings[], matches:[{home,away}]} 到 stdout。
口径(2026-06-10 用户裁决):四玩法独立裁决可不同向,但必须透明——
让球列必须带 过盘%(模型)vs%(市场)+与胜平负同/不同向标注;比分/半全场必须标主推来源;
Elo先验三项和=100;任何单元格不得出现 undefined/NaN/None 渲染垃圾。
"""
import json
import re
import sys

import openpyxl

REQUIRED_HEADERS = [
    "开赛", "对阵", "胜负平", "胜平负赔率", "Elo先验", "场馆λ", "出线/夺冠",
    "让球方向", "竞彩让球", "信号面板", "比分", "半全场", "大小球", "进球分布",
    "近5", "H2H", "信心", "串关", "对抗证伪",
]
PURPLE = "FF4A148C"
GARBAGE = re.compile(r"undefined|\bNaN\b|\bNone\b|\{\{|&lt;span")
DIR_WORDS = ("主胜", "平局", "客胜")


def main(path):
    errors, warnings, matches = [], [], []
    wb = openpyxl.load_workbook(path)
    if "竞彩完整" not in wb.sheetnames:
        print(json.dumps({"ok": False, "cols": 0, "errors": ["缺'竞彩完整'sheet"], "warnings": [], "matches": []}, ensure_ascii=False))
        return
    if "数据审计" not in wb.sheetnames:
        errors.append("缺'数据审计'sheet(完整性审计是固定标准)")
    ws = wb["竞彩完整"]

    # 自动定位真列头行(标题banner在上方)
    head_row = None
    for r in range(1, min(ws.max_row, 10) + 1):
        vals = [str(ws.cell(r, c).value or "") for c in range(1, ws.max_column + 1)]
        if vals[0].strip() == "#" and any("对阵" in v for v in vals):
            head_row = r
            break
    if head_row is None:
        errors.append("找不到列头行(首列#+含'对阵')")
        print(json.dumps({"ok": False, "cols": 0, "errors": errors, "warnings": warnings, "matches": []}, ensure_ascii=False))
        return

    headers = [str(ws.cell(head_row, c).value or "") for c in range(1, ws.max_column + 1)]
    col = {}
    for kw in REQUIRED_HEADERS:
        idx = next((i + 1 for i, h in enumerate(headers) if kw in h), None)
        if idx is None:
            errors.append(f"缺列: {kw}")
        else:
            col[kw] = idx
    if len([h for h in headers if h]) < 24:
        errors.append(f"列数{len([h for h in headers if h])}<24,专业版维度被简化")

    # 标题banner + 深紫表头(神选标准 FF4A148C)
    if "神选" not in str(ws.cell(1, 1).value or ""):
        warnings.append("标题行无'神选'banner")
    purple = sum(1 for c in range(1, len(headers) + 1)
                 if str(getattr(ws.cell(head_row, c).fill.start_color, "rgb", "")) == PURPLE)
    if purple < len([h for h in headers if h]) * 0.8:
        errors.append(f"表头深紫{PURPLE}仅{purple}/{len([h for h in headers if h])}格(排版标准被改坏)")

    for r in range(head_row + 1, ws.max_row + 1):
        if ws.cell(r, 1).value is None:
            continue
        row_name = f"行{r}"
        cells = {kw: str(ws.cell(r, c).value or "") for kw, c in col.items()}
        pair = cells.get("对阵", "")
        # 取首行(第二行起是情景描述);末尾赛事tag形如"(世界杯·单场)"从尾部剥掉,
        # 避免吃掉队名自带括号(如 刚果(金))
        core = re.sub(r"[\(（][^()（）]*·[^()（）]*[\)）]\s*$", "", pair.splitlines()[0] if pair else "").strip()
        m = re.match(r"\s*(.+?)\s+vs\s+(.+)$", core)
        if not m:
            errors.append(f"{row_name} 对阵格式异常: {pair[:30]}")
            continue
        home, away = m.group(1).strip(), m.group(2).strip()
        row_name = f"{home}-{away}"
        matches.append({"home": home, "away": away})

        joined = "|".join(cells.values())
        if GARBAGE.search(joined):
            errors.append(f"{row_name} 单元格含渲染垃圾(undefined/NaN/None)")

        # 胜负平: 主选X(p%) 或 ⛔未开售(带原因); 双选前缀必含主选方向
        wld = cells.get("胜负平", "")
        if "未开售" in wld:
            if "(" not in wld:
                errors.append(f"{row_name} 未开售无原因标注")
        else:
            mm = re.search(r"主选\s*(主胜|平局|客胜)\((\d+)%\)", wld)
            if not mm:
                errors.append(f"{row_name} 胜负平缺'主选 方向(p%)': {wld[:30]}")
            else:
                p = int(mm.group(2))
                if not 1 <= p <= 99:
                    errors.append(f"{row_name} 主选概率{p}%越界")
                ds = re.search(r"双选([^\s(]+)", wld)
                if ds and mm.group(1) not in ds.group(1):
                    errors.append(f"{row_name} 双选'{ds.group(1)}'不含主选方向{mm.group(1)}(方向锚破)")

        # Elo先验: 主X%/平Y%/客Z% 和=100±2
        elo = cells.get("Elo先验", "")
        probs = re.findall(r"(?:主|平|客)(\d+)%", elo)
        if len(probs) == 3:
            s = sum(int(x) for x in probs)
            if not 98 <= s <= 102:
                errors.append(f"{row_name} Elo先验三项和={s}≠100")
        elif "缺" not in elo and "⚠️" not in elo:
            errors.append(f"{row_name} Elo先验列无三向概率也无缺数标注: {elo[:30]}")

        # 让球透明度: 双过盘数 + 同/不同向标注(独立裁决但必须透明)
        rq = cells.get("让球方向", "")
        if rq.count("过盘") < 1 or "(模型)" not in rq or "(市场)" not in rq:
            errors.append(f"{row_name} 让球列缺'过盘%(模型)vs%(市场)'透明双数: {rq[:30]}")
        if "与胜平负" not in rq:
            errors.append(f"{row_name} 让球列缺与胜平负同/不同向标注")

        # 比分: 主推 + ≥3个 比分(p%);只查主推区前3档降序(单元格后段可能附全档列表)
        score = cells.get("比分", "")
        sc = [int(x) for x in re.findall(r"\d+-\d+\((\d+)%\)", score)]
        if "主推" not in score:
            errors.append(f"{row_name} 比分列缺'主推'来源标注")
        if len(sc) < 3:
            errors.append(f"{row_name} 比分主推不足3档: {score[:30]}")
        elif any(sc[i] < sc[i + 1] for i in range(2)):
            errors.append(f"{row_name} 比分主推前3档非降序: {sc[:3]}")

        # 半全场: 主推 + ≥2个 组合(p%)
        hf = cells.get("半全场", "")
        hfp = re.findall(r"(主胜|平局|客胜)-(主胜|平局|客胜)\((\d+)%\)", hf)
        if "主推" not in hf and "🔶" not in hf:
            errors.append(f"{row_name} 半全场缺主推/🔶来源标注")
        if len(hfp) < 2:
            errors.append(f"{row_name} 半全场组合不足2档: {hf[:30]}")

        # 审计轨迹列非空
        for kw in ("对抗证伪", "串关", "信心"):
            if not cells.get(kw, "").strip():
                errors.append(f"{row_name} '{kw}'列为空(审计轨迹断)")

    if not matches:
        errors.append("竞彩完整sheet无数据行")
    print(json.dumps({"ok": not errors, "cols": len([h for h in headers if h]),
                      "errors": errors, "warnings": warnings, "matches": matches}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
