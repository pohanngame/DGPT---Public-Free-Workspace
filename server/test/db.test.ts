import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../src/db.ts'

const EXPECTED_TABLES = [
  'colleges',
  'semesters',
  'teachers',
  'teacher_colleges',
  'teacher_programs',
  'occupancies',
  'preset_groups',
  'preset_group_members',
  'settings',
  'semester_teachers',
]

test('openDatabase creates the common-free tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'common-free-'))
  const file = join(dir, 'app.sqlite')
  const db = openDatabase(file)
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    const names = rows.map((row) => row.name)
    for (const table of EXPECTED_TABLES) {
      assert.ok(names.includes(table), `missing table ${table}`)
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
