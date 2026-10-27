import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/db.ts'
import type { JwClient } from '../src/sync.ts'
import { peekSyncJob, resetSyncJobs } from '../src/sync.ts'
import type { SyncProgress } from '../src/contract.ts'

const SEMESTER = '2026-2027-1'

function teacherPage(colleges: { code: string; name: string }[], kbjcmsid = '<option value="KB1" selected>KB1</option>'): string {
  const collegeOptions = ['<option value="">-请选择-</option>', ...colleges.map((college) => `<option value="${college.code}">${college.name}</option>`)].join('')
  return `<select name="xnxqh"><option value="${SEMESTER}" selected>${SEMESTER}</option></select>
<select name="kbjcmsid">${kbjcmsid}</select>
<select name="skyx">${collegeOptions}</select>`
}

function teacherRow(teacherName: string): string {
  const empty = '<td></td>'
  const cells = [`<td><nobr>${teacherName}</nobr></td>`, ...Array.from({ length: 42 }, () => empty)].join('')
  return `<tr>${cells}</tr>`
}

function collegeTable(...teacherNames: string[]): string {
  return `<table id="kbtable"><tr><td>header</td></tr><tr><td>slots</td></tr>${teacherNames.map(teacherRow).join('')}</table>`
}

function fakeClient(pages: {
  teacher: string
  tables: Record<string, string | Error>
  allTeachers?: string | Error
}): JwClient & { tablesFetched: string[] } {
  const tablesFetched: string[] = []
  return {
    tablesFetched,
    async login() {
      return 'OK'
    },
    async submitSlider() {
      return 'OK'
    },
    async fetchTeacherPage() {
      return pages.teacher
    },
    async fetchCollegeTable(input) {
      tablesFetched.push(input.collegeCode)
      const table = pages.tables[input.collegeCode]
      if (table instanceof Error) throw table
      if (table === undefined) throw new Error(`missing table ${input.collegeCode}`)
      return table
    },
    async fetchAllTeachersTable() {
      tablesFetched.push('UNAFFILIATED')
      if (pages.allTeachers instanceof Error) throw pages.allTeachers
      return pages.allTeachers ?? collegeTable('')
    },
  }
}

async function withApp(client: JwClient, run: (app: ReturnType<typeof buildApp>, db: ReturnType<typeof openDatabase>) => Promise<void>) {
  resetSyncJobs()
  const dir = mkdtempSync(join(tmpdir(), 'common-free-sync-'))
  const db = openDatabase(join(dir, 'app.sqlite'))
  const app = buildApp(db, { jwClient: client })
  try {
    await run(app, db)
  } finally {
    await app.close()
    db.close()
    resetSyncJobs()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function waitUntilSettled(app: ReturnType<typeof buildApp>, jobId: string): Promise<SyncProgress> {
  const deadline = Date.now() + 2000
  let progress: SyncProgress | undefined
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/sync/${jobId}` })
    assert.equal(response.statusCode, 200)
    progress = response.json() as SyncProgress
    if (progress.status === 'DONE' || progress.status === 'FAILED') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job ${jobId} did not settle: ${progress?.status ?? 'missing'}`)
}

test('two colleges write both college links in one replace', async () => {
  const client = fakeClient({
    teacher: teacherPage([
      { code: 'c1', name: '学院一' },
      { code: 'c2', name: '学院二' },
    ]),
    tables: { c1: collegeTable('甲'), c2: collegeTable('乙') },
    allTeachers: collegeTable('甲', '丙'),
  })
  await withApp(client, async (app, db) => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/sync/start',
      payload: { semesterCode: SEMESTER, username: 'user', password: 'secret' },
    })
    assert.equal(started.statusCode, 200)
    const jobId = started.json().jobId as string
    const progress = await waitUntilSettled(app, jobId)
    assert.equal(progress.status, 'DONE')
    assert.equal(progress.totalColleges, 3)
    assert.equal(progress.finishedColleges, 3)
    assert.equal(progress.teacherCount, 3)
    const links = db
      .prepare('SELECT teacher_name, college_code FROM teacher_colleges')
      .all() as { teacher_name: string; college_code: string }[]
    assert.deepEqual(
      links.map((link) => `${link.teacher_name}:${link.college_code}`).sort(),
      ['丙:UNAFFILIATED', '乙:c2', '甲:c1'].sort(),
    )
    const label = db.prepare('SELECT name FROM colleges WHERE code = ?').get('UNAFFILIATED') as { name: string }
    assert.equal(label.name, '未分院系')
    const jia = links.filter((link) => link.teacher_name === '甲')
    assert.deepEqual(
      jia.map((link) => `${link.teacher_name}:${link.college_code}`),
      ['甲:c1'],
    )
    assert.deepEqual(client.tablesFetched, ['c1', 'c2', 'UNAFFILIATED'])
  })
})

