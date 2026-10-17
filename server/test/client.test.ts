import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createJwClient } from '../src/jw/client.ts'
import { encryptPassword } from '../src/jw/cipher.ts'

const SALT = '0123456789abcdef'
const EXECUTION = 'e1'
const LT = 'lt1'

function casForm(extra = ''): string {
  return `<form><input id="pwdEncryptSalt" value="${SALT}"><input name="lt" value="${LT}"><input name="execution" value="${EXECUTION}">${extra}</form>`
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handler(req, res, url)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}


test('a fetch that never responds rejects with a timeout and no password', { timeout: 2000 }, async () => {
  const hanging = await listen(() => {})
  try {
    const client = createJwClient({
      casBaseUrl: hanging.origin,
      jwBaseUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
    })
    await assert.rejects(client.login('user', 'pw-secret'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /timeout/i)
      assert.equal(error.message.includes('pw-secret'), false)
      return true
    })
  } finally {
    await hanging.close()
  }
})

test('login posts the cipher form and then requests sso.jsp', async () => {
  const seen: { path: string; body: string }[] = []
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end('false')
      return
    }
    if (url.pathname === '/authserver/login' && req.method === 'POST') {
      seen.push({ path: url.pathname, body: await readBody(req) })
      res.writeHead(302, { Location: '/person' })
      res.end()
      return
    }
    if (url.pathname === '/person') {
      res.end('<html>person</html>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const jw = await listen((req, res, url) => {
    seen.push({ path: url.pathname, body: '' })
    if (url.pathname === '/jsxsd/sso.jsp') {
      res.writeHead(302, { Location: '/jsxsd/framework/xsMain.jsp' })
      res.end()
      return
    }
    if (url.pathname === '/jsxsd/framework/xsMain.jsp') {
      res.end('<html>ok</html>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const client = createJwClient({ casBaseUrl: cas.origin, jwBaseUrl: jw.origin })
    assert.equal(await client.login('user', 'pw'), 'OK')
    const posted = seen.find((item) => item.path === '/authserver/login')
    assert.ok(posted)
    const form = new URLSearchParams(posted.body)
    assert.equal(form.get('username'), 'user')
    assert.equal(form.get('lt'), LT)
    assert.equal(form.get('execution'), EXECUTION)
    assert.equal(form.get('_eventId'), 'submit')
    assert.equal(form.get('cllt'), 'userNameLogin')
    assert.equal(form.get('dllt'), 'generalLogin')
    assert.notEqual(form.get('password'), 'pw')
    assert.ok(form.get('password'))
    assert.ok(seen.some((item) => item.path === '/jsxsd/sso.jsp'))
  } finally {
    await cas.close()
    await jw.close()
  }
})

test('fetchCollegeTable posts skyx and refuses an empty college code', async () => {
  let body = ''
  const jw = await listen(async (req, res, url) => {
    if (url.pathname === '/jsxsd/kbcx/kbxx_teacher_ifr' && req.method === 'POST') {
      body = await readBody(req)
      res.end('<table></table>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const client = createJwClient({ casBaseUrl: 'http://127.0.0.1:1', jwBaseUrl: jw.origin })
    await assert.rejects(() =>
      client.fetchCollegeTable({ semesterCode: '2025-2026-1', kbjcmsid: 'k1', collegeCode: '' }),
    )
    assert.equal(body, '')
    const html = await client.fetchCollegeTable({
      semesterCode: '2025-2026-1',
      kbjcmsid: 'k1',
      collegeCode: '0100',
    })
    assert.equal(html, '<table></table>')
    const form = new URLSearchParams(body)
    assert.equal(form.get('skyx'), '0100')
    assert.equal(form.get('xnxqh'), '2025-2026-1')
    assert.equal(form.get('kbjcmsid'), 'k1')
    assert.equal(form.get('zc1'), '1')
    assert.equal(form.get('zc2'), '30')
    body = ''
    const allSchool = await client.fetchAllTeachersTable({
      semesterCode: '2025-2026-1',
      kbjcmsid: 'k1',
    })
    assert.equal(allSchool, '<table></table>')
    const allForm = new URLSearchParams(body)
    assert.equal(allForm.get('skyx'), '')
    assert.equal(allForm.get('xnxqh'), '2025-2026-1')
    assert.equal(allForm.get('kbjcmsid'), 'k1')
  } finally {
    await jw.close()
  }
})

test('submitSlider posts only sign and reports a rejected verify', async () => {
  const bodies: string[] = []
  let loginPosts = 0
  const pieceKey = '0123456789abcdef'
  const piece = Buffer.concat([Buffer.from('img'), Buffer.from(pieceKey, 'latin1')]).toString('base64')
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end('true')
      return
    }
    if (url.pathname === '/authserver/common/openSliderCaptcha.htl') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bigImage: 'bg64', smallImage: piece, y: 12, sign: 'sig-1' }))
      return
    }
    if (url.pathname === '/authserver/login' && req.method === 'POST') {
      loginPosts += 1
      res.writeHead(302, { Location: '/jsxsd/sso.jsp' })
      res.end()
      return
    }
    if (url.pathname === '/jsxsd/sso.jsp') {
      res.end('<html>person</html>')
      return
    }
    if (url.pathname !== '/authserver/common/verifySliderCaptcha.htl') {
      res.writeHead(404)
      res.end()
      return
    }
    bodies.push(await readBody(req))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(bodies.length === 1 ? { errorCode: 1 } : { errorCode: 0, errorMsg: 'off' }))
  })
  try {
    const client = createJwClient({ casBaseUrl: cas.origin, jwBaseUrl: 'http://127.0.0.1:1' })
    const opened = await client.login('user', 'pw')
    assert.notEqual(opened, 'OK')
    const move = { canvasWidth: 280, move: 40, tracks: [{ a: 1, b: 2, c: 3 }] }
    assert.equal(await client.submitSlider('job', move), 'OK')
    assert.equal(loginPosts, 1)
    await assert.rejects(client.submitSlider('job', move), /slider challenge is missing/)
    assert.equal(bodies.length, 1)
    const form = new URLSearchParams(bodies[0])
    assert.ok(form.get('sign'))
    assert.equal(form.get('canvasLength'), null)
    assert.equal(form.get('moveLength'), null)
    assert.equal(form.get('tracks'), null)
    assert.equal(form.get('captcha'), null)
  } finally {
    await cas.close()
  }
})

