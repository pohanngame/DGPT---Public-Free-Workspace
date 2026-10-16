import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildApp } from './app.ts'
import { openDatabase } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
const file = join(process.cwd(), 'data', 'app.sqlite')
mkdirSync(dirname(file), { recursive: true })

const db = openDatabase(file)
const app = buildApp(db)

await app.listen({ host: '127.0.0.1', port })
