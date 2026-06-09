import { writeFileSync } from "node:fs";

export function writeXlsxWorkbook(path, sheets) {
  const files = buildWorkbookFiles(sheets);
  writeFileSync(path, buildZip(files));
}

function buildWorkbookFiles(sheets) {
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": stylesXml()
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet.rows ?? [], sheet.name ?? "");
  });
  return files;
}

function sheetXml(rows, sheetName = "") {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  // 真正的"列头行" = 第一行单元格数等于最大列数的行。标题/banner 这种单格行排在它之前(都算表头带)。
  // 旧逻辑把 rows[0] 当列头 → 标题行(单格)被拿去算列宽,所有列落 fallback;现按真列头行算宽+套样式。
  let headerRowIdx = rows.findIndex((r) => r.length === maxColumns && maxColumns > 0);
  if (headerRowIdx < 0) headerRowIdx = 0;
  const headerBand = headerRowIdx + 1;            // 0..headerRowIdx 都是表头带(标题+banner+列头)
  const widths = chooseColumnWidths(sheetName, rows[headerRowIdx] ?? [], maxColumns);
  const merges = [];
  const body = rows.map((row, rowIndex) => {
    const isHeaderBand = rowIndex < headerBand;
    const isTitleBandRow = isHeaderBand && rowIndex < headerRowIdx;   // 标题/banner(单格,需跨列合并)
    // 标题/banner 行跨所有列合并,撑满整条深紫带,排版整齐。
    if (isTitleBandRow && maxColumns > 1) merges.push(`A${rowIndex + 1}:${columnName(maxColumns)}${rowIndex + 1}`);
    // 行高按内容自动估算:取该行各格在其列宽下换行后的最大行数 × 行距,管够不切字(上限200防极端)。
    let ht;
    if (isTitleBandRow) {
      ht = rowIndex === 0 ? 30 : Math.min(120, Math.max(28, Math.round(estLines(row[0], maxColumns * 9) * 15.5 + 7)));
    } else {
      const lines = row.reduce((mx, value, ci) => Math.max(mx, estLines(value, widths[ci] ?? 14)), 1);
      ht = Math.min(200, Math.max(isHeaderBand ? 30 : 24, Math.round(lines * 15.5 + 7)));
    }
    return `<row r="${rowIndex + 1}" ht="${ht}" customHeight="1">${row.map((value, columnIndex) => cellXml(rowIndex + 1, columnIndex + 1, value, isHeaderBand, rowIndex - headerRowIdx)).join("")}</row>`;
  }).join("");
  const cols = maxColumns ? `<cols>${Array.from({ length: maxColumns }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${widths[index]}" customWidth="1"/>`).join("")}</cols>` : "";
  const views = rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerBand}" topLeftCell="A${headerBand + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  const filter = rows.length > headerBand && maxColumns ? `<autoFilter ref="A${headerRowIdx + 1}:${columnName(maxColumns)}${rows.length}"/>` : "";
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}${cols}<sheetData>${body}</sheetData>${filter}${mergeXml}</worksheet>`;
}

