import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { replaceSemester, type SemesterImport } from './catalog.ts'
import type { SliderSubmitRequest, SyncProgress, SyncState } from './contract.ts'
import { parseTeacherPage } from './jw/page.ts'
import { parseTeacherTable, type ParsedCell } from './jw/parseTable.ts'

export interface JwClient {
  login(
    username: string,
    password: string,
  ): Promise<'OK' | { code: 'NEED_SLIDER'; sign: string; bg: string; piece: string; y: number }>
  submitSlider(
    jobId: string,
    move: { canvasWidth: number; move: number; tracks: { a: number; b: number; c: number }[] },
  ): Promise<'OK' | { code: 'SLIDER_FAILED'; message: string }>
  fetchTeacherPage(): Promise<string>
  fetchCollegeTable(input: { semesterCode: string; kbjcmsid: string; collegeCode: string }): Promise<string>
}

export interface SyncStartInput {
  semesterCode: string
  username: string
  password: string
}

interface SliderChallenge {
  sign: string
  bg: string
  piece: string
  y: number
}

interface ActiveJob {
  jobId: string
  semesterCode: string
  username: string
  password?: string
  status: SyncProgress['status']
  finishedColleges: number
  totalColleges: number
  currentCollege: string | null
  teacherCount: number
  occupancyCount: number
  failedColleges: string[]
  message: string | null
  slider: SliderChallenge | null
  /** Set only while login is waiting for the matching slider POST. */
  awaitingSlider: boolean
}

const jobs = new Map<string, ActiveJob>()
let active: ActiveJob | null = null

export function resetSyncJobs(): void {
  jobs.clear()
  active = null
}

export function peekSyncJob(jobId: string): ActiveJob | undefined {
  return jobs.get(jobId)
}

export async function startSync(db: DatabaseSync, client: JwClient, input: SyncStartInput): Promise<SyncState> {
  if (active && active.status === 'RUNNING') {
    return stateOf(active)
  }
  const job: ActiveJob = {
    jobId: randomUUID(),
    semesterCode: input.semesterCode,
    username: input.username,
    password: input.password,
    status: 'RUNNING',
    finishedColleges: 0,
    totalColleges: 0,
    currentCollege: null,
    teacherCount: 0,
    occupancyCount: 0,
    failedColleges: [],
    message: null,
    slider: null,
    awaitingSlider: false,
  }
  jobs.set(job.jobId, job)
  active = job
  return runLogin(db, client, job)
}

export function submitSlider(db: DatabaseSync, client: JwClient, jobId: string, input: SliderSubmitRequest): SyncState {
  const job = jobs.get(jobId)
  if (!job || job !== active) {
    const error = new Error('slider job is not the active sync')
    Object.assign(error, { code: 'CONFLICT' })
    throw error
  }
  if (!job.awaitingSlider || !job.slider) {
    return stateOf(job)
  }
  job.awaitingSlider = false
  job.message = null
  void continueAfterSlider(db, client, job, input)
  return { status: 'RUNNING', jobId: job.jobId }
}

export function getSync(jobId: string): SyncProgress {
  const job = jobs.get(jobId)
  if (!job) {
    const error = new Error('sync job not found')
    Object.assign(error, { code: 'NOT_FOUND' })
    throw error
  }
  return progressOf(job)
}

async function runLogin(db: DatabaseSync, client: JwClient, job: ActiveJob): Promise<SyncState> {
  try {
    const login = await client.login(job.username, job.password ?? '')
    if (login !== 'OK') {
      holdForSlider(job, login)
      return stateOf(job)
    }
    void fetchTables(db, client, job)
  } catch (error) {
    fail(job, messageOf(error))
  }
  return stateOf(job)
}

function holdForSlider(job: ActiveJob, challenge: SliderChallenge & { code: 'NEED_SLIDER' }): void {
  if (job.status !== 'RUNNING') return
  job.slider = { sign: challenge.sign, bg: challenge.bg, piece: challenge.piece, y: challenge.y }
  job.awaitingSlider = true
  job.message = 'slider required'
}

