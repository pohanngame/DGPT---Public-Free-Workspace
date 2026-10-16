import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { replaceSemester, type SemesterImport } from '../src/catalog.ts'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/db.ts'

const SEMESTER = '2026-2027-1'
const COLLEGE = { code: 'znzz', name: '智能制造学院', shortCode: '0012' }

function teacher(
  name: string,
  collegeCodes: string[] = [COLLEGE.code],
): SemesterImport['teachers'][number] {
  return { name, collegeCodes, cells: [] }
}

async function withApp(
  run: (app: ReturnType<typeof buildApp>, db: ReturnType<typeof openDatabase>) => Promise<void>,
  now?: () => Date,
) {
  const dir = mkdtempSync(join(tmpdir(), 'common-free-api-'))
  const db = openDatabase(join(dir, 'app.sqlite'))
  const app = buildApp(db, now ? { now } : {})
  try {
    await run(app, db)
  } finally {
    await app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(db: ReturnType<typeof openDatabase>, names: string[]) {
  replaceSemester(db, {
    semesterCode: SEMESTER,
    colleges: [COLLEGE],
    teachers: names.map((name) => teacher(name)),
  })
}

test('GET /api/teachers paginates and matches initials', async () => {
  await withApp(async (app, db) => {
    seed(db, ['张三', '李四', '王五'])
    const response = await app.inject({
      method: 'GET',
      url: '/api/teachers?q=zs&page=1&pageSize=1',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].name, '张三')
    assert.equal(body.data[0].pinyinInitials, 'zs')
    assert.deepEqual(body.pagination, { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 })
  })
})

test('PUT /api/settings with week1Monday null returns currentWeek 1', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { week1Monday: null },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { week1Monday: null, currentWeek: 1 })
  })
})

test('a date four weeks after week1Monday returns currentWeek 5', async () => {
  const week1Monday = '2026-03-02'
  const anchor = new Date('2026-03-02T04:00:00.000Z')
  const fourWeeksLater = new Date('2026-03-30T04:00:00.000Z')
  let clock = anchor
  await withApp(async (app) => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { week1Monday },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().currentWeek, 1)

    clock = fourWeeksLater
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { week1Monday, currentWeek: 5 })
  }, () => clock)
})

test('POST /api/presets then DELETE removes the group and its members', async () => {
  await withApp(async (app, db) => {
    seed(db, ['张三', '李四'])
    const emptyName = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { name: '  ', teacherNames: ['张三'] },
    })
    assert.equal(emptyName.statusCode, 422)
    assert.equal(emptyName.json().error.code, 'VALIDATION_ERROR')

    const emptyTeachers = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { name: '软件组', teacherNames: [] },
    })
    assert.equal(emptyTeachers.statusCode, 422)
    assert.equal(emptyTeachers.json().error.code, 'VALIDATION_ERROR')

    const created = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { name: '软件组', teacherNames: ['张三', '李四'] },
    })
    assert.equal(created.statusCode, 201)
    const preset = created.json()
    assert.equal(preset.name, '软件组')
    assert.deepEqual(preset.teacherNames, ['张三', '李四'])

    const listed = await app.inject({ method: 'GET', url: '/api/presets' })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().length, 1)

    const removed = await app.inject({ method: 'DELETE', url: '/api/presets/软件组' })
    assert.equal(removed.statusCode, 204)
    const after = await app.inject({ method: 'GET', url: '/api/presets' })
    assert.deepEqual(after.json(), [])
    const members = db.prepare('SELECT COUNT(*) AS total FROM preset_group_members').get() as { total: number }
    assert.equal(Number(members.total), 0)
  })
})

test('POST /api/common-free with an empty teacher list returns 422 VALIDATION_ERROR', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/common-free',
      payload: { semesterCode: SEMESTER, week: 1, teacherNames: [] },
    })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(response.json(), {
      error: { code: 'VALIDATION_ERROR', message: 'teacherNames must not be empty' },
    })
  })
})

test('sync routes are not registered', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/api/sync/start', payload: {} })
    assert.equal(response.statusCode, 404)
  })
})

test('program import and semester list use the existing catalog', async () => {
  await withApp(async (app, db) => {
    seed(db, ['张三'])
    const semesters = await app.inject({ method: 'GET', url: '/api/semesters' })
    assert.equal(semesters.statusCode, 200)
    assert.deepEqual(semesters.json(), [{ code: SEMESTER, label: SEMESTER, isCurrent: false }])

    const colleges = await app.inject({ method: 'GET', url: '/api/colleges' })
    assert.equal(colleges.statusCode, 200)
    assert.deepEqual(colleges.json(), [COLLEGE])

    const imported = await app.inject({
      method: 'POST',
      url: '/api/programs/import',
      payload: { text: '张三,智能制造学院,软件技术\n不存在,智能制造学院,软件技术' },
    })
    assert.equal(imported.statusCode, 200)
    assert.deepEqual(imported.json(), {
      matched: 1,
      unmatchedNames: ['不存在'],
      collegeMismatchNames: [],
    })
  })
})