// 样式 ID:
//   0 = 默认
//   1 = 表头(深蓝底/白字加粗居中)
//   2 = 数据行 居中(数字 + 短文本)
//   3 = 数据行 左对齐(对阵 + 选择理由 这种长文本)
//   4 = 偶数数据行 居中 + 浅灰底
//   5 = 偶数数据行 左对齐 + 浅灰底
function cellXml(row, column, value, isHeader = false, dataRowIndex = 0) {
  const ref = `${columnName(column)}${row}`;
  let styleId;
  if (isHeader) {
    styleId = 1;
  } else {
    const isLongText = typeof value === "string" && value.length > 16;
    const isEven = dataRowIndex % 2 === 0;  // dataRowIndex 1 = first data row;1 % 2 = 1 → 奇数 = 白底
    if (isLongText) styleId = isEven ? 5 : 3;
    else            styleId = isEven ? 4 : 2;
  }
  const style = ` s="${styleId}"`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(value ?? "")}</t></is></c>`;
}

function stylesXml() {
  // 字体:0 黑色普通 / 1 白色加粗(表头用)
  // 填充:0 无 / 1 gray125(占位)/ 2 深蓝 表头 / 3 浅灰 偶数行底色
  // 边框:0 无 / 1 上下左右细线灰
  // cellXfs:0 默认 / 1 表头(白字+深蓝底+加粗+居中)/ 2 居中数据 / 3 左对齐数据
  //         / 4 居中数据+浅灰底 / 5 左对齐数据+浅灰底
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
      `<font><sz val="11"/><name val="Microsoft YaHei"/></font>` +
      `<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font>` +
    `</fonts>` +
    `<fills count="4">` +
      `<fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FF4A148C"/><bgColor indexed="64"/></patternFill></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FB"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="2">` +
      `<border><left/><right/><top/><bottom/><diagonal/></border>` +
      `<border><left style="thin"><color rgb="FFD9DDE3"/></left><right style="thin"><color rgb="FFD9DDE3"/></right><top style="thin"><color rgb="FFD9DDE3"/></top><bottom style="thin"><color rgb="FFD9DDE3"/></bottom></border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;
}

// 估算一个单元格在给定列宽下换行后占几行(中文/全角算2显示单位,其余1;含显式换行符 \n 取分段最大)。
function estLines(value, width) {
  if (value == null || value === "") return 1;
  const perLine = Math.max(4, (width ?? 14) - 1); // 列宽可容纳的显示单位(留1边距)
  let maxLines = 1;
  for (const seg of String(value).split("\n")) {
    let w = 0;
    for (const ch of seg) w += /[⺀-鿿＀-￯　-〿]/.test(ch) ? 2 : 1;
    maxLines = Math.max(maxLines, Math.ceil(w / perLine) || 1);
  }
  return maxLines;
}

// 根据 sheet 名和 header 文本自动算列宽(基于中文宽度经验值)
function chooseColumnWidths(sheetName, headers, count) {
  const widths = new Array(count).fill(14);
  for (let i = 0; i < count; i++) {
    const h = String(headers[i] ?? "");
    widths[i] = guessWidth(sheetName, h, i);
  }
  return widths;
}

function guessWidth(sheetName, header, index) {
  // 足球专业版长文本列(放最前·优先级最高,配合内容感知行高,长串少切行少堆高)
  if (/对抗证伪/.test(header)) return 50;
  if (/模型过盘|过盘.*市场|让球.*模型/.test(header)) return 46;
  if (/近5|近五/.test(header)) return 40;
  if (/攻防/.test(header)) return 32;
  if (/半全场赔率/.test(header)) return 32;
  if (/比分赔率|让球赔率/.test(header)) return 30;
  if (/H2H/i.test(header)) return 30;
  if (/赔率/.test(header)) return 27;            // 胜平负赔率/欧赔 等通用赔率列(必须在 /胜平负/→12 之前)
  if (/亚盘/.test(header)) return 24;
  if (/大小球|进球分布/.test(header)) return 22;
  if (/胜负平/.test(header)) return 22;
  if (/信心档/.test(header)) return 13;
  // 关键字段单独宽度
  if (/选择理由|理由|说明|融合判断要点|narrative|reason/i.test(header)) return 56;
  if (/对阵|比赛/.test(header)) return 26;
  if (/概率分布|概率\(|主胜.*平局.*客胜/.test(header)) return 26;
  if (/信心.*分级|信心 · 分级 · EV/.test(header)) return 30;
  if (/让球|半全场|比分/.test(header)) return 22;
  if (/赛事类型|爆冷/.test(header)) return 16;
  if (/胜平负/.test(header)) return 12;
  if (/开赛/.test(header)) return 14;
  if (/^序|^场次/.test(header)) return 10;
  if (/^类型$|^单式$|^覆盖$/.test(header)) return 14;
  // fallback 按列序粗判
  if (index === 0) return 10;
  if (index <= 3) return 16;
  return 18;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuffer.length), u16(0), nameBuffer, data]);
    localParts.push(local);
    centralParts.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuffer.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuffer]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function columnName(number) {
  let name = "";
  while (number > 0) {
    const rem = (number - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
