import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseTeacherPage } from '../src/jw/page.ts'

const fixture = readFileSync(new URL('./fixtures/teacher-page.html', import.meta.url), 'utf8')

test('teacher page has 13 colleges, the sole kbjcmsid, and the current semester', () => {
  const page = parseTeacherPage(fixture)
  assert.equal(page.colleges.length, 13)
  assert.equal(page.kbjcmsid, '947A14DB0EE37B4EE0530100007FD241')
  const current = page.semesters.filter((semester) => semester.isCurrent)
  assert.deepEqual(current, [{ code: '2026-2027-1', label: '2026-2027-1', isCurrent: true }])
  const manufacturing = page.colleges.find((college) => college.shortCode === '0012')
  assert.equal(manufacturing?.name, '智能制造学院')
  const preparatory = page.colleges.find((college) => college.code === '0100')
  assert.equal(preparatory?.code, '0100')
  assert.equal(preparatory?.shortCode, '0100')
  assert.equal(preparatory?.name, '商学院（筹）')
})

test('two unselected kbjcmsid options are ambiguous', () => {
  const html = `<select name="xnxqh"><option value="2026-2027-1" selected>2026-2027-1</option></select>
<select name="kbjcmsid"><option value="AAAA">甲</option><option value="BBBB">乙</option></select>
<select name="skyx"><option value="">-请选择-</option></select>`
  assert.throws(
    () => parseTeacherPage(html),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'KBJCMSID_AMBIGUOUS')
      return true
    },
  )
})
