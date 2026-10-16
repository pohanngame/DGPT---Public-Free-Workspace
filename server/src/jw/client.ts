import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { inflateSync } from 'node:zlib'
import { encryptPassword } from './cipher.ts'
import type { JwClient } from '../sync.ts'

const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const UA = 'jiaowukebiao/0.1'
let currentSliderKey = ''

export interface JwClientOptions {
  casBaseUrl?: string
  jwBaseUrl?: string
  sliderRandom?: (length: number) => string
  timeoutMs?: number
  cookieCachePath?: string
  now?: () => number
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
  const timeoutMs = options.timeoutMs ?? 60_000
  const now = options.now ?? Date.now
  const cachePath = options.cookieCachePath
  const casBase = () => trimSlash(options.casBaseUrl ?? process.env.JW_BASE_URL ?? 'https://authserver.dgpt.edu.cn')
  const jwBase = () => trimSlash(options.jwBaseUrl ?? process.env.JW_JW_BASE_URL ?? 'https://jw.dgpt.edu.cn')

  return {
    async restoreSession(): Promise<boolean> {
      if (!cachePath) return false
      const saved = readCookieCache(cachePath, now())
      if (!saved) return false
      cookies.splice(0, cookies.length, ...saved)
      try {
        const html = await followGet(cookies, `${jwBase()}/jsxsd/kbcx/kbxx_teacher`, timeoutMs)
        return html.includes('xnxqh')
      } catch {
        cookies.splice(0, cookies.length)
        return false
      }
    },

    async login(username, password) {
      const loginUrl = `${casBase()}/authserver/login`
      let page = await openLoginPage(cookies, loginUrl, timeoutMs)
      if (!findLoginForm(page.html)) {
        cookies.splice(0, cookies.length)
        page = await openLoginPage(cookies, loginUrl, timeoutMs)
      }
      const form = findLoginForm(page.html)
      if (!form) {
        logBadLoginPage(page.status, page.html)
        throw new Error('教务统一认证页面未正常返回（可能需要重新过验证或校园网 IP 限制），请重试')
      }
      const salt = findSalt(form)
      const inputs = hiddenInputs(form)

      const checkUrl = `${casBase()}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}`
      const check = await send(cookies, checkUrl, { timeoutMs })
      const checkBody = (await check.text()).trim()
      if (captchaRequired(checkBody)) {
        return openSlider(cookies, casBase(), timeoutMs, (key) => {
          sliderKey = key
          currentSliderKey = key
        })
      }

      const body = new URLSearchParams({
        username,
        password: salt ? encryptPassword(password, salt) : password,
        lt: inputs.lt ?? '',
        execution: inputs.execution ?? '',
        _eventId: 'submit',
        cllt: 'userNameLogin',
        dllt: 'generalLogin',
      })
      const posted = await send(cookies, loginUrl, { method: 'POST', body, referer: loginUrl, timeoutMs })
      const location = posted.headers.get('location')
      if (location?.includes('error')) throw new Error('credentials rejected')
      const chain = isRedirect(posted.status) && location ? new URL(location, loginUrl).toString() : `${jwBase()}/jsxsd/sso.jsp`
      const landed = isRedirect(posted.status)
        ? await followResponse(cookies, posted, loginUrl, timeoutMs)
        : await follow(cookies, chain, timeoutMs)
      if (!new URL(landed.url).pathname.startsWith('/jsxsd/')) {
        await follow(cookies, `${jwBase()}/jsxsd/sso.jsp`, timeoutMs)
      }
      if (cachePath) writeCookieCache(cachePath, cookies, now())
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
      if (json.errorCode === 1) {
        if (cachePath) writeCookieCache(cachePath, cookies, now())
        return 'OK'
      }
      return { code: 'SLIDER_FAILED', message: json.errorMsg || json.message || 'slider rejected' }
    },

    async fetchTeacherPage() {
      const base = jwBase()
      await followGet(cookies, `${base}/jsxsd/framework/xsMain.jsp`, timeoutMs)
      return followGet(cookies, `${base}/jsxsd/kbcx/kbxx_teacher`, timeoutMs)
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
  return finishRedirect(cookies, response, `${jwBase}/jsxsd/kbcx/kbxx_teacher_ifr`, timeoutMs)
}

async function followGet(cookies: StoredCookie[], url: string, timeoutMs: number): Promise<string> {
  const response = await send(cookies, url, { timeoutMs })
  return finishRedirect(cookies, response, url, timeoutMs)
}

async function followResponse(
  cookies: StoredCookie[],
  first: Response,
  url: string,
  timeoutMs: number,
): Promise<{ url: string; status: number }> {
  const html = await finishRedirect(cookies, first, url, timeoutMs)
  const target = scriptRedirect(html)
  const next = target ? new URL(target, url).toString() : url
  return target ? follow(cookies, next, timeoutMs) : { url, status: 200 }
}

async function finishRedirect(
  cookies: StoredCookie[],
  first: Response,
  url: string,
  timeoutMs: number,
): Promise<string> {
  let response = first
  let current = url
  for (let hop = 0; hop < 10; hop++) {
    if (response.status === 200) return response.text()
    if (!isRedirect(response.status)) throw httpError(response.status)
    const location = response.headers.get('location')
    if (!location) throw httpError(response.status)
    current = new URL(location, current).toString()
    await response.text().catch(() => undefined)
    response = await send(cookies, current, { timeoutMs })
  }
  if (response.status === 200) return response.text()
  throw new Error('redirect chain too long')
}

const SLIDER_RETRY = '教务滑动验证未通过，请稍后重试'

async function solveSlider(
  cookies: StoredCookie[],
  casBase: string,
  timeoutMs: number,
  sliderRandom: ((length: number) => string) | undefined,
  now: () => number,
  remember: (key: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const challenge = await openSlider(cookies, casBase, timeoutMs, remember)
    const move = await gapMove(challenge.bg, challenge.piece, challenge.y)
    if (process.env.JW_DEBUG_SLIDER === '1') {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(`probe/out/debug-${attempt}-bg.bin`, Buffer.from(challenge.bg, 'base64'))
      writeFileSync(`probe/out/debug-${attempt}-piece.bin`, Buffer.from(challenge.piece, 'base64'))
      writeFileSync(
        `probe/out/debug-${attempt}.json`,
        JSON.stringify({ x: move.x, canvas: move.canvasLength, y: challenge.y, score: move.score }),
      )
    }
    const tracks = sliderTracks(move.x, now())
    const result = await postSlider(cookies, casBase, timeoutMs, sliderRandom, move.canvasLength, move.x, tracks)
    if (result === 'OK') return
  }
  throw new Error(SLIDER_RETRY)
}

async function postSlider(
  cookies: StoredCookie[],
  casBase: string,
  timeoutMs: number,
  sliderRandom: ((length: number) => string) | undefined,
  canvasLength: number,
  moveLength: number,
  tracks: { a: number; b: number; c: number }[],
): Promise<'OK' | 'FAIL'> {
  const url = `${casBase}/authserver/common/verifySliderCaptcha.htl`
  if (!currentSliderKey) throw new Error('slider challenge is missing')
  const payload = JSON.stringify({ canvasLength, moveLength, tracks })
  const body = new URLSearchParams({ sign: encryptPassword(payload, currentSliderKey, sliderRandom) })
  const response = await send(cookies, url, {
    method: 'POST',
    body,
    referer: `${casBase}/authserver/login`,
    timeoutMs,
  })
  if (response.status !== 200) throw httpError(response.status)
  const json = (await response.json()) as { errorCode?: number }
  return json.errorCode === 1 ? 'OK' : 'FAIL'
}

async function gapMove(bg64: string, piece64: string, y: number): Promise<{ canvasLength: number; x: number; score: number }> {
  const bg = await decodeRaster(bg64)
  const piece = await decodeRaster(piece64)
  const canvasLength = bg.width
  const origin = Math.max(0, Math.min(y, Math.max(0, bg.height - piece.height)))
  let minX = piece.width
  let maxX = 0
  let minY = piece.height
  let maxY = 0
  for (let py = 0; py < piece.height; py++) {
    for (let px = 0; px < piece.width; px++) {
      if ((piece.alpha[(py * piece.width + px) * 4 + 3] ?? 0) < 128) continue
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  }
  const pieceWidth = Math.max(1, maxX - minX + 1)
  const top = origin + minY
  const bottom = origin + maxY
  let bestX = 0
  let best = Number.POSITIVE_INFINITY
  const limit = Math.max(0, bg.width - pieceWidth)
  for (let x = 0; x <= limit; x++) {
    let score = 0
    let count = 0
    for (let by = top; by <= bottom; by += 2) {
      if (by < 0 || by >= bg.height) continue
      for (let bx = x; bx < x + pieceWidth; bx += 2) {
        score += bg.gray[by * bg.width + bx] ?? 255
        count += 1
      }
    }
    const mean = count === 0 ? Number.POSITIVE_INFINITY : score / count
    if (mean < best) {
      best = mean
      bestX = x - minX
    }
  }
  return { canvasLength, x: Math.max(0, bestX), score: best }
}

function sliderTracks(x: number, start: number): { a: number; b: number; c: number }[] {
  const points: { a: number; b: number; c: number }[] = [{ a: 0, b: 0, c: start }]
  let a = 0
  let c = start
  const steps = [2, 4, 6, 9, 12, 15, 11, 8, 5, 3, 2, 1]
  let i = 0
  while (a < x) {
    const remaining = x - a
    const step = Math.max(1, Math.min(remaining, steps[Math.min(i, steps.length - 1)]!))
    a += step
    c += 12 + (i % 4) * 5
    points.push({ a, b: i % 7 === 0 ? 1 : 0, c })
    i += 1
  }
  points.push({ a: x, b: 0, c: c + 180 })
  return points
}

async function decodeRaster(value: string): Promise<{ width: number; height: number; gray: Uint8Array; alpha: Uint8Array }> {
  const bytes = Buffer.from(value, 'base64')
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes)
  return decodePng(bytes)
}

function decodePng(bytes: Buffer): { width: number; height: number; gray: Uint8Array; alpha: Uint8Array } {
  let offset = 8
  let width = 0
  let height = 0
  let color = 6
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset) >>> 0
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      color = data[9] ?? 6
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const inflated = inflateSync(Buffer.concat(idat))
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 4 ? 2 : 1
  const gray = new Uint8Array(width * height)
  const alpha = new Uint8Array(width * height * 4)
  let src = 0
  const stride = width * channels
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = inflated[src] ?? 0
    src += 1
    const row = Buffer.from(inflated.subarray(src, src + stride))
    src += stride
    unfilter(filter, row, prev, channels)
    for (let x = 0; x < width; x++) {
      const i = x * channels
      const g = channels === 1 || channels === 2 ? row[i]! : Math.round((row[i]! + row[i + 1]! + row[i + 2]!) / 3)
      gray[y * width + x] = g
      const a = channels === 4 ? row[i + 3]! : channels === 2 ? row[i + 1]! : 255
      const p = (y * width + x) * 4
      alpha[p + 3] = a
    }
    prev = row
  }
  return { width, height, gray, alpha }
}

