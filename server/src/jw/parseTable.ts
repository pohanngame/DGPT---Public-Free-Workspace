import { SLOT_CODES } from '../contract.ts'

/** 一位教师的整行 td 数：1 列姓名 + 7 天 × 6 节次组。 */
const COLUMNS_PER_TEACHER_ROW = 43

/** 表头占前两行：第 1 行星期、第 2 行节次组。 */
const HEADER_ROWS = 2

const TABLE_PATTERN =
  /<table[^>]*id=["']?kbtable["']?[^>]*>(.*?)<\/table>/is
const ROW_PATTERN = /<tr[^>]*>(.*?)<\/tr>/gis
const CELL_PATTERN = /<td[^>]*>(.*?)<\/td>/gis
const TAG_PATTERN = /<[^>]+>/g
const NOBR_PATTERN = /<nobr[^>]*>(.*?)<\/nobr>/gis
/** `(2-13周)`、`1-16周`、`(2-13周(单))` 等写法统一取周次数字段。 */
const WEEK_RANGE_PATTERN = /(\d{1,2})\s*-\s*(\d{1,2})\s*周/
const WEEK_SINGLE_PATTERN = /(\d{1,2})\s*周/
const WEEK_LIST_PATTERN = /([0-9,\s]{1,80})\s*周/g

export interface ParsedCell {
  dayOfWeek: number
  slotCode: string
  weekStart: number
  weekEnd: number
  occupancyText: string
}

export interface ParsedTeacherRow {
  name: string
  cells: ParsedCell[]
}

export function parseTeacherTable(html: string): ParsedTeacherRow[] {
  if (!html.trim()) {
    return []
  }
  const table = TABLE_PATTERN.exec(html)
  if (!table?.[1]) {
    return []
  }
  const teachers: ParsedTeacherRow[] = []
  let rowIndex = -1
  for (const row of table[1].matchAll(ROW_PATTERN)) {
    rowIndex++
    if (rowIndex < HEADER_ROWS) {
      continue
    }
    const parsed = parseRow(row[1] ?? '')
    if (parsed) {
      teachers.push(parsed)
    }
  }
  return teachers
}

function parseRow(rowHtml: string): ParsedTeacherRow | null {
  const cells = [...rowHtml.matchAll(CELL_PATTERN)].map((match) => match[1] ?? '')
  if (cells.length !== COLUMNS_PER_TEACHER_ROW) {
    return null
  }
  const name = extractTeacherName(cells[0] ?? '')
  if (!name) {
    return null
  }
  const occupancies: ParsedCell[] = []
  // 第 1 列是姓名，其后 42 列：列号 1..42 -> 天 = floor((列-1)/6)+1。
  for (let column = 1; column < COLUMNS_PER_TEACHER_ROW; column++) {
    const occupancyText = toPlainText(cells[column] ?? '')
    if (!occupancyText) {
      continue
    }
    const dayOfWeek = Math.floor((column - 1) / SLOT_CODES.length) + 1
    const slotCode = SLOT_CODES[(column - 1) % SLOT_CODES.length] ?? ''
    const [weekStart, weekEnd] = extractWeekRange(occupancyText)
    occupancies.push({ dayOfWeek, slotCode, weekStart, weekEnd, occupancyText })
  }
  return { name, cells: occupancies }
}

/** 第 1 列的 `<nobr>` 是显示姓名；没有 `<nobr>` 时取该列纯文本。 */
function extractTeacherName(nameCellHtml: string): string {
  for (const nobr of nameCellHtml.matchAll(NOBR_PATTERN)) {
    const candidate = toPlainText(nobr[1] ?? '')
    if (candidate) {
      return candidate
    }
  }
  return toPlainText(nameCellHtml)
}

/** 原文里的周次范围决定占用周；缺失时按 1-30 全周，避免漏判占用。 */
function extractWeekRange(cellText: string): [number, number] {
  const range = WEEK_RANGE_PATTERN.exec(cellText)
  if (range) {
    return normalize(Number(range[1]), Number(range[2]))
  }
  const weeks: number[] = []
  for (const list of cellText.matchAll(WEEK_LIST_PATTERN)) {
    for (const piece of (list[1] ?? '').split(',')) {
      const trimmed = piece.trim()
      if (/^\d{1,2}$/.test(trimmed)) {
        weeks.push(Number(trimmed))
      }
    }
  }
  if (weeks.length > 0) {
    return normalize(Math.min(...weeks), Math.max(...weeks))
  }
  const single = WEEK_SINGLE_PATTERN.exec(cellText)
  if (single) {
    const week = Number(single[1])
    return normalize(week, week)
  }
  return [1, 30]
}

function normalize(start: number, end: number): [number, number] {
  let low = Math.max(1, Math.min(start, end))
  let high = Math.min(30, Math.max(start, end))
  if (high < low) {
    low = 1
    high = 30
  }
  return [low, high]
}

/** 去标签、还原实体、压缩空白。单元格按 `<br>` 分行的课程/班级/周次/教室保留为换行。 */
function toPlainText(html: string): string {
  const withoutTags = html.replace(TAG_PATTERN, '\n')
  const decoded = withoutTags
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
  const lines = decoded.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.join('\n')
}