test('a finished job keeps progress but drops the password', async () => {
  const client = fakeClient({
    teacher: teacherPage([{ code: 'c1', name: '学院一' }]),
    tables: { c1: collegeTable('甲') },
  })
  await withApp(client, async (app) => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/sync/start',
      payload: { semesterCode: SEMESTER, username: 'user', password: 'secret-password' },
    })
    const jobId = started.json().jobId as string
    const progress = await waitUntilSettled(app, jobId)
    assert.equal(progress.status, 'DONE')
    assert.equal(progress.teacherCount, 1)
    const job = peekSyncJob(jobId)
    assert.ok(job)
    assert.equal('password' in job, false)
    assert.equal(JSON.stringify(job).includes('secret-password'), false)
  })
})

test('NEED_SLIDER stays on the same job until the slider is submitted', async () => {
  let releaseSlider: (value: 'OK') => void = () => {}
  const sliderSubmitted = new Promise<'OK'>((resolve) => {
    releaseSlider = resolve
  })
  const tablesFetched: string[] = []
  const client: JwClient = {
    async login() {
      return { code: 'NEED_SLIDER', sign: 'sign-1', bg: 'bg-bytes', piece: 'piece-bytes', y: 12 }
    },
    async submitSlider() {
      return sliderSubmitted
    },
    async fetchTeacherPage() {
      return teacherPage([{ code: 'c1', name: '学院一' }])
    },
    async fetchCollegeTable(input) {
      tablesFetched.push(input.collegeCode)
      return collegeTable('甲')
    },
    async fetchAllTeachersTable() {
      return collegeTable('甲')
    },
  }
  await withApp(client, async (app) => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/sync/start',
      payload: { semesterCode: SEMESTER, username: 'user', password: 'secret' },
    })
    assert.equal(started.statusCode, 200)
    const body = started.json()
    assert.equal(body.status, 'NEED_SLIDER')
    assert.equal(body.backgroundBase64, 'bg-bytes')
    assert.equal(body.pieceBase64, 'piece-bytes')
    assert.equal(body.sign, undefined)
    assert.equal(tablesFetched.length, 0)

    const waiting = await app.inject({ method: 'GET', url: `/api/sync/${body.jobId}` })
    assert.equal(waiting.json().status, 'RUNNING')
    assert.match(waiting.json().message, /slider/i)

    const again = await app.inject({
      method: 'POST',
      url: '/api/sync/start',
      payload: { semesterCode: SEMESTER, username: 'user', password: 'secret' },
    })
    assert.equal(again.json().jobId, body.jobId)
    assert.equal(again.json().status, 'NEED_SLIDER')

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/sync/slider',
      payload: { jobId: 'other-job', canvasWidth: 280, move: 10, tracks: [{ a: 1, b: 2, c: 3 }] },
    })
    assert.equal(wrong.statusCode, 409)
    assert.equal(wrong.json().error.code, 'CONFLICT')

    const posted = await app.inject({
      method: 'POST',
      url: '/api/sync/slider',
      payload: { jobId: body.jobId, canvasWidth: 280, move: 10, tracks: [{ a: 1, b: 2, c: 3 }] },
    })
    assert.equal(posted.statusCode, 200)
    assert.equal(posted.json().status, 'RUNNING')
    releaseSlider('OK')
    const progress = await waitUntilSettled(app, body.jobId)
    assert.equal(progress.status, 'DONE')
    assert.equal(progress.teacherCount, 1)
  })
})

