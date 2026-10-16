/**
 * Shared contract for the common-free app.
 * Implementation validates every external body and every academic-affairs response
 * at the boundary. Internal calls trust these types.
 * Dates are ISO calendar dates (YYYY-MM-DD). Error shape is the only error shape.
 */

export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type SlotCode = '0102' | '0304' | '0506' | '0708' | '0910' | '1112'
export type ConflictLevel = 'FREE' | 'ONE_BUSY' | 'MANY_BUSY'

export const SLOT_CODES = ['0102', '0304', '0506', '0708', '0910', '1112'] as const

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface Semester {
  code: string
  label: string
  isCurrent: boolean
}

export interface College {
  code: string
  name: string
  shortCode: string | null
}

export interface Teacher {
  name: string
  pinyinInitials: string
  colleges: College[]
  programName: string | null
}

export interface PresetGroup {
  id: string
  name: string
  teacherNames: string[]
}

export interface Settings {
  week1Monday: string | null
  /** 1 when week1Monday is unset. */
  currentWeek: number
}

export interface SyncStartRequest {
  semesterCode: string
  username: string
  password: string
}

export type SyncState =
  | { status: 'NEED_SLIDER'; jobId: string; backgroundBase64: string; pieceBase64: string }
  | { status: 'RUNNING'; jobId: string }
  | { status: 'DONE'; jobId: string; teacherCount: number; occupancyCount: number; failedColleges: string[] }
  | { status: 'FAILED'; jobId: string; message: string }

export interface SliderPoint {
  a: number
  b: number
  c: number
}

export interface SliderSubmitRequest {
  canvasWidth: number
  move: number
  tracks: SliderPoint[]
}

export interface SyncProgress {
  jobId: string
  status: 'RUNNING' | 'DONE' | 'FAILED'
  semesterCode: string
  finishedColleges: number
  totalColleges: number
  currentCollege: string | null
  teacherCount: number
  occupancyCount: number
  failedColleges: string[]
  message: string | null
}

export interface ProgramImportRequest {
  /** Each line: 姓名,学院,专业. College may be empty. */
  text: string
}

export interface ProgramImportResult {
  matched: number
  unmatchedNames: string[]
  collegeMismatchNames: string[]
}

export interface CreatePresetGroupRequest {
  name: string
  teacherNames: string[]
}

export interface CommonFreeQuery {
  semesterCode: string
  week: number
  teacherNames: string[]
}

export interface Occupancy {
  teacherName: string
  courseName: string
  occupancyText: string
}

export interface CommonFreeCell {
  dayOfWeek: DayOfWeek
  slotCode: SlotCode
  level: ConflictLevel
  busyCount: number
  occupancies: Occupancy[]
}

export interface CommonFreeResult {
  semesterCode: string
  week: number
  /** True when this semester has never been synced. Render a dialog, not 42 free cells. */
  missingImport: boolean
  cells: CommonFreeCell[]
  /** Selected teachers absent from this semester. They do not count as free. */
  absentTeachers: string[]
}

export interface Paginated<T> {
  data: T[]
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number }
}

/**
 * Local-only API. The server binds 127.0.0.1.
 * Sync POSTs are retried by the same jobId the server returned; the client does not invent a second job.
 * A second slider submit for a job that already passed returns the current SyncProgress (202 if still running).
 */
export interface CommonFreeApi {
  listSemesters(): Promise<Semester[]>
  listColleges(): Promise<College[]>
  /** q matches name or pinyin initials. collegeCode and programName are optional exact filters. */
  listTeachers(query: {
    q?: string
    collegeCode?: string
    programName?: string
    page?: number
    pageSize?: number
  }): Promise<Paginated<Teacher>>
  listPresetGroups(): Promise<PresetGroup[]>
  createPresetGroup(input: CreatePresetGroupRequest): Promise<PresetGroup>
  deletePresetGroup(id: string): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(input: { week1Monday: string | null }): Promise<Settings>
  startSync(input: SyncStartRequest): Promise<SyncState>
  submitSlider(jobId: string, input: SliderSubmitRequest): Promise<SyncState>
  getSync(jobId: string): Promise<SyncProgress>
  importPrograms(input: ProgramImportRequest): Promise<ProgramImportResult>
  queryCommonFree(input: CommonFreeQuery): Promise<CommonFreeResult>
}