function unfilter(filter: number, row: Buffer, prev: Buffer, channels: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= channels ? row[i - channels]! : 0
    const up = prev[i] ?? 0
    const ul = i >= channels ? prev[i - channels]! : 0
    if (filter === 1) row[i] = (row[i]! + left) & 255
    else if (filter === 2) row[i] = (row[i]! + up) & 255
    else if (filter === 3) row[i] = (row[i]! + Math.floor((left + up) / 2)) & 255
    else if (filter === 4) row[i] = (row[i]! + paeth(left, up, ul)) & 255
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

async function decodeJpeg(bytes: Buffer): Promise<{ width: number; height: number; gray: Uint8Array; alpha: Uint8Array }> {
  const { decode } = await import('jpeg-js')
  const image = decode(bytes, { useTArray: true, formatAsRGBA: true })
  const gray = new Uint8Array(image.width * image.height)
  const alpha = new Uint8Array(gray.length * 4)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round((image.data[i * 4]! + image.data[i * 4 + 1]! + image.data[i * 4 + 2]!) / 3)
    alpha[i * 4 + 3] = image.data[i * 4 + 3] ?? 255
  }
  return { width: image.width, height: image.height, gray, alpha }
}

function decodeBaselineJpeg(bytes: Buffer): { width: number; height: number; pixels: Uint8Array } {
  let offset = 2
  let width = 1
  let height = 1
  const quant: number[][] = []
  let frame: { id: number; h: number; v: number; q: number }[] = []
  let huffman: { id: number; bits: number[]; values: number[] }[] = []
  let scanStart = bytes.length
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xd8) {
      offset += 2
      continue
    }
    if (marker === 0xd9) break
    const size = bytes.readUInt16BE(offset + 2)
    const body = bytes.subarray(offset + 4, offset + 2 + size)
    if (marker === 0xdb) readQuant(body, quant)
    else if (marker === 0xc4) huffman = huffman.concat(readHuffman(body))
    else if (marker === 0xc0) {
      height = body.readUInt16BE(1)
      width = body.readUInt16BE(3)
      frame = readFrame(body)
    } else if (marker === 0xda) {
      scanStart = offset + 2 + size
      break
    }
    offset += 2 + size
  }
  const pixels = scanBaseline(bytes.subarray(scanStart), width, height, frame, quant, huffman)
  return { width, height, pixels }
}

