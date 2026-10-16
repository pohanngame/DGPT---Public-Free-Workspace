import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { College, Paginated, PresetGroup, Semester, Settings, Teacher } from './contract.ts'

export class CatalogError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
    this.details = details
  }
}

function validationError(message: string, details?: unknown): CatalogError {
  return new CatalogError('VALIDATION_ERROR', message, details)
}

export interface SemesterImport {
  semesterCode: string
  colleges: { code: string; name: string; shortCode: string | null }[]
  teachers: {
    name: string
    collegeCodes: string[]
    cells: {
      dayOfWeek: number
      slotCode: string
      weekStart: number
      weekEnd: number
      occupancyText: string
    }[]
  }[]
}

const INITIALS: Record<string, string> = {
  张: 'z',
  三: 's',
  李: 'l',
  四: 's',
  王: 'w',
  五: 'w',
  赵: 'z',
  六: 'l',
  智: 'z',
  能: 'n',
  制: 'z',
  造: 'z',
  学: 'x',
  院: 'y',
  软: 'r',
  件: 'j',
  技: 'j',
  术: 's',
  不: 'b',
  存: 'c',
  在: 'z',
}

export function pinyinInitials(name: string): string {
  let initials = ''
  for (const char of name) {
    initials += INITIALS[char] ?? ''
  }
  return initials
}

