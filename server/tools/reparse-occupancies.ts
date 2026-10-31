/**
 * 一次性回填：把已入库的占用行按修复后的解析规则重新展开。
 *
 * 背景：旧解析器对一个格子里的多个课程块只保留第一块的周次，导致后面几周被误判成空闲。
 * 库里存的 occupancy_text 是原始格子文本，所以不重新同步教务也能就地修正。
 *
 * 幂等：按 (学期, 教师, 星期, 节次) 分组，只处理只有 1 行的组；展开后这些组变成多行，
 * 再次执行会被跳过。无变化的行不会被触碰。
 *
 * 用法：npm run backfill -- [--semester 2025-2026-2] [--db data/app.sqlite] [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { extractWeekBlocks } from '../src/jw/parseTable.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const dbPath = resolve(flag('db') ?? 'data/app.sqlite')
const semester = flag('semester')

const db = new DatabaseSync(dbPath)
const filter = semester ? 'WHERE semester_code = ?' : ''
const params = semester ? [semester] : []
const rows = db
  .prepare(
    `SELECT id, semester_code, teacher_name, day_of_week, slot_code, week_start, week_end, occupancy_text
     FROM occupancies ${filter} ORDER BY semester_code, teacher_name, day_of_week, slot_code, id`,
  )
  .all(...params) as {
  id: number
  semester_code: string
  teacher_name: string
  day_of_week: number
  slot_code: string
  week_start: number
  week_end: number
  occupancy_text: string
}[]

const groups = new Map<string, typeof rows>()
for (const row of rows) {
  const key = [row.semester_code, row.teacher_name, row.day_of_week, row.slot_code].join('\u0000')
  const list = groups.get(key)
  if (list) list.push(row)
  else groups.set(key, [row])
}

const insert = db.prepare(
  `INSERT INTO occupancies (semester_code, teacher_name, day_of_week, slot_code, week_start, week_end, occupancy_text)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)
const remove = db.prepare('DELETE FROM occupancies WHERE id = ?')

let changedGroups = 0
let addedRows = 0
db.exec('BEGIN')
try {
  for (const group of groups.values()) {
    if (group.length !== 1) continue
    const [row] = group as [(typeof rows)[number]]
    const blocks = extractWeekBlocks(row.occupancy_text)
    if (blocks.length === 1 && blocks[0]!.weekStart === row.week_start && blocks[0]!.weekEnd === row.week_end) {
      continue
    }
    changedGroups += 1
    addedRows += blocks.length - 1
    if (dryRun) continue
    remove.run(row.id)
    for (const block of blocks) {
      insert.run(
        row.semester_code,
        row.teacher_name,
        row.day_of_week,
        row.slot_code,
        block.weekStart,
        block.weekEnd,
        block.occupancyText,
      )
    }
  }
  db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

console.log(`数据库      ${dbPath}`)
console.log(`学期        ${semester ?? '全部'}`)
console.log(`读取占用行  ${rows.length}`)
console.log(`需要展开的格 ${changedGroups}`)
console.log(`净增占用行  ${addedRows}`)
console.log(dryRun ? '模式        预演（已回滚，未写入）' : '模式        已写入')
db.close()