test('clears a slider challenge when verify send fails', async () => {
  const pieceKey = '0123456789abcdef'
  const piece = Buffer.concat([Buffer.from('img'), Buffer.from(pieceKey, 'latin1')]).toString('base64')
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end('true')
      return
    }
    if (url.pathname === '/authserver/common/openSliderCaptcha.htl') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ smallImage: piece }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const client = createJwClient({ casBaseUrl: cas.origin, jwBaseUrl: 'http://127.0.0.1:1' })
    await client.login('user', 'pw')
    const move = { canvasWidth: 280, move: 40, tracks: [{ a: 1, b: 2, c: 3 }] }
    await cas.close()
    await assert.rejects(client.submitSlider('job', move))
    await assert.rejects(client.submitSlider('job', move), /slider challenge is missing/)
  } finally {
    await cas.close().catch(() => undefined)
  }
})

test('slider sign uses a 16-byte salt when safeSecure is present but not 16 bytes', async () => {
  const salt = '0123456789abcdef'
  let body = ''
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end('true')
      return
    }
    if (url.pathname === '/authserver/common/openSliderCaptcha.htl') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ safeSecure: 'short', salt, smallImage: 'not-used', y: 1, sign: 'sig' }))
      return
    }
    if (url.pathname === '/authserver/common/verifySliderCaptcha.htl') {
      body = await readBody(req)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ errorCode: 1 }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const fixedRandom = (length: number) => (length === 64 ? 'P'.repeat(64) : 'I'.repeat(length))
    const client = createJwClient({
      casBaseUrl: cas.origin,
      jwBaseUrl: 'http://127.0.0.1:1',
      sliderRandom: fixedRandom,
    })
    const opened = await client.login('user', 'pw')
    assert.notEqual(opened, 'OK')
    const move = { canvasWidth: 280, move: 40, tracks: [{ a: 1, b: 2, c: 3 }] }
    assert.equal(await client.submitSlider('job', move), 'OK')
    assert.notEqual(Buffer.byteLength('short'), 16)
    assert.equal(Buffer.byteLength(salt), 16)
    const form = new URLSearchParams(body)
    assert.ok(form.get('sign'))
    assert.equal(form.get('canvasLength'), null)
    const payload = JSON.stringify({ canvasLength: 280, moveLength: 40, tracks: move.tracks })
    assert.equal(form.get('sign'), encryptPassword(payload, salt, fixedRandom))
  } finally {
    await cas.close()
  }
})

