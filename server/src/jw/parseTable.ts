import { SLOT_CODES } from '../contract.ts'

/** 表头占前两行：第 1 行星期、第 2 行节次组。 */
const HEADER_ROWS = 2
const DAYS_PER_WEEK = 7

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
/** 单个课程块的周次行，写法如 `(2-6周)`、`(7-10,14周)`。 */
const WEEK_LINE_PATTERN = /\(([0-9][0-9,\s-]*?)\s*周\)?/

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
  const rows = [...table[1].matchAll(ROW_PATTERN)]
  const slotCodes = slotCodesFromHeader(rows[1]?.[1] ?? '')
  const teachers: ParsedTeacherRow[] = []
  for (const row of rows.slice(HEADER_ROWS)) {
    const parsed = parseRow(row[1] ?? '', slotCodes)
    if (parsed) {
      teachers.push(parsed)
    }
  }
  return teachers
}

/** 第 2 行表头给出每天的节次。旧学期没有 1112，不能按固定 43 列计算。 */
function slotCodesFromHeader(headerHtml: string): string[] {
  const labels = [...headerHtml.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)]
    .map((match) => toPlainText(match[1] ?? ''))
    .filter((label) => SLOT_CODES.includes(label as (typeof SLOT_CODES)[number]))
  const perDay = labels.length / DAYS_PER_WEEK
  if (labels.length > 0 && perDay === Math.floor(perDay) && labels.slice(0, perDay).every((label, index) => label === SLOT_CODES[index])) {
    return labels.slice(0, perDay)
  }
  return [...SLOT_CODES]
}

function parseRow(rowHtml: string, slotCodes: readonly string[]): ParsedTeacherRow | null {
  const cells = [...rowHtml.matchAll(CELL_PATTERN)].map((match) => match[1] ?? '')
  const expected = 1 + DAYS_PER_WEEK * slotCodes.length
  if (cells.length !== expected) {
    return null
  }
  const name = extractTeacherName(cells[0] ?? '')
  if (!name) {
    return null
  }
  const occupancies: ParsedCell[] = []
  // 第 1 列是姓名，其后按天和表头节次排列。
  for (let column = 1; column < cells.length; column++) {
    const occupancyText = toPlainText(cells[column] ?? '')
    if (!occupancyText) {
      continue
    }
    const dayOfWeek = Math.floor((column - 1) / slotCodes.length) + 1
    const slotCode = slotCodes[(column - 1) % slotCodes.length] ?? ''
    for (const block of extractWeekBlocks(occupancyText)) {
      occupancies.push({ dayOfWeek, slotCode, ...block })
    }
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

/**
 * 一个格子常塞多个课程块（各自有周次），每块都要单独成行，否则后几块的周次会被丢掉。
 * 块的固定结构是 课程/班级/教师/周次/教室，共 5 行（实测 6185/6186 的块间距为 5），
 * 所以下一块从上一块周次的隔一行开始；间距异常时退回逐行，不做猜测。
 */
export function extractWeekBlocks(cellText: string): Omit<ParsedCell, 'dayOfWeek' | 'slotCode'>[] {
  const lines = cellText.split('\n')
  const tokens = lines.flatMap((line, index) => {
    const match = WEEK_LINE_PATTERN.exec(line)
    return match ? [{ index, list: match[1] ?? '' }] : []
  })
  if (tokens.length === 0) {
    const [weekStart, weekEnd] = extractWeekRange(cellText)
    return [{ weekStart, weekEnd, occupancyText: cellText }]
  }
  const blocks: Omit<ParsedCell, 'dayOfWeek' | 'slotCode'>[] = []
  tokens.forEach((token, position) => {
    const previous = tokens[position - 1]
    const from = previous ? (token.index - previous.index === 5 ? previous.index + 2 : previous.index + 1) : 0
    const segment = lines.slice(from, token.index + 1).join('\n').trim()
    for (const [weekStart, weekEnd] of weekRuns(token.list)) {
      blocks.push({ weekStart, weekEnd, occupancyText: segment })
    }
  })
  const tail = lines.slice(tokens[tokens.length - 1]!.index + 1).join('\n').trim()
  if (tail) {
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = { ...last, occupancyText: `${last.occupancyText}\n${tail}` }
  }
  return blocks
}

/** `7-10,14` 拆成连续区间：7-10 与 14-14，避免把中间的 11-13 周误算成占用。 */
function weekRuns(list: string): [number, number][] {
  const runs: [number, number][] = []
  for (const piece of list.split(',')) {
    const text = piece.trim()
    if (/^\d{1,2}$/.test(text)) {
      runs.push(normalize(Number(text), Number(text)))
    } else if (/^\d{1,2}\s*-\s*\d{1,2}$/.test(text)) {
      const [start, end] = text.split('-').map(Number)
      runs.push(normalize(start, end))
    }
  }
  return runs
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
