import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 只允许地址与端口。账号密码永不从文件读取，同步时由前端逐次输入。
const ALLOWED = new Set(['JW_BASE_URL', 'JW_JW_BASE_URL', 'PORT'])

export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!ALLOWED.has(key)) continue
    parsed[key] = unquote(trimmed.slice(eq + 1).trim())
  }
  return parsed
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

export function readEnvLocal(cwd = process.cwd()): Record<string, string> {
  const file = join(cwd, '.env.local')
  if (!existsSync(file)) return {}
  const parsed = parseEnvFile(readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return parsed
}