test('teacher page follows 302 cookies and two clients do not share a jar', async () => {
  const seen: { cookie: string | undefined; method: string | undefined; path: string }[] = []
  let tablePosts = 0
  const jw = await listen((req, res, url) => {
    seen.push({ cookie: req.headers.cookie, method: req.method, path: url.pathname })
    if (url.pathname === '/jsxsd/framework/xsMain.jsp') {
      res.end('<html>main</html>')
      return
    }
    if (url.pathname === '/jsxsd/kbcx/kbxx_teacher') {
      if (req.headers.cookie !== 'JSESSIONID=second') {
        res.writeHead(302, { 'Set-Cookie': 'JSESSIONID=second', Location: '/jsxsd/kbcx/kbxx_teacher' })
        res.end()
        return
      }
      res.end('<html>teachers</html>')
      return
    }
    if (url.pathname === '/jsxsd/kbcx/kbxx_teacher_ifr') {
      if (req.method === 'POST') {
        tablePosts += 1
        if (tablePosts === 1) {
          res.writeHead(302, {
            'Set-Cookie': 'JSESSIONID=second',
            Location: '/jsxsd/kbcx/kbxx_teacher_ifr?done=1',
          })
          res.end()
          return
        }
      }
      res.end('<table>ok</table>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const first = createJwClient({ casBaseUrl: 'http://127.0.0.1:1', jwBaseUrl: jw.origin })
    const html = await first.fetchTeacherPage()
    assert.equal(html, '<html>teachers</html>')
    const table = await first.fetchCollegeTable({
      semesterCode: '2025-2026-1',
      kbjcmsid: 'k1',
      collegeCode: '0100',
    })
    assert.equal(table, '<table>ok</table>')
    const second = createJwClient({ casBaseUrl: 'http://127.0.0.1:1', jwBaseUrl: jw.origin })
    await second.fetchTeacherPage()
    const teacherHits = seen.filter((item) => item.path === '/jsxsd/kbcx/kbxx_teacher')
    assert.equal(teacherHits[0]?.cookie, undefined)
    assert.equal(teacherHits[2]?.cookie, undefined)
    const tableHits = seen.filter((item) => item.path.startsWith('/jsxsd/kbcx/kbxx_teacher_ifr'))
    assert.equal(tableHits[0]?.method, 'POST')
    assert.equal(tableHits[1]?.method, 'GET')
    assert.ok(seen.some((item) => item.path === '/jsxsd/framework/xsMain.jsp'))
  } finally {
    await jw.close()
  }
})

test('restoreSession accepts a cached jw cookie after a valid teacher page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-cookie-'))
  const cache = join(dir, 'cookies.json')
  writeFileSync(cache, JSON.stringify([{ name: 'JSESSIONID', value: 'cached', domain: 'jw.dgpt.edu.cn', hostOnly: true, path: '/' }]))
  const requests: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = String(input)
    requests.push(url)
    const response = new Response('<html><title>教师课表</title><select name="xnxqh"></select></html>')
    Object.defineProperty(response, 'url', { value: url })
    return response
  }) as typeof fetch
  try {
    const client = createJwClient({ cookieCachePath: cache, jwBaseUrl: 'https://jw.dgpt.edu.cn' })
    assert.equal(await client.restoreSession?.(), true)
    assert.equal(requests.length, 1)
    assert.equal(new URL(requests[0]).hostname, 'jw.dgpt.edu.cn')
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoreSession removes a cache when the teacher page is a login page or lacks xnxqh', async () => {
  for (const html of ['<html><title>登录</title><select name="xnxqh"></select></html>', '<html><title>教师课表</title></html>']) {
    const dir = mkdtempSync(join(tmpdir(), 'jw-cookie-'))
    const cache = join(dir, 'cookies.json')
    writeFileSync(cache, JSON.stringify([{ name: 'JSESSIONID', value: 'cached', domain: 'jw.dgpt.edu.cn', hostOnly: true, path: '/' }]))
    const original = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const url = String(input)
      const response = new Response(html)
      Object.defineProperty(response, 'url', { value: url })
      return response
    }) as typeof fetch
    try {
      const client = createJwClient({ cookieCachePath: cache, jwBaseUrl: 'https://jw.dgpt.edu.cn' })
      assert.equal(await client.restoreSession?.(), false)
      assert.throws(() => readFileSync(cache))
    } finally {
      globalThis.fetch = original
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('failed non-slider login clears any pending slider form', async () => {
  let loginPosts = 0
  let verifyPosts = 0
  let needSlider = true
  const pieceKey = '0123456789abcdef'
  const piece = Buffer.concat([Buffer.from('img'), Buffer.from(pieceKey, 'latin1')]).toString('base64')
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end(needSlider ? 'true' : 'false')
      return
    }
    if (url.pathname === '/authserver/common/openSliderCaptcha.htl') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bigImage: 'bg64', smallImage: piece, y: 12, sign: 'sig-1' }))
      return
    }
    if (url.pathname === '/authserver/login' && req.method === 'POST') {
      loginPosts += 1
      if (needSlider) {
        res.writeHead(302, { Location: '/jsxsd/sso.jsp' })
      } else {
        res.writeHead(302, { Location: '/error' })
      }
      res.end()
      return
    }
    if (url.pathname === '/authserver/common/verifySliderCaptcha.htl') {
      verifyPosts += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ errorCode: 1 }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const client = createJwClient({ casBaseUrl: cas.origin, jwBaseUrl: 'http://127.0.0.1:1' })
    await client.login('user', 'pw')
    needSlider = false
    await assert.rejects(client.login('user', 'pw'), /credentials rejected/)
    await assert.rejects(
      client.submitSlider('job', { canvasWidth: 280, move: 40, tracks: [{ a: 1, b: 2, c: 3 }] }),
      /slider challenge is missing/,
    )
    assert.equal(loginPosts, 1)
    assert.equal(verifyPosts, 0)
  } finally {
    await cas.close()
  }
})

