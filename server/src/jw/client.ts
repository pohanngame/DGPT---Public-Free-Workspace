import { encryptPassword } from './cipher.ts'
import type { JwClient } from '../sync.ts'

const UA = 'jiaowukebiao/0.1'

export interface JwClientOptions {
  casBaseUrl?: string
  jwBaseUrl?: string
  sliderRandom?: (length: number) => string
  timeoutMs?: number
}

interface StoredCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
}

export function createJwClient(options: JwClientOptions = {}): JwClient {
  const cookies: StoredCookie[] = []
  let sliderKey = ''
  const timeoutMs = options.timeoutMs ?? 20_000
  const casBase = () => trimSlash(options.casBaseUrl ?? process.env.JW_BASE_URL ?? 'https://authserver.dgpt.edu.cn')
  const jwBase = () => trimSlash(options.jwBaseUrl ?? process.env.JW_JW_BASE_URL ?? 'https://jw.dgpt.edu.cn')

  return {
    async login(username, password) {
      const loginUrl = `${casBase()}/authserver/login`
      const opened = await send(cookies, loginUrl, { timeoutMs })
      if (opened.status !== 200) throw httpError(opened.status)
      const html = await opened.text()
      const form = findLoginForm(html)
      if (!form) throw new Error('login form with pwdEncryptSalt not found')
      const salt = matchValue(form, /id=["']pwdEncryptSalt["'][^>]*value=["']([^"']+)["']/i)
      if (!salt) throw new Error('pwdEncryptSalt missing')
      const inputs = hiddenInputs(form)

      const checkUrl = `${casBase()}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}`
      const check = await send(cookies, checkUrl, { timeoutMs })
      const checkBody = (await check.text()).trim()
      if (captchaRequired(checkBody)) {
        return openSlider(cookies, casBase(), timeoutMs, (key) => {
          sliderKey = key
        })
      }

      const body = new URLSearchParams({
        username,
        password: encryptPassword(password, salt),
        lt: inputs.lt ?? '',
        execution: inputs.execution ?? '',
        _eventId: 'submit',
        cllt: 'userNameLogin',
        dllt: 'generalLogin',
      })
      const posted = await send(cookies, loginUrl, { method: 'POST', body, referer: loginUrl, timeoutMs })
      const location = posted.headers.get('location')
      if (location?.includes('error')) throw new Error('credentials rejected')
      let chain = `${jwBase()}/jsxsd/sso.jsp`
      if (isRedirect(posted.status) && location) {
        chain = new URL(location, loginUrl).toString()
      } else if (!isRedirect(posted.status) && posted.status !== 200) {
        throw httpError(posted.status)
      } else {
        await posted.text()
      }
      const landed = await follow(cookies, chain, timeoutMs)
      if (!new URL(landed.url).pathname.startsWith('/jsxsd/')) {
        await follow(cookies, `${jwBase()}/jsxsd/sso.jsp`, timeoutMs)
      }
      return 'OK'
    },

    async submitSlider(_jobId, move) {
      if (!sliderKey) throw new Error('slider challenge is missing')
      const url = `${casBase()}/authserver/common/verifySliderCaptcha.htl`
      const payload = JSON.stringify({
        canvasLength: move.canvasWidth,
        moveLength: move.move,
        tracks: move.tracks,
      })
      const body = new URLSearchParams({ sign: encryptPassword(payload, sliderKey, options.sliderRandom) })
      const response = await send(cookies, url, {
        method: 'POST',
        body,
        referer: `${casBase()}/authserver/login`,
        timeoutMs,
      })
      if (response.status !== 200) throw httpError(response.status)
      const json = (await response.json()) as { errorCode?: number; errorMsg?: string; message?: string }
      if (json.errorCode === 1) return 'OK'
      return { code: 'SLIDER_FAILED', message: json.errorMsg || json.message || 'slider rejected' }
    },

    async fetchTeacherPage() {
      const response = await send(cookies, `${jwBase()}/jsxsd/kbcx/kbxx_teacher`, { timeoutMs })
      if (response.status !== 200) throw httpError(response.status)
      return response.text()
    },

    async fetchCollegeTable(input) {
      if (!input.collegeCode) throw new Error('collegeCode is required')
      return postTeacherTable(cookies, jwBase(), timeoutMs, input.semesterCode, input.kbjcmsid, input.collegeCode)
    },

    async fetchAllTeachersTable(input) {
      return postTeacherTable(cookies, jwBase(), timeoutMs, input.semesterCode, input.kbjcmsid, '')
    },
  }
}

async function postTeacherTable(
  cookies: StoredCookie[],
  jwBase: string,
  timeoutMs: number,
  semesterCode: string,
  kbjcmsid: string,
  skyx: string,
): Promise<string> {
  const body = new URLSearchParams({
    xnxqh: semesterCode,
    kbjcmsid,
    skyx,
    skjsid: '',
    skjs: '',
    zc1: '1',
    zc2: '30',
    skxq1: '',
    skxq2: '',
    jc1: '',
    jc2: '',
  })
  const response = await send(cookies, `${jwBase}/jsxsd/kbcx/kbxx_teacher_ifr`, {
    method: 'POST',
    body,
    referer: `${jwBase}/jsxsd/kbcx/kbxx_teacher`,
    timeoutMs,
  })
  if (response.status !== 200) throw httpError(response.status)
  return response.text()
}

async function openSlider(
  cookies: StoredCookie[],
  casBase: string,
  timeoutMs: number,
  remember: (key: string) => void,
) {
  const url = `${casBase}/authserver/common/openSliderCaptcha.htl?ts=${Date.now()}`
  const response = await send(cookies, url, { timeoutMs })
  if (response.status !== 200) throw httpError(response.status)
  const json = (await response.json()) as {
    bigImage?: string
    smallImage?: string
    y?: number
    sign?: string
    safeSecure?: string
    salt?: string
  }
  const piece = json.smallImage ?? ''
  const key = aesKey(sliderSalt(json.safeSecure, json.salt), piece)
  if (key) remember(key)
  return {
    code: 'NEED_SLIDER' as const,
    sign: json.sign ?? '',
    bg: json.bigImage ?? '',
    piece,
    y: typeof json.y === 'number' ? json.y : 0,
  }
}

function sliderSalt(safeSecure?: string, salt?: string): string {
  for (const candidate of [safeSecure, salt]) {
    if (candidate && Buffer.byteLength(candidate) === 16) return candidate
  }
  return ''
}

function aesKey(salt: string, piece: string): string {
  if (Buffer.byteLength(salt) === 16) return salt
  const decoded = Buffer.from(piece, 'base64')
  if (decoded.length < 16 || decoded.toString('base64') !== piece) return ''
  return decoded.subarray(decoded.length - 16).toString('latin1')
}

async function follow(
  cookies: StoredCookie[],
  start: string,
  timeoutMs: number,
): Promise<{ url: string; status: number }> {
  let url = start
  let previous: string | null = null
  for (let hop = 0; hop <= 10; hop++) {
    const response = await send(cookies, url, { timeoutMs })
    const location = response.headers.get('location')
    let next: string | null = null
    if (isRedirect(response.status) && location) {
      next = new URL(location, url).toString()
    } else {
      const html = await response.text()
      if (response.status !== 200) throw httpError(response.status)
      const target = scriptRedirect(html)
      if (!target) return { url, status: response.status }
      next = new URL(target, url).toString()
    }
    if (next === url && next === previous) return { url, status: response.status }
    previous = url
    url = next
  }
  throw new Error('redirect chain too long')
}

async function send(
  cookies: StoredCookie[],
  url: string,
  init: { method?: string; body?: URLSearchParams; referer?: string; timeoutMs?: number } = {},
): Promise<Response> {
  assertAllowedHost(url)
  const headers: Record<string, string> = { 'User-Agent': UA }
  const cookie = cookieHeader(cookies, url)
  if (cookie) headers.Cookie = cookie
  if (init.referer) headers.Referer = init.referer
  if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    })
    absorb(cookies, response)
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('request timeout')
    throw error
  }
}