function readQuant(body: Buffer, tables: number[][]): void {
  let p = 0
  while (p < body.length) {
    const id = (body[p]! >> 0) & 15
    const table = new Array<number>(64)
    for (let i = 0; i < 64; i++) table[ZIGZAG[i]!] = body[p + 1 + i] ?? 1
    tables[id] = table
    p += 65
  }
}

function readHuffman(body: Buffer): { id: number; bits: number[]; values: number[] }[] {
  const found: { id: number; bits: number[]; values: number[] }[] = []
  let p = 0
  while (p < body.length) {
    const id = ((body[p]! >> 4) & 1) * 16 + (body[p]! & 15)
    const bits = [...body.subarray(p + 1, p + 17)]
    const count = bits.reduce((sum, n) => sum + n, 0)
    found.push({ id, bits, values: [...body.subarray(p + 17, p + 17 + count)] })
    p += 17 + count
  }
  return found
}

function readFrame(body: Buffer): { id: number; h: number; v: number; q: number }[] {
  const count = body[5] ?? 0
  const components = []
  for (let i = 0; i < count; i++) {
    const sample = body[6 + i * 3]! >> 4
    components.push({
      id: body[6 + i * 3] ?? 0,
      h: sample & 15,
      v: body[7 + i * 3]! & 15,
      q: body[8 + i * 3] ?? 0,
    })
  }
  return components
}