export function replaceSemester(db: DatabaseSync, input: SemesterImport): void {
  const upsertCollege = db.prepare(`
    INSERT INTO colleges (code, name, short_code)
    VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      short_code = excluded.short_code
  `)
  const upsertSemester = db.prepare(`
    INSERT INTO semesters (code, label, is_current)
    VALUES (?, ?, 0)
    ON CONFLICT(code) DO NOTHING
  `)
  const upsertTeacher = db.prepare(`
    INSERT INTO teachers (name, pinyin_initials, title, updated_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(name) DO UPDATE SET
      pinyin_initials = excluded.pinyin_initials,
      updated_at = excluded.updated_at
  `)
  const listSemesterTeacherNames = db.prepare(
    'SELECT DISTINCT teacher_name FROM semester_teachers WHERE semester_code = ?',
  )
  const deleteUnusedTeacherCollege = db.prepare(`
    DELETE FROM teacher_colleges
    WHERE teacher_name = ?
      AND NOT EXISTS (
        SELECT 1 FROM semester_teachers
        WHERE teacher_name = teacher_colleges.teacher_name
          AND college_code = teacher_colleges.college_code
      )
  `)
  const insertTeacherCollege = db.prepare(`
    INSERT INTO teacher_colleges (teacher_name, college_code)
    VALUES (?, ?)
    ON CONFLICT(teacher_name, college_code) DO NOTHING
  `)
  const deleteSemesterTeachers = db.prepare('DELETE FROM semester_teachers WHERE semester_code = ?')
  const insertSemesterTeacher = db.prepare(
    'INSERT INTO semester_teachers (semester_code, teacher_name, college_code) VALUES (?, ?, ?)',
  )
  const deleteOccupancies = db.prepare('DELETE FROM occupancies WHERE semester_code = ?')
  const insertOccupancy = db.prepare(`
    INSERT INTO occupancies (
      semester_code, teacher_name, day_of_week, slot_code, week_start, week_end, occupancy_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const updatedAt = new Date().toISOString()
  const previousNames = (
    listSemesterTeacherNames.all(input.semesterCode) as { teacher_name: string }[]
  ).map((row) => row.teacher_name)
  db.exec('BEGIN')
  try {
    upsertSemester.run(input.semesterCode, input.semesterCode)
    for (const college of input.colleges) {
      upsertCollege.run(college.code, college.name, college.shortCode)
    }
    for (const teacher of input.teachers) {
      upsertTeacher.run(teacher.name, pinyinInitials(teacher.name), updatedAt)
      for (const collegeCode of teacher.collegeCodes) {
        insertTeacherCollege.run(teacher.name, collegeCode)
      }
    }
    deleteSemesterTeachers.run(input.semesterCode)
    deleteOccupancies.run(input.semesterCode)
    for (const teacher of input.teachers) {
      for (const collegeCode of teacher.collegeCodes) {
        insertSemesterTeacher.run(input.semesterCode, teacher.name, collegeCode)
      }
      for (const cell of teacher.cells) {
        insertOccupancy.run(
          input.semesterCode,
          teacher.name,
          cell.dayOfWeek,
          cell.slotCode,
          cell.weekStart,
          cell.weekEnd,
          cell.occupancyText,
        )
      }
    }
    for (const name of previousNames) deleteUnusedTeacherCollege.run(name)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function importPrograms(
  db: DatabaseSync,
  text: string,
): { matched: number; unmatchedNames: string[]; collegeMismatchNames: string[] } {
  const unmatchedNames: string[] = []
  const collegeMismatchNames: string[] = []
  let matched = 0
  const findTeacher = db.prepare('SELECT name FROM teachers WHERE name = ?')
  const collegeNames = db.prepare(`
    SELECT c.name
    FROM teacher_colleges tc
    JOIN colleges c ON c.code = tc.college_code
    WHERE tc.teacher_name = ?
  `)
  const upsertProgram = db.prepare(`
    INSERT INTO teacher_programs (teacher_name, program_name)
    VALUES (?, ?)
    ON CONFLICT(teacher_name) DO UPDATE SET program_name = excluded.program_name
  `)
  const deleteProgram = db.prepare('DELETE FROM teacher_programs WHERE teacher_name = ?')

  db.exec('BEGIN')
  try {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      const tabbed = line.split('\t').map((part) => part.trim())
      const parts = tabbed.length >= 2 ? tabbed : line.split(',')
      const name = parts[0]?.trim() ?? ''
      const twoColumns = parts.length === 2
      const college = twoColumns ? '' : (parts[1]?.trim() ?? '')
      const programName = (twoColumns ? parts[1] : parts.slice(2).join(',')).trim()
      if (name.length === 0) continue
      const teacher = findTeacher.get(name) as { name: string } | undefined
      if (!teacher) {
        unmatchedNames.push(name)
        continue
      }
      if (programName.length === 0) {
        deleteProgram.run(name)
        matched += 1
        continue
      }
      if (college.length > 0) {
        const linked = collegeNames.all(name) as { name: string }[]
        if (!linked.some((row) => row.name === college)) {
          collegeMismatchNames.push(name)
        }
      }
      upsertProgram.run(name, programName)
      matched += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { matched, unmatchedNames, collegeMismatchNames }
}

export interface TeacherSearchQuery {
  q?: string
  collegeCode?: string
  programName?: string
  page?: number
  pageSize?: number
}

export function searchTeachers(db: DatabaseSync, query: TeacherSearchQuery): Paginated<Teacher> {
  const page = query.page && query.page > 0 ? query.page : 1
  const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 50
  const filters: string[] = []
  const params: (string | number)[] = []

  if (query.q && query.q.trim().length > 0) {
    const needle = query.q.trim().toLowerCase()
    filters.push('(instr(lower(t.name), ?) > 0 OR instr(lower(t.pinyin_initials), ?) > 0)')
    params.push(needle, needle)
  }
  if (query.collegeCode) {
    filters.push(`EXISTS (
      SELECT 1 FROM teacher_colleges tc
      WHERE tc.teacher_name = t.name AND tc.college_code = ?
    )`)
    params.push(query.collegeCode)
  }
  if (query.programName === '未指定') {
    filters.push('p.program_name IS NULL')
  } else if (query.programName) {
    filters.push('p.program_name = ?')
    params.push(query.programName)
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM teachers t
       LEFT JOIN teacher_programs p ON p.teacher_name = t.name
       ${where}`,
    )
    .get(...params) as { total: number }
  const totalItems = Number(countRow.total)
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize)
  const offset = (page - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT t.name, t.pinyin_initials, p.program_name
       FROM teachers t
       LEFT JOIN teacher_programs p ON p.teacher_name = t.name
       ${where}
       ORDER BY t.name
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as {
    name: string
    pinyin_initials: string
    program_name: string | null
  }[]

  const collegeRows = db.prepare(`
    SELECT c.code, c.name, c.short_code
    FROM teacher_colleges tc
    JOIN colleges c ON c.code = tc.college_code
    WHERE tc.teacher_name = ?
    ORDER BY c.code
  `)

  const data: Teacher[] = rows.map((row) => ({
    name: row.name,
    pinyinInitials: row.pinyin_initials,
    programName: row.program_name,
    colleges: (collegeRows.all(row.name) as { code: string; name: string; short_code: string | null }[]).map(
      (college): College => ({
        code: college.code,
        name: college.name,
        shortCode: college.short_code,
      }),
    ),
  }))

  return {
    data,
    pagination: { page, pageSize, totalItems, totalPages },
  }
}