function absorb(cookies: StoredCookie[], response: Response): void {
  const host = new URL(response.url).hostname
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(';')
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    let domain = ''
    for (const attr of attrs) {
      const piece = attr.trim()
      if (piece.toLowerCase().startsWith('domain=')) domain = piece.slice(7).trim().replace(/^\./, '')
    }
    const next: StoredCookie = domain
      ? { name, value, domain: domain.toLowerCase(), hostOnly: false }
      : { name, value, domain: host.toLowerCase(), hostOnly: true }
    const index = cookies.findIndex((item) => item.name === name && item.domain === next.domain && item.hostOnly === next.hostOnly)
    if (index >= 0) cookies[index] = next
    else cookies.push(next)
  }
}

function cookieHeader(cookies: StoredCookie[], url: string): string {
  const host = new URL(url).hostname.toLowerCase()
  const merged = new Map<string, string>()
  for (const cookie of cookies) {
    const matches = cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`)
    if (matches) merged.set(cookie.name, cookie.value)
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function findLoginForm(html: string): string | null {
  for (const form of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    if (/id=["']pwdEncryptSalt["']/i.test(form[1] ?? '')) return form[1] ?? null
  }
  return null
}

function hiddenInputs(form: string): Record<string, string> {
  const inputs: Record<string, string> = {}
  for (const match of form.matchAll(/<input[^>]*name=["']?([A-Za-z0-9_]+)["']?[^>]*value=["']([^"']*)["'][^>]*>/gi)) {
    const name = match[1]
    if (name && inputs[name] === undefined) inputs[name] = match[2] ?? ''
  }
  return inputs
}

function matchValue(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1] ?? null
}

function scriptRedirect(html: string): string | null {
  const match = html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i)
  return match?.[1] ? decodeEntities(match[1]) : null
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function captchaRequired(body: string): boolean {
  return /\btrue\b/i.test(body) && !body.replaceAll(' ', '').includes('false')
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function httpError(status: number): Error {
  return new Error(`academic affairs returned HTTP ${status}`)
}

function assertAllowedHost(url: string): void {
  const parsed = new URL(url)
  const loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  const academicHost = new URL(jwHost()).hostname
  const academicHttp = parsed.protocol === 'http:' && parsed.hostname === academicHost
  if (!loopback && !academicHttp && parsed.protocol !== 'https:') {
    throw new Error(`base URL must be http://127.0.0.1 or https, got ${parsed.protocol}//${parsed.hostname}`)
  }
}

function jwHost(): string {
  return trimSlash(process.env.JW_JW_BASE_URL ?? 'https://jw.dgpt.edu.cn')
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