async function continueAfterSlider(
  db: DatabaseSync,
  client: JwClient,
  job: ActiveJob,
  input: SliderSubmitRequest,
): Promise<void> {
  try {
    const result = await client.submitSlider(job.jobId, input)
    if (result !== 'OK') {
      fail(job, result.message)
      return
    }
    job.slider = null
    await fetchTables(db, client, job)
  } catch (error) {
    fail(job, messageOf(error))
  }
}

async function fetchTables(db: DatabaseSync, client: JwClient, job: ActiveJob): Promise<void> {
  try {
    const page = parseTeacherPage(await client.fetchTeacherPage())
    const colleges = page.colleges
    job.totalColleges = colleges.length
    const byTeacher = new Map<string, { collegeCodes: string[]; cells: ParsedCell[] }>()

    for (const college of colleges) {
      if (job.status !== 'RUNNING') return
      job.currentCollege = college.code
      const html = await client.fetchCollegeTable({
        semesterCode: job.semesterCode,
        kbjcmsid: page.kbjcmsid,
        collegeCode: college.code,
      })
      const rows = parseTeacherTable(html)
      for (const row of rows) {
        const existing = byTeacher.get(row.name)
        if (existing) {
          if (!existing.collegeCodes.includes(college.code)) existing.collegeCodes.push(college.code)
          existing.cells.push(...row.cells)
        } else {
          byTeacher.set(row.name, { collegeCodes: [college.code], cells: [...row.cells] })
        }
      }
      job.finishedColleges += 1
    }

    const teachers = [...byTeacher.entries()].map(([name, teacher]) => ({
      name,
      collegeCodes: teacher.collegeCodes,
      cells: teacher.cells,
    }))
    const imported: SemesterImport = {
      semesterCode: job.semesterCode,
      colleges,
      teachers,
    }
    replaceSemester(db, imported)
    job.teacherCount = teachers.length
    job.occupancyCount = teachers.reduce((sum, teacher) => sum + teacher.cells.length, 0)
    job.currentCollege = null
    job.status = 'DONE'
    job.message = null
    delete job.password
    if (active === job) active = null
  } catch (error) {
    if (job.currentCollege && job.failedColleges.length === 0) job.failedColleges = [job.currentCollege]
    fail(job, messageOf(error))
  }
}

function fail(job: ActiveJob, message: string): void {
  if (job.status !== 'RUNNING') return
  job.status = 'FAILED'
  job.message = message
  delete job.password
  job.awaitingSlider = false
  job.currentCollege = null
  if (active === job) active = null
}

function progressOf(job: ActiveJob): SyncProgress {
  return {
    jobId: job.jobId,
    status: job.status,
    semesterCode: job.semesterCode,
    finishedColleges: job.finishedColleges,
    totalColleges: job.totalColleges,
    currentCollege: job.currentCollege,
    teacherCount: job.teacherCount,
    occupancyCount: job.occupancyCount,
    failedColleges: [...job.failedColleges],
    message: job.message,
  }
}

function stateOf(job: ActiveJob): SyncState {
  if (job.awaitingSlider && job.slider) {
    return {
      status: 'NEED_SLIDER',
      jobId: job.jobId,
      backgroundBase64: job.slider.bg,
      pieceBase64: job.slider.piece,
    }
  }
  if (job.status === 'DONE') {
    return {
      status: 'DONE',
      jobId: job.jobId,
      teacherCount: job.teacherCount,
      occupancyCount: job.occupancyCount,
      failedColleges: [...job.failedColleges],
    }
  }
  if (job.status === 'FAILED') {
    return { status: 'FAILED', jobId: job.jobId, message: job.message ?? 'sync failed' }
  }
  return { status: 'RUNNING', jobId: job.jobId }
}

function messageOf(error: unknown): string {
  const tagged = error as { code?: unknown; message?: unknown }
  const code = typeof tagged.code === 'string' ? tagged.code : ''
  const text = typeof tagged.message === 'string' ? tagged.message : 'sync failed'
  return code && !text.includes(code) ? `${code}: ${text}` : text
}
