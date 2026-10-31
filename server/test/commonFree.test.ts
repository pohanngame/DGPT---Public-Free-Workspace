import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { importPrograms, replaceSemester, type SemesterImport } from '../src/catalog.ts'
import { queryCommonFree } from '../src/commonFree.ts'
import type { CommonFreeCell } from '../src/contract.ts'
import { openDatabase } from '../src/db.ts'

const SEMESTER = '2026-2027-1'
const COLLEGE = { code: 'znzz', name: '智能制造学院', shortCode: '0012' }
const OTHER = { code: 'jsj', name: '计算机学院', shortCode: '0013' }

function withDb(run: (db: ReturnType<typeof openDatabase>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'common-free-'))
  const db = openDatabase(join(dir, 'app.sqlite'))
  try {
    run(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function monday0102(cells: CommonFreeCell[]): CommonFreeCell {
  const cell = cells.find((item) => item.dayOfWeek === 1 && item.slotCode === '0102')
  assert.ok(cell)
  return cell
}

function teacher(
  name: string,
  collegeCodes: string[],
  cells: SemesterImport['teachers'][number]['cells'] = [],
): SemesterImport['teachers'][number] {
  return { name, collegeCodes, cells }
}

function busyCell(text: string) {
  return {
    dayOfWeek: 1,
    slotCode: '0102',
    weekStart: 1,
    weekEnd: 30,
    occupancyText: text,
  }
}

test('two present teachers with no Monday 0102 occupancy are FREE', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code]), teacher('李四', [COLLEGE.code])],
    })
    const result = queryCommonFree(db, {
      semesterCode: SEMESTER,
      week: 1,
      teacherNames: ['张三', '李四'],
    })
    assert.equal(result.missingImport, false)
    assert.equal(result.cells.length, 42)
    const cell = monday0102(result.cells)
    assert.equal(cell.level, 'FREE')
    assert.equal(cell.busyCount, 0)
    assert.deepEqual(cell.occupancies, [])
  })
})

test('two occupancy rows for the same slot cover their own weeks', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [
        teacher('张三', [COLLEGE.code], [
          { ...busyCell('工业机器人操作二\n(2-6周)'), weekStart: 2, weekEnd: 6 },
          { ...busyCell('工业机器人操作二\n(7-10周)'), weekStart: 7, weekEnd: 10 },
        ]),
      ],
    })
    const levelIn = (week: number) =>
      monday0102(queryCommonFree(db, { semesterCode: SEMESTER, week, teacherNames: ['张三'] }).cells).level
    assert.equal(levelIn(3), 'ONE_BUSY')
    assert.equal(levelIn(9), 'ONE_BUSY')
    assert.equal(levelIn(12), 'FREE')
  })
})

test('one of two teachers busy at Monday 0102 is ONE_BUSY', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [
        teacher('张三', [COLLEGE.code], [busyCell('软件技术\n(1-30周)')]),
        teacher('李四', [COLLEGE.code]),
      ],
    })
    const cell = monday0102(
      queryCommonFree(db, {
        semesterCode: SEMESTER,
        week: 1,
        teacherNames: ['张三', '李四'],
      }).cells,
    )
    assert.equal(cell.level, 'ONE_BUSY')
    assert.equal(cell.busyCount, 1)
    assert.equal(cell.occupancies[0]?.teacherName, '张三')
    assert.equal(cell.occupancies[0]?.courseName, '软件技术')
  })
})

test('both teachers busy at Monday 0102 is MANY_BUSY', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [
        teacher('张三', [COLLEGE.code], [busyCell('软件技术')]),
        teacher('李四', [COLLEGE.code], [busyCell('高等数学')]),
      ],
    })
    const cell = monday0102(
      queryCommonFree(db, {
        semesterCode: SEMESTER,
        week: 1,
        teacherNames: ['张三', '李四'],
      }).cells,
    )
    assert.equal(cell.level, 'MANY_BUSY')
    assert.equal(cell.busyCount, 2)
  })
})

test('a selected name with no semester_teachers row is absent and does not count as busy', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    const result = queryCommonFree(db, {
      semesterCode: SEMESTER,
      week: 1,
      teacherNames: ['张三', '不存在'],
    })
    assert.deepEqual(result.absentTeachers, ['不存在'])
    const cell = monday0102(result.cells)
    assert.equal(cell.level, 'FREE')
    assert.equal(cell.busyCount, 0)
  })
})

test('a semester with no semester_teachers rows returns missingImport', () => {
  withDb((db) => {
    const result = queryCommonFree(db, {
      semesterCode: SEMESTER,
      week: 1,
      teacherNames: ['张三', '李四'],
    })
    assert.equal(result.missingImport, true)
    assert.equal(result.cells.length, 42)
    assert.ok(result.cells.every((cell) => cell.level === 'MANY_BUSY' && cell.busyCount === 0))
    assert.deepEqual(result.absentTeachers, ['张三', '李四'])
  })
})