function scanBaseline(
  scan: Buffer,
  width: number,
  height: number,
  frame: { id: number; h: number; v: number; q: number }[],
  quant: number[][],
  huffman: { id: number; bits: number[]; values: number[] }[],
): Uint8Array {
  const pixels = new Uint8Array(width * height * 3)
  pixels.fill(255)
  const maxH = Math.max(1, ...frame.map((item) => item.h))
  const maxV = Math.max(1, ...frame.map((item) => item.v))
  const mcuWidth = maxH * 8
  const mcuHeight = maxV * 8
  const bit = { bytes: unstuff(scan), pos: 0 }
  const prev = [0, 0, 0]
  for (let my = 0; my < height; my += mcuHeight) {
    for (let mx = 0; mx < width; mx += mcuWidth) {
      const planes: Int16Array[] = []
      for (const component of frame) {
        for (let v = 0; v < component.v; v++) {
          for (let h = 0; h < component.h; h++) {
            planes.push(decodeBlock(bit, huffman, quant[component.q] ?? [], prev, frame.indexOf(component)))
          }
        }
      }
      paintMcu(pixels, width, height, mx, my, frame, planes)
    }
  }
  return pixels
}

function unstuff(scan: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < scan.length; i++) {
    const byte = scan[i]!
    if (byte === 0xff && scan[i + 1] === 0x00) {
      out.push(0xff)
      i += 1
      continue
    }
    if (byte === 0xff) break
    out.push(byte)
  }
  return Buffer.from(out)
}