test('http://example.com throws before any request', async () => {
  let hits = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    hits += 1
    return original(...args)
  }) as typeof fetch
  try {
    const client = createJwClient({ casBaseUrl: 'http://example.com', jwBaseUrl: 'http://127.0.0.1:1' })
    await assert.rejects(() => client.login('user', 'pw'), /http:\/\/127\.0\.0\.1|https:|host/i)
    assert.equal(hits, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('slider-required login returns NEED_SLIDER and does not submit a move', async () => {
  const posts: string[] = []
  const cas = await listen(async (req, res, url) => {
    if (url.pathname === '/authserver/login' && req.method === 'GET') {
      res.end(casForm())
      return
    }
    if (url.pathname === '/authserver/checkNeedCaptcha.htl') {
      res.end('true')
      return
    }
    if (url.pathname === '/authserver/common/openSliderCaptcha.htl') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bigImage: 'bg64', smallImage: 'piece64', y: 12, sign: 'sig-1' }))
      return
    }
    if (req.method === 'POST') {
      posts.push(url.pathname)
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const client = createJwClient({ casBaseUrl: cas.origin, jwBaseUrl: 'http://127.0.0.1:1' })
    const result = await client.login('user', 'pw')
    assert.deepEqual(result, { code: 'NEED_SLIDER', sign: 'sig-1', bg: 'bg64', piece: 'piece64', y: 12 })
    assert.deepEqual(posts, [])
  } finally {
    await cas.close()
  }
})
