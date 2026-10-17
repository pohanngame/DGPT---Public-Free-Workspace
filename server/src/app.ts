import type { DatabaseSync } from 'node:sqlite'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  CatalogError,
  createPresetGroup,
  deletePresetGroup,
  getSettings,
  importPrograms,
  listColleges,
  listPresetGroups,
  listSemesters,
  searchTeachers,
  updateSettings,
} from './catalog.ts'
import { queryCommonFree } from './commonFree.ts'
import type { CommonFreeQuery, SliderSubmitRequest } from './contract.ts'
import { getSync, startSync, submitSlider, type JwClient } from './sync.ts'

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  const error: ErrorBody['error'] = { code, message }
  if (details !== undefined) error.details = details
  return { error }
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof CatalogError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

function detailsOf(error: unknown): unknown {
  if (error instanceof CatalogError) return error.details
  return undefined
}

export interface BuildAppOptions {
  now?: () => Date
  jwClient?: JwClient
}

export function buildApp(db: DatabaseSync, options: BuildAppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => new Date())
  const app = Fastify({ logger: false })
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8')
    if (raw.length === 0 && (request.method === 'DELETE' || request.headers['content-length'] === '0')) {
      done(null, {})
      return
    }
    try {
      const json = JSON.parse(raw)
      done(null, json)
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unexpected token in JSON')
      Object.assign(err, { statusCode: 400 })
      done(err, undefined)
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    const code = codeOf(error)
    if (code === 'VALIDATION_ERROR') {
      const message = error instanceof Error ? error.message : 'validation error'
      return reply.code(422).send(errorBody(code, message, detailsOf(error)))
    }
    const message = error instanceof Error ? error.message : 'internal error'
    return reply.code(500).send(errorBody('INTERNAL', message))
  })

  app.get('/api/semesters', async () => listSemesters(db, now()))
  app.get('/api/colleges', async () => listColleges(db))

  app.get<{
    Querystring: {
      q?: string
      collegeCode?: string
      programName?: string
      page?: string
      pageSize?: string
    }
  }>('/api/teachers', async (request) => {
    const page = request.query.page === undefined ? undefined : Number(request.query.page)
    const pageSize = request.query.pageSize === undefined ? undefined : Number(request.query.pageSize)
    return searchTeachers(db, {
      q: request.query.q,
      collegeCode: request.query.collegeCode,
      programName: request.query.programName,
      page: Number.isFinite(page) ? page : undefined,
      pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    })
  })

  app.get('/api/presets', async () => listPresetGroups(db))

  app.post<{ Body: { name?: unknown; teacherNames?: unknown } }>('/api/presets', async (request, reply) => {
    const body = request.body ?? {}
    if (typeof body.name !== 'string' || !Array.isArray(body.teacherNames)) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'name and teacherNames are required'))
    }
    if (!body.teacherNames.every((name) => typeof name === 'string')) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'teacherNames must be strings'))
    }
    const created = createPresetGroup(db, { name: body.name, teacherNames: body.teacherNames })
    return reply.code(201).send(created)
  })

  app.delete<{ Params: { name: string } }>('/api/presets/:name', async (request, reply) => {
    deletePresetGroup(db, request.params.name)
    return reply.code(204).send()
  })

  app.get('/api/settings', async () => getSettings(db, now()))

  app.put<{ Body: { week1Monday?: unknown } }>('/api/settings', async (request) => {
    const body = request.body ?? {}
    if (!('week1Monday' in body) || (body.week1Monday !== null && typeof body.week1Monday !== 'string')) {
      const error = new CatalogError('VALIDATION_ERROR', 'week1Monday must be YYYY-MM-DD or null')
      throw error
    }
    return updateSettings(db, { week1Monday: body.week1Monday }, now())
  })

  app.post<{ Body: { text?: unknown } | undefined }>('/api/programs/import', async (request) => {
    const body = request.body ?? {}
    if (typeof body.text !== 'string') {
      throw new CatalogError('VALIDATION_ERROR', 'text is required')
    }
    return importPrograms(db, body.text)
  })

  app.post<{ Body: Partial<CommonFreeQuery> }>('/api/common-free', async (request) => {
    const body = request.body ?? {}
    if (typeof body.semesterCode !== 'string' || !Array.isArray(body.teacherNames) || typeof body.week !== 'number') {
      throw new CatalogError('VALIDATION_ERROR', 'semesterCode, week, and teacherNames are required')
    }
    if (!body.teacherNames.every((name) => typeof name === 'string')) {
      throw new CatalogError('VALIDATION_ERROR', 'teacherNames must be strings')
    }
    return queryCommonFree(db, {
      semesterCode: body.semesterCode,
      week: body.week,
      teacherNames: body.teacherNames,
    })
  })

  app.post<{
    Body: { semesterCode?: unknown; username?: unknown; password?: unknown }
  }>('/api/sync/start', async (request, reply) => {
    const client = options.jwClient
    if (!client) {
      return reply.code(500).send(errorBody('INTERNAL', 'sync client is not configured'))
    }
    const body = request.body ?? {}
    if (typeof body.semesterCode !== 'string' || body.semesterCode.length === 0) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'semesterCode is required'))
    }
    const bodyUsername = typeof body.username === 'string' ? body.username : ''
    const bodyPassword = typeof body.password === 'string' ? body.password : ''
    const requestHasCredentials = bodyUsername.length > 0 && bodyPassword.length > 0
    const username = requestHasCredentials ? bodyUsername : (process.env.JW_USERNAME ?? '')
    const password = requestHasCredentials ? bodyPassword : (process.env.JW_PASSWORD ?? '')
    if (!username || !password) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'username and password are required'))
    }
    return startSync(db, client, { semesterCode: body.semesterCode, username, password })
  })

  app.post<{
    Body: { jobId?: unknown; canvasWidth?: unknown; move?: unknown; tracks?: unknown }
  }>('/api/sync/slider', async (request, reply) => {
    const client = options.jwClient
    if (!client) {
      return reply.code(500).send(errorBody('INTERNAL', 'sync client is not configured'))
    }
    const body = request.body ?? {}
    if (typeof body.jobId !== 'string' || !isSliderMove(body)) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'jobId, canvasWidth, move, and tracks are required'))
    }
    try {
      return submitSlider(db, client, body.jobId, sliderMove(body))
    } catch (error) {
      if (codeOf(error) === 'CONFLICT') {
        const message = error instanceof Error ? error.message : 'conflict'
        return reply.code(409).send(errorBody('CONFLICT', message))
      }
      throw error
    }
  })

  app.get<{ Params: { jobId: string } }>('/api/sync/:jobId', async (request, reply) => {
    try {
      return getSync(request.params.jobId)
    } catch (error) {
      if (codeOf(error) === 'NOT_FOUND') {
        return reply.code(404).send(errorBody('NOT_FOUND', 'sync job not found'))
      }
      throw error
    }
  })

  return app
}

function isSliderMove(body: { canvasWidth?: unknown; move?: unknown; tracks?: unknown }): boolean {
  return typeof body.canvasWidth === 'number' && typeof body.move === 'number' && isTrackList(body.tracks)
}

function sliderMove(body: { canvasWidth?: unknown; move?: unknown; tracks?: unknown }): SliderSubmitRequest {
  if (typeof body.canvasWidth !== 'number' || typeof body.move !== 'number' || !isTrackList(body.tracks)) {
    throw new Error('slider move is invalid')
  }
  return { canvasWidth: body.canvasWidth, move: body.move, tracks: body.tracks }
}

function isTrackList(tracks: unknown): tracks is SliderSubmitRequest['tracks'] {
  return (
    Array.isArray(tracks) &&
    tracks.every(
      (point) =>
        typeof point === 'object' &&
        point !== null &&
        typeof (point as { a?: unknown }).a === 'number' &&
        typeof (point as { b?: unknown }).b === 'number' &&
        typeof (point as { c?: unknown }).c === 'number',
    )
  )
}