function decodeBlock(
  bit: { bytes: Buffer; pos: number },
  huffman: { id: number; bits: number[]; values: number[] }[],
  quantTable: number[],
  prev: number[],
  component: number,
): Int16Array {
  const block = new Int16Array(64)
  const dc = huffman.find((item) => item.id === component) ?? huffman[0]
  const ac = huffman.find((item) => item.id === component + 16) ?? huffman[1] ?? dc
  if (!dc || !ac) return block
  const dcSize = readSymbol(bit, dc)
  const dcDiff = readBits(bit, dcSize)
  prev[component] = (prev[component] ?? 0) + extend(dcDiff, dcSize)
  block[0] = (prev[component] ?? 0) * (quantTable[0] ?? 1)
  let index = 1
  while (index < 64) {
    const symbol = readSymbol(bit, ac)
    if (symbol === 0) break
    index += symbol >> 4
    const size = symbol & 15
    if (index >= 64) break
    const value = extend(readBits(bit, size), size)
    block[ZIGZAG[index]!] = value * (quantTable[ZIGZAG[index]!] ?? 1)
    index += 1
  }
  idct(block)
  return block
}

function readSymbol(bit: { bytes: Buffer; pos: number }, table: { bits: number[]; values: number[] }): number {
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length <= 16; length++) {
    code = (code << 1) | readBits(bit, 1)
    const count = table.bits[length - 1] ?? 0
    if (code - first < count) return table.values[index + code - first] ?? 0
    index += count
    first = (first + count) << 1
  }
  return 0
}

function readBits(bit: { bytes: Buffer; pos: number }, count: number): number {
  let value = 0
  for (let i = 0; i < count; i++) {
    const byte = bit.bytes[bit.pos >> 3] ?? 0
    value = (value << 1) | ((byte >> (7 - (bit.pos & 7))) & 1)
    bit.pos += 1
  }
  return value
}

function extend(value: number, size: number): number {
  if (size === 0) return 0
  const limit = 1 << (size - 1)
  return value < limit ? value - ((1 << size) - 1) : value
}

function idct(block: Int16Array): void {
  const out = new Int16Array(64)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          const cu = u === 0 ? 0.70710678118 : 1
          const cv = v === 0 ? 0.70710678118 : 1
          sum += cu * cv * block[v * 8 + u]! * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16)
        }
      }
      out[y * 8 + x] = Math.max(0, Math.min(255, Math.round(sum / 4 + 128)))
    }
  }
  block.set(out)
}

