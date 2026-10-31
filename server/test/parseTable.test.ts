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

test('a 2023 table with five slots per day keeps the friday class', () => {
  const html = readFileSync(new URL('./fixtures/old-semester-five-slots.html', import.meta.url), 'utf8')
  const teachers = parseTeacherTable(html)
  const teacher = teachers.find((item) => item.name === '李龙根')
  assert.ok(teachers.length > 1)
  assert.equal(teacher?.cells.length, 1)
  assert.equal(teacher?.cells[0]?.dayOfWeek, 5)
  assert.equal(teacher?.cells[0]?.slotCode, '0102')
})

test('occupancy without week text occupies weeks 1 through 30', () => {
  const teachers = parseTeacherTable(teacherRow('测试', '实验课占位'))
  assert.equal(teachers.length, 1)
  assert.equal(teachers[0]?.cells[0]?.weekStart, 1)
  assert.equal(teachers[0]?.cells[0]?.weekEnd, 30)
  assert.equal(teachers[0]?.cells[0]?.occupancyText, '实验课占位')
})

test('a cell with several course blocks keeps every week range', () => {
  const html = teacherRow(
    '万松峰',
    '工业机器人操作二<br>24级机电1班<br>万松峰<br>(2-6周)<br>6A202<br>' +
      '工业机器人操作二<br>24级机电1班<br>万松峰<br>(7-10,14周)<br>6A202<br>' +
      '工业机器人应用实训<br>24级机电2班<br>万松峰<br>(18周)<br>6C4-203<br>' +
      '工业机器人应用实训<br>24级机电1班<br>万松峰<br>(19周)<br>6C4-203',
  )
  const cells = parseTeacherTable(html)[0]?.cells ?? []
  assert.deepEqual(
    cells.map((cell) => [cell.weekStart, cell.weekEnd]),
    [
      [2, 6],
      [7, 10],
      [14, 14],
      [18, 18],
      [19, 19],
    ],
  )
  assert.equal(cells[0]?.occupancyText, '工业机器人操作二\n24级机电1班\n万松峰\n(2-6周)')
  assert.equal(cells[1]?.occupancyText, '工业机器人操作二\n24级机电1班\n万松峰\n(7-10,14周)')
  assert.ok(cells.at(-1)?.occupancyText.endsWith('(19周)\n6C4-203'))
})
