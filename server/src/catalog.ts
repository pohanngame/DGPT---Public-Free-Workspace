import type { DatabaseSync } from 'node:sqlite'
import type { College, Paginated, Teacher } from './contract.ts'

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
  const deleteTeacherCollegesForSemester = db.prepare(`
    DELETE FROM teacher_colleges
    WHERE teacher_name = ?
      AND college_code NOT IN (
        SELECT college_code
        FROM semester_teachers
        WHERE teacher_name = ? AND semester_code != ?
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
  db.exec('BEGIN')
  try {
    upsertSemester.run(input.semesterCode, input.semesterCode)
    for (const college of input.colleges) {
      upsertCollege.run(college.code, college.name, college.shortCode)
    }
    for (const teacher of input.teachers) {
      upsertTeacher.run(teacher.name, pinyinInitials(teacher.name), updatedAt)
      deleteTeacherCollegesForSemester.run(teacher.name, teacher.name, input.semesterCode)
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

  db.exec('BEGIN')
  try {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      const parts = line.split(',')
      const name = parts[0]?.trim() ?? ''
      const college = parts[1]?.trim() ?? ''
      const programName = parts.slice(2).join(',').trim()
      if (name.length === 0) continue
      const teacher = findTeacher.get(name) as { name: string } | undefined
      if (!teacher) {
        unmatchedNames.push(name)
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