test('program paste matches known names and reports unknown names', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    const result = importPrograms(db, '张三\t软件技术,\u4e00\u73ed\n不存在,智能制造学院,软件技术\n')
    assert.equal(result.matched, 1)
    assert.deepEqual(result.unmatchedNames, ['不存在'])
    assert.deepEqual(result.collegeMismatchNames, [])
    const row = db.prepare('SELECT program_name FROM teacher_programs WHERE teacher_name = ?').get('张三') as {
      program_name: string
    }
    assert.equal(row.program_name, '软件技术,\u4e00\u73ed')
  })
})

test('a two-column tab paste matches by teacher name and clears an empty program', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    const result = importPrograms(db, '张三\t软件技术\n张三\t\n')
    assert.equal(result.matched, 2)
    assert.deepEqual(result.unmatchedNames, [])
    assert.deepEqual(result.collegeMismatchNames, [])
    const row = db.prepare('SELECT program_name FROM teacher_programs WHERE teacher_name = ?').get('张三')
    assert.equal(row, undefined)
  })
})

test('replaceSemester keeps both college links for one teacher', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE, OTHER],
      teachers: [teacher('张三', [COLLEGE.code, OTHER.code])],
    })
    const rows = db
      .prepare('SELECT college_code FROM teacher_colleges WHERE teacher_name = ? ORDER BY college_code')
      .all('张三') as { college_code: string }[]
    assert.deepEqual(
      rows.map((row) => row.college_code),
      [OTHER.code, COLLEGE.code].sort(),
    )
    const presence = db
      .prepare('SELECT college_code FROM semester_teachers WHERE semester_code = ? AND teacher_name = ?')
      .all(SEMESTER, '张三') as { college_code: string }[]
    assert.equal(presence.length, 2)
  })
})

test('replaceSemester drops a college link when the teacher leaves the only semester that used it', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: 'S1',
      colleges: [
        { code: 'A', name: '学院A', shortCode: null },
        { code: 'B', name: '学院B', shortCode: null },
      ],
      teachers: [teacher('张三', ['B'])],
    })
    replaceSemester(db, {
      semesterCode: 'S1',
      colleges: [{ code: 'A', name: '学院A', shortCode: null }],
      teachers: [teacher('李四', ['A'])],
    })
    const leftover = db
      .prepare('SELECT college_code FROM teacher_colleges WHERE teacher_name = ?')
      .all('张三') as { college_code: string }[]
    assert.deepEqual(leftover, [])
  })
})

test('replaceSemester keeps a college link when another semester still lists the teacher there', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: 'S2',
      colleges: [{ code: 'B', name: '学院B', shortCode: null }],
      teachers: [teacher('张三', ['B'])],
    })
    replaceSemester(db, {
      semesterCode: 'S1',
      colleges: [{ code: 'B', name: '学院B', shortCode: null }],
      teachers: [teacher('张三', ['B'])],
    })
    replaceSemester(db, {
      semesterCode: 'S1',
      colleges: [{ code: 'A', name: '学院A', shortCode: null }],
      teachers: [teacher('李四', ['A'])],
    })
    const kept = db
      .prepare('SELECT college_code FROM teacher_colleges WHERE teacher_name = ?')
      .all('张三') as { college_code: string }[]
    assert.deepEqual(
      kept.map((row) => row.college_code),
      ['B'],
    )
  })
})

test('replaceSemester keeps college links still used by another semester', () => {
  withDb((db) => {
    const s1 = 'S1'
    const s2 = 'S2'
    const codes = db.prepare(
      'SELECT college_code FROM teacher_colleges WHERE teacher_name = ? ORDER BY college_code',
    )
    replaceSemester(db, {
      semesterCode: s1,
      colleges: [COLLEGE, OTHER],
      teachers: [teacher('张三', [COLLEGE.code, OTHER.code])],
    })
    replaceSemester(db, {
      semesterCode: s2,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    assert.deepEqual(
      (codes.all('张三') as { college_code: string }[]).map((row) => row.college_code),
      [OTHER.code, COLLEGE.code].sort(),
    )
    replaceSemester(db, {
      semesterCode: s1,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    assert.deepEqual(
      (codes.all('张三') as { college_code: string }[]).map((row) => row.college_code),
      [COLLEGE.code],
    )
  })
})

test('a second replaceSemester keeps an already pasted program', () => {
  withDb((db) => {
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code], [busyCell('旧课')])],
    })
    importPrograms(db, '张三,智能制造学院,软件技术')
    replaceSemester(db, {
      semesterCode: SEMESTER,
      colleges: [COLLEGE],
      teachers: [teacher('张三', [COLLEGE.code])],
    })
    const row = db.prepare('SELECT program_name FROM teacher_programs WHERE teacher_name = ?').get('张三') as {
      program_name: string
    }
    assert.equal(row.program_name, '软件技术')
    const occupancies = db.prepare('SELECT COUNT(*) AS total FROM occupancies WHERE semester_code = ?').get(SEMESTER) as {
      total: number
    }
    assert.equal(Number(occupancies.total), 0)
  })
})
