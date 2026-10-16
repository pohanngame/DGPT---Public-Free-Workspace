import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseTeacherTable } from '../src/jw/parseTable.ts'

const fixture = readFileSync(new URL('./fixtures/one-college.html', import.meta.url), 'utf8')

function teacherRow(name: string, occupancyCell: string): string {
  const cells = [`<td><nobr>${name}</nobr></td>`, `<td>${occupancyCell}</td>`]
  while (cells.length < 43) {
    cells.push('<td></td>')
  }
  return `<table id="kbtable"><tr></tr><tr></tr><tr>${cells.join('')}</tr></table>`
}

test('fixture parses to 59 teachers starting with 张燕琴', () => {
  const teachers = parseTeacherTable(fixture)
  assert.equal(teachers.length, 59)
  assert.equal(teachers[0]?.name, '张燕琴')
  assert.ok(teachers.some((teacher) => teacher.name === '梁杰'))
})

test('week text (2-13周) occupies weeks 2 through 13', () => {
  const teachers = parseTeacherTable(teacherRow('测试', '机械设计<br>(2-13周)'))
  assert.equal(teachers.length, 1)
  assert.equal(teachers[0]?.cells.length, 1)
  assert.equal(teachers[0]?.cells[0]?.weekStart, 2)
  assert.equal(teachers[0]?.cells[0]?.weekEnd, 13)
  assert.equal(teachers[0]?.cells[0]?.dayOfWeek, 1)
  assert.equal(teachers[0]?.cells[0]?.slotCode, '0102')
})

test('occupancy without week text occupies weeks 1 through 30', () => {
  const teachers = parseTeacherTable(teacherRow('测试', '实验课占位'))
  assert.equal(teachers.length, 1)
  assert.equal(teachers[0]?.cells[0]?.weekStart, 1)
  assert.equal(teachers[0]?.cells[0]?.weekEnd, 30)
  assert.equal(teachers[0]?.cells[0]?.occupancyText, '实验课占位')
})