export function listSemesters(db: DatabaseSync, now = new Date()): Semester[] {
  const stored = new Set(
    (db.prepare('SELECT code FROM semesters').all() as { code: string }[]).map((row) => row.code),
  )
  const year = now.getFullYear()
  const codes = new Set(stored)
  for (let start = year - 3; start <= year + 1; start += 1) {
    codes.add(`${start}-${start + 1}-1`)
    codes.add(`${start}-${start + 1}-2`)
  }
  const current = `${year}-${year + 1}-1`
  return [...codes].sort().map((code) => ({
    code,
    label: code,
    isCurrent: code === current,
    synced: stored.has(code),
  }))
}

export function listColleges(db: DatabaseSync): College[] {
  const rows = db
    .prepare('SELECT code, name, short_code FROM colleges ORDER BY code')
    .all() as { code: string; name: string; short_code: string | null }[]
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    shortCode: row.short_code,
  }))
}

export function listPresetGroups(db: DatabaseSync): PresetGroup[] {
  const groups = db
    .prepare('SELECT id, name FROM preset_groups ORDER BY created_at, name')
    .all() as { id: string; name: string }[]
  const members = db.prepare(
    'SELECT teacher_name FROM preset_group_members WHERE group_id = ? ORDER BY teacher_name',
  )
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    teacherNames: (members.all(group.id) as { teacher_name: string }[]).map((row) => row.teacher_name),
  }))
}

export function createPresetGroup(
  db: DatabaseSync,
  input: { name: string; teacherNames: string[] },
): PresetGroup {
  const name = input.name.trim()
  if (name.length === 0) throw validationError('name must not be empty')
  if (input.teacherNames.length === 0) throw validationError('teacherNames must not be empty')

  const findTeacher = db.prepare('SELECT name FROM teachers WHERE name = ?')
  const unknown = input.teacherNames.filter((teacherName) => !findTeacher.get(teacherName))
  if (unknown.length > 0) {
    throw validationError('unknown teachers', { unmatchedNames: unknown })
  }

  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const insertGroup = db.prepare('INSERT INTO preset_groups (id, name, created_at) VALUES (?, ?, ?)')
  const insertMember = db.prepare(
    'INSERT INTO preset_group_members (group_id, teacher_name) VALUES (?, ?)',
  )

  db.exec('BEGIN')
  try {
    insertGroup.run(id, name, createdAt)
    for (const teacherName of input.teacherNames) {
      insertMember.run(id, teacherName)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { id, name, teacherNames: [...input.teacherNames] }
}

export function deletePresetGroup(db: DatabaseSync, name: string): void {
  const group = db.prepare('SELECT id FROM preset_groups WHERE name = ?').get(name) as { id: string } | undefined
  if (!group) throw validationError('preset not found')
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM preset_group_members WHERE group_id = ?').run(group.id)
    db.prepare('DELETE FROM preset_groups WHERE id = ?').run(group.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function shanghaiDate(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day') }
}

function utcDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** Week 1 is the Monday-start week that contains week1Monday, clamped to 1..30. */
export function currentWeek(week1Monday: string | null, now: Date): number {
  if (week1Monday === null) return 1
  const match = DATE.exec(week1Monday)
  if (!match) return 1
  const anchor = utcDayNumber(Number(week1Monday.slice(0, 4)), Number(week1Monday.slice(5, 7)), Number(week1Monday.slice(8, 10)))
  const today = shanghaiDate(now)
  const todayNumber = utcDayNumber(today.year, today.month, today.day)
  const anchorMonday = new Date(Date.UTC(Number(week1Monday.slice(0, 4)), Number(week1Monday.slice(5, 7)) - 1, Number(week1Monday.slice(8, 10))))
  const weekday = anchorMonday.getUTCDay()
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1
  const week = Math.floor((todayNumber - (anchor - daysFromMonday)) / 7) + 1
  return Math.min(30, Math.max(1, week))
}

export function getSettings(db: DatabaseSync, now: Date = new Date()): Settings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('week1Monday') as { value: string } | undefined
  const week1Monday = row?.value ?? null
  return { week1Monday, currentWeek: currentWeek(week1Monday, now) }
}

export function updateSettings(
  db: DatabaseSync,
  input: { week1Monday: string | null },
  now: Date = new Date(),
): Settings {
  if (input.week1Monday !== null && !DATE.test(input.week1Monday)) {
    throw validationError('week1Monday must be YYYY-MM-DD or null')
  }
  if (input.week1Monday === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('week1Monday')
  } else {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('week1Monday', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(input.week1Monday)
  }
  return getSettings(db, now)
}
