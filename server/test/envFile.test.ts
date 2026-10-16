import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnvFile, readEnvLocal } from '../src/envFile.ts'

test('parseEnvFile reads JW_BASE_URL when the first line has a UTF-8 BOM', () => {
  const parsed = parseEnvFile('\uFEFFJW_BASE_URL=https://example.invalid/jw\n# comment\n\nOTHER=skip\n')
  assert.equal(parsed.JW_BASE_URL, 'https://example.invalid/jw')
  assert.equal(parseEnvFile('JW_BASE_URL="https://example.invalid/jw"').JW_BASE_URL, 'https://example.invalid/jw')
  assert.equal('OTHER' in parsed, false)
})

test('readEnvLocal sets only allowlisted keys that are not already in the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-local-'))
  const previousPort = process.env.PORT
  delete process.env.JW_BASE_URL
  delete process.env.JW_USERNAME
  delete process.env.NOT_ALLOWED
  process.env.PORT = '9'
  try {
    writeFileSync(
      join(dir, '.env.local'),
      '\uFEFF JW_BASE_URL = https://example.invalid/jw \nPORT=4000\nJW_USERNAME=user\nNOT_ALLOWED=1\n',
    )
    const applied = readEnvLocal(dir)
    assert.equal(applied.JW_BASE_URL, 'https://example.invalid/jw')
    assert.equal(process.env.JW_BASE_URL, 'https://example.invalid/jw')
    assert.equal(process.env.PORT, '9')
    assert.equal(process.env.JW_USERNAME, 'user')
    assert.equal(process.env.NOT_ALLOWED, undefined)
  } finally {
    if (previousPort === undefined) delete process.env.PORT
    else process.env.PORT = previousPort
    delete process.env.JW_BASE_URL
    delete process.env.JW_USERNAME
    rmSync(dir, { recursive: true, force: true })
  }
})
