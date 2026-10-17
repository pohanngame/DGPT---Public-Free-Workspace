import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, relative } from 'node:path'
import { buildApp } from './app.ts'
import { openDatabase } from './db.ts'
import { readEnvLocal } from './envFile.ts'
import { createJwClient } from './jw/client.ts'

readEnvLocal()
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const file = join(process.cwd(), 'data', 'app.sqlite')
mkdirSync(dirname(file), { recursive: true })

const db = openDatabase(file)
const app = buildApp(db, { jwClient: createJwClient({ cookieCachePath: join(process.cwd(), '.jw_cookie_cache.json') }) })
const dist = join(process.cwd(), 'dist')

app.get('/*', async (request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' })
  const requested = decodeURIComponent(request.url.split('?')[0])
  const filePath = normalize(join(dist, requested))
  if (relative(dist, filePath).startsWith('..')) return reply.code(404).send({ error: 'Not found' })
  const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : join(dist, 'index.html')
  if (!existsSync(target)) return reply.code(404).send({ error: 'Not found' })
  const types: Record<string, string> = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' }
  return reply.type(types[extname(target)] ?? 'application/octet-stream').send(readFileSync(target))
})

await app.listen({ host, port })