function paintMcu(
  pixels: Uint8Array,
  width: number,
  height: number,
  mx: number,
  my: number,
  frame: { h: number; v: number }[],
  planes: Int16Array[],
): void {
  const yBlocks = planes.slice(0, (frame[0]?.h ?? 1) * (frame[0]?.v ?? 1))
  const cb = planes[yBlocks.length]
  const cr = planes[yBlocks.length + 1]
  const h = frame[0]?.h ?? 1
  const v = frame[0]?.v ?? 1
  for (let y = 0; y < v * 8; y++) {
    for (let x = 0; x < h * 8; x++) {
      const px = mx + x
      const py = my + y
      if (px >= width || py >= height) continue
      const block = yBlocks[Math.floor(y / 8) * h + Math.floor(x / 8)]
      const luma = block?.[(y % 8) * 8 + (x % 8)] ?? 255
      const chromaX = Math.floor(x / h)
      const chromaY = Math.floor(y / v)
      const cbValue = cb?.[chromaY * 8 + chromaX] ?? 128
      const crValue = cr?.[chromaY * 8 + chromaX] ?? 128
      const target = (py * width + px) * 3
      pixels[target] = clamp(luma + 1.402 * (crValue - 128))
      pixels[target + 1] = clamp(luma - 0.344136 * (cbValue - 128) - 0.714136 * (crValue - 128))
      pixels[target + 2] = clamp(luma + 1.772 * (cbValue - 128))
    }
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63,
]

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
  if (key) {
    remember(key)
    currentSliderKey = key
  }
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

function readCookieCache(file: string, now: number): StoredCookie[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { savedAt?: unknown; cookies?: unknown }
    if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > COOKIE_MAX_AGE_MS) return null
    if (!Array.isArray(parsed.cookies)) return null
    const saved: StoredCookie[] = []
    for (const item of parsed.cookies) {
      if (!item || typeof item !== 'object') return null
      const cookie = item as Partial<StoredCookie>
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') return null
      if (!cookie.name || cookie.name.toLowerCase() === 'password') return null
      saved.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, hostOnly: cookie.hostOnly === true })
    }
    return saved.length > 0 ? saved : null
  } catch {
    return null
  }
}

function writeCookieCache(file: string, cookies: StoredCookie[], now: number): void {
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, JSON.stringify({ savedAt: now, cookies }))
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows may reject the Unix mode. The file is still local and gitignored.
  }
  renameSync(temporary, file)
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
    const body = form[1] ?? ''
    if (findSalt(body) || /type=["']password["']/i.test(body) || /name=["']execution["']/i.test(body)) return body
  }
  return null
}

function findSalt(form: string): string | null {
  const named = form.match(/<(?:input|textarea)\b[^>]*(?:\bid|\bname)=["']pwdEncryptSalt["'][^>]*>/i)
  const fromNamed = named ? attrValue(named[0]) : null
  if (fromNamed) return fromNamed
  for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0]
    if (!/type=["']hidden["']/i.test(tag)) continue
    const name = tag.match(/\bname=["']([^"']*)["']/i)?.[1] ?? ''
    const id = tag.match(/\bid=["']([^"']*)["']/i)?.[1] ?? ''
    if (!/salt/i.test(`${name} ${id}`)) continue
    const value = attrValue(tag)
    if (value) return value
  }
  return null
}

function attrValue(tag: string): string | null {
  return tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? null
}

async function openLoginPage(
  cookies: StoredCookie[],
  loginUrl: string,
  timeoutMs: number,
): Promise<{ status: number; html: string }> {
  const opened = await send(cookies, loginUrl, { timeoutMs })
  if (opened.status === 200) return { status: opened.status, html: await opened.text() }
  if (!isRedirect(opened.status)) return { status: opened.status, html: await opened.text() }
  const html = await finishRedirect(cookies, opened, loginUrl, timeoutMs)
  return { status: 200, html }
}

function logBadLoginPage(status: number, html: string): void {
  const title = html.match(/<title>([^<]*)/i)?.[1]?.trim() || 'untitled'
  const preview = html.replace(/\s+/g, ' ').slice(0, 300)
  console.error(`login page missing pwdEncryptSalt status=${status} title=${title} html=${preview}`)
}

function hiddenInputs(form: string): Record<string, string> {
  const inputs: Record<string, string> = {}
  for (const match of form.matchAll(/<input[^>]*name=["']?([A-Za-z0-9_]+)["']?[^>]*value=["']([^"']*)["'][^>]*>/gi)) {
    const name = match[1]
    if (name && inputs[name] === undefined) inputs[name] = match[2] ?? ''
  }
  return inputs
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
