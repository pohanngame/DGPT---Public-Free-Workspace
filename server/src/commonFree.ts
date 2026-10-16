import type { DatabaseSync } from 'node:sqlite'
import {
  SLOT_CODES,
  type CommonFreeCell,
  type CommonFreeQuery,
  type CommonFreeResult,
  type ConflictLevel,
  type DayOfWeek,
  type Occupancy,
  type SlotCode,
} from './contract.ts'

interface OccupancyRow {
  teacher_name: string
  day_of_week: number
  slot_code: string
  week_start: number
  week_end: number
  occupancy_text: string
}

function validationError(message: string): Error {
  const error = new Error(message)
  ;(error as Error & { code: string }).code = 'VALIDATION_ERROR'
  return error
}

function levelFor(busyCount: number): ConflictLevel {
  if (busyCount <= 0) return 'FREE'
  if (busyCount === 1) return 'ONE_BUSY'
  return 'MANY_BUSY'
}

function emptyCells(level: ConflictLevel): CommonFreeCell[] {
  const cells: CommonFreeCell[] = []
  for (let day = 1; day <= 7; day += 1) {
    for (const slotCode of SLOT_CODES) {
      cells.push({
        dayOfWeek: day as DayOfWeek,
        slotCode,
        level,
        busyCount: 0,
        occupancies: [],
      })
    }
  }
  return cells
}

export function queryCommonFree(db: DatabaseSync, input: CommonFreeQuery): CommonFreeResult {
  if (input.teacherNames.length === 0) {
    throw validationError('teacherNames must not be empty')
  }
  if (!Number.isInteger(input.week) || input.week < 1 || input.week > 30) {
    throw validationError('week must be an integer from 1 to 30')
  }

  const presence = db
    .prepare('SELECT COUNT(*) AS total FROM semester_teachers WHERE semester_code = ?')
    .get(input.semesterCode) as { total: number }
  if (Number(presence.total) === 0) {
    return {
      semesterCode: input.semesterCode,
      week: input.week,
      missingImport: true,
      cells: emptyCells('MANY_BUSY'),
      absentTeachers: [...input.teacherNames],
    }
  }

  const presentStmt = db.prepare(
    'SELECT 1 FROM semester_teachers WHERE semester_code = ? AND teacher_name = ? LIMIT 1',
  )
  const presentNames: string[] = []
  const absentTeachers: string[] = []
  for (const name of input.teacherNames) {
    if (presentStmt.get(input.semesterCode, name)) presentNames.push(name)
    else absentTeachers.push(name)
  }

  const placeholders = presentNames.map(() => '?').join(', ')
  const rows =
    presentNames.length === 0
      ? []
      : (db
          .prepare(
            `SELECT teacher_name, day_of_week, slot_code, week_start, week_end, occupancy_text
             FROM occupancies
             WHERE semester_code = ?
               AND teacher_name IN (${placeholders})
               AND week_start <= ?
               AND week_end >= ?`,
          )
          .all(input.semesterCode, ...presentNames, input.week, input.week) as unknown as OccupancyRow[])

  const byCell = new Map<string, Occupancy[]>()
  for (const row of rows) {
    const key = `${row.day_of_week}:${row.slot_code}`
    const list = byCell.get(key) ?? []
    const text = row.occupancy_text
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    list.push({
      teacherName: row.teacher_name,
      courseName: firstLine,
      occupancyText: text,
    })
    byCell.set(key, list)
  }

  const cells: CommonFreeCell[] = []
  for (let day = 1; day <= 7; day += 1) {
    for (const slotCode of SLOT_CODES) {
      const occupancies = byCell.get(`${day}:${slotCode}`) ?? []
      const busyTeachers = new Set(occupancies.map((item) => item.teacherName))
      const busyCount = busyTeachers.size
      cells.push({
        dayOfWeek: day as DayOfWeek,
        slotCode: slotCode as SlotCode,
        level: levelFor(busyCount),
        busyCount,
        occupancies,
      })
    }
  }

  return {
    semesterCode: input.semesterCode,
    week: input.week,
    missingImport: false,
    cells,
    absentTeachers,
  }
}