test('two unselected kbjcmsid options fail the job with KBJCMSID_AMBIGUOUS', async () => {
  const client = fakeClient({
    teacher: teacherPage(
      [{ code: 'c1', name: '学院一' }],
      '<option value="AAAA">甲</option><option value="BBBB">乙</option>',
    ),
    tables: { c1: collegeTable('甲') },
  })
  await withApp(client, async (app) => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/sync/start',
      payload: { semesterCode: SEMESTER, username: 'user', password: 'secret' },
    })
    const progress = await waitUntilSettled(app, started.json().jobId)
    assert.equal(progress.status, 'FAILED')
    assert.match(progress.message ?? '', /KBJCMSID_AMBIGUOUS/)
    assert.deepEqual(client.tablesFetched, [])
  })
})

test('sync start rejects a partial credential pair instead of falling back to the environment', async () => {
  const previousUser = process.env.JW_USERNAME
  const previousPassword = process.env.JW_PASSWORD
  process.env.JW_USERNAME = 'env-user'
  process.env.JW_PASSWORD = 'env-password'
  let logins = 0
  const client: JwClient = {
    async login() {
      logins += 1
      return 'OK'
    },
    async submitSlider() { return 'OK' },
    async fetchTeacherPage() { return teacherPage([]) },
    async fetchCollegeTable() { return collegeTable() },
    async fetchAllTeachersTable() { return collegeTable() },
  }
  try {
    await withApp(client, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/start',
        payload: { semesterCode: SEMESTER, username: 'request-user' },
      })
      assert.equal(response.statusCode, 422)
      assert.equal(logins, 0)
    })
  } finally {
    if (previousUser === undefined) delete process.env.JW_USERNAME
    else process.env.JW_USERNAME = previousUser
    if (previousPassword === undefined) delete process.env.JW_PASSWORD
    else process.env.JW_PASSWORD = previousPassword
  }
})

test('sync start uses both request credentials when both are provided', async () => {
  const previousUser = process.env.JW_USERNAME
  const previousPassword = process.env.JW_PASSWORD
  process.env.JW_USERNAME = 'env-user'
  process.env.JW_PASSWORD = 'env-password'
  let received: [string, string] | undefined
  const client: JwClient = {
    async login(username, password) {
      received = [username, password]
      return 'OK'
    },
    async submitSlider() { return 'OK' },
    async fetchTeacherPage() { return teacherPage([]) },
    async fetchCollegeTable() { return collegeTable() },
    async fetchAllTeachersTable() { return collegeTable() },
  }
  try {
    await withApp(client, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/start',
        payload: {
          semesterCode: SEMESTER,
          username: 'request-user',
          password: 'request-password',
        },
      })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(received, ['request-user', 'request-password'])
    })
  } finally {
    if (previousUser === undefined) delete process.env.JW_USERNAME
    else process.env.JW_USERNAME = previousUser
    if (previousPassword === undefined) delete process.env.JW_PASSWORD
    else process.env.JW_PASSWORD = previousPassword
  }
})

test('missing credentials with empty env return 422 and start no job', async () => {
  const previousUser = process.env.JW_USERNAME
  const previousPassword = process.env.JW_PASSWORD
  delete process.env.JW_USERNAME
  delete process.env.JW_PASSWORD
  let logins = 0
  const client: JwClient = {
    async login() {
      logins += 1
      return 'OK'
    },
    async submitSlider() {
      return 'OK'
    },
    async fetchTeacherPage() {
      return ''
    },
    async fetchCollegeTable() {
      return ''
    },
    async fetchAllTeachersTable() {
      return ''
    },
  }
  try {
    await withApp(client, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/start',
        payload: { semesterCode: SEMESTER },
      })
      assert.equal(response.statusCode, 422)
      assert.equal(response.json().error.code, 'VALIDATION_ERROR')
      assert.equal(logins, 0)
    })
  } finally {
    if (previousUser === undefined) delete process.env.JW_USERNAME
    else process.env.JW_USERNAME = previousUser
    if (previousPassword === undefined) delete process.env.JW_PASSWORD
    else process.env.JW_PASSWORD = previousPassword
  }
})
