# Common Free Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local single-screen app that syncs the academic-affairs teacher table by college and shows the 42-cell common-free matrix.

**Architecture:** Fastify on `127.0.0.1` owns SQLite and the ported login/parse flow. Vue is a client of `docs/superpowers/specs/2026-08-14-common-free-api.ts`. Sync jobs live in memory; passwords and cookies never do.

**Tech Stack:** Node 22, TypeScript, Fastify, better-sqlite3, Vite, Vue 3.

**Spec:** `docs/superpowers/specs/2026-08-14-common-free-design.md`

## Global Constraints

- `xu-shu-xitong/` is read-only.
- Credentials come from the request or environment at runtime. No credential literal in source.
- Server binds `127.0.0.1` only.
- A missing semester import returns `missingImport: true` and 42 cells with `level: "MANY_BUSY"` and `busyCount: 0`. The UI must not draw those cells as free.
- Slot codes stay `0102,0304,0506,0708,0910,1112`. Day is 1–7.
- `jszc` is a job title, never a program.
- Re-sync replaces occupancies and college links for that semester, and does not touch `teacher_programs` or preset groups.
- Every error response is `{ error: { code, message, details? } }`.

## Review Focus

- A teacher in two colleges must keep both links; a later college must not delete the earlier one.
- A selected teacher absent from the synced semester is listed in `absentTeachers` and is not treated as free all week.
- Week text that cannot be parsed occupies weeks 1–30, not zero weeks.
- `kbjcmsid` with several unselected options fails the sync; it is never replaced with `0102`.
- Pasted program text with an unknown name reports that name and still saves the matched lines.

---

### Task 1: Workspace and contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `server/src/contract.ts`
- Test: `server/test/contract.test.ts`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-08-14-common-free-api.ts`
- Produces: the same types compiled from `server/src/contract.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { SLOT_CODES } from '../src/contract'
test('slot codes match the probed table', () => {
  expect(SLOT_CODES).toEqual(['0102', '0304', '0506', '0708', '0910', '1112'])
})
```

- [ ] **Step 2: Run `npm test -- contract` and confirm it fails because the module is missing**

- [ ] **Step 3: Add the workspace, copy the contract types into `server/src/contract.ts`, and export `SLOT_CODES`**

- [ ] **Step 4: Run the test and confirm it passes**

- [ ] **Step 5: Commit `chore: add common-free workspace and contract`**

### Task 2: SQLite schema

**Files:**
- Create: `server/src/db.ts`
- Test: `server/test/db.test.ts`

**Interfaces:**
- Consumes: table list in the spec
- Produces: `openDatabase(file: string): Database`

- [ ] **Step 1: Write a test that opens a temp file and asserts the nine tables exist**

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Create the tables from the spec, with the named primary keys and the occupancy index**

- [ ] **Step 4: Run the test and confirm it passes**

- [ ] **Step 5: Commit `feat: add sqlite schema`**

### Task 3: Table parser

**Files:**
- Create: `server/src/jw/parseTable.ts`
- Test: `server/test/parseTable.test.ts`
- Fixture: copy `probe/out/kbtable-one-college.html` to `server/test/fixtures/one-college.html`

**Interfaces:**
- Produces: `parseTeacherTable(html: string): { name: string; cells: { dayOfWeek: number; slotCode: string; weekStart: number; weekEnd: number; occupancyText: string }[] }[]`

- [ ] **Step 1: Assert the fixture parses to 59 teachers and the first name is `梁欢`**

- [ ] **Step 2: Add a fixture cell containing `(2-13周)` and assert weeks 2 through 13**

- [ ] **Step 3: Add a fixture cell with no week text and assert weeks 1 through 30**

- [ ] **Step 4: Run the tests, confirm failure, then port the old `KbtableParser` rules without the mapping filter**

- [ ] **Step 5: Confirm pass and commit `feat: parse teacher table html`**

### Task 4: Password cipher and page parser

**Files:**
- Create: `server/src/jw/cipher.ts`, `server/src/jw/page.ts`
- Test: `server/test/cipher.test.ts`, `server/test/page.test.ts`
- Fixture: `probe/out/kbxx-teacher.html` copied to `server/test/fixtures/teacher-page.html`

**Interfaces:**
- Produces: `encryptPassword(password: string, salt: string, random?: (length: number) => string): string`
- Produces: `parseTeacherPage(html: string): { semesters: {code: string; label: string; isCurrent: boolean}[]; kbjcmsid: string; colleges: {code: string; name: string; shortCode: string | null}[] }`

- [ ] **Step 1: Test cipher against a fixed random function and a known AES-128-CBC vector from the old alphabet**

- [ ] **Step 2: Test the fixture page has 13 colleges, `kbjcmsid` `947A14DB0EE37B4EE0530100007FD241`, and current semester `2026-2027-1`**

- [ ] **Step 3: Test two unselected `kbjcmsid` options throw `KBJCMSID_AMBIGUOUS`**

- [ ] **Step 4: Implement, confirm pass, commit `feat: port login cipher and page selects`**

`shortCode` is the `[0012]` prefix. The four preparatory colleges keep their short values as `code`.

### Task 5: Catalog and common-free query

**Files:**
- Create: `server/src/catalog.ts`, `server/src/commonFree.ts`
- Test: `server/test/commonFree.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `CommonFreeQuery`, `CommonFreeResult`
- Produces: `queryCommonFree(db, input): CommonFreeResult`, `replaceSemester(db, import): void`, `importPrograms(db, text: string)`, `searchTeachers(db, query)`

- [ ] **Step 1: Test two teachers both free at Monday `0102` returns `FREE` and `busyCount: 0`**

- [ ] **Step 2: Test one of two teachers busy returns `ONE_BUSY`**

- [ ] **Step 3: Test two busy returns `MANY_BUSY`**

- [ ] **Step 4: Test a selected name with no occupancy rows and no teacher-semester presence returns in `absentTeachers`**

- [ ] **Step 5: Test no batch for the semester returns `missingImport: true`**

- [ ] **Step 6: Test pasted lines `张三,智能制造学院,软件技术` and `不存在,智能制造学院,软件技术` save one program and report the unknown name**

- [ ] **Step 7: Implement presence with a `semester_teachers(semester_code, teacher_name, college_code)` table added in this task. A teacher with zero cells is present, not absent**

- [ ] **Step 8: Confirm pass and commit `feat: add common-free query and program paste`**

### Task 6: HTTP API

**Files:**
- Create: `server/src/app.ts`, `server/src/index.ts`
- Test: `server/test/api.test.ts`

**Interfaces:**
- Consumes: Task 5 functions and the contract
- Produces: routes named by `CommonFreeApi`, except sync routes, which Task 7 adds

- [ ] **Step 1: Test `GET /api/teachers?q=` paginates and matches initials**

- [ ] **Step 2: Test `PUT /api/settings` with `week1Monday` null returns `currentWeek: 1`**

- [ ] **Step 3: Test a date four weeks after `week1Monday` returns `currentWeek: 5`**

- [ ] **Step 4: Test `POST /api/preset-groups` then `DELETE`**

- [ ] **Step 5: Test `POST /api/common-free` with an empty teacher list returns 422 `VALIDATION_ERROR`**

- [ ] **Step 6: Implement the non-sync routes on `127.0.0.1`, confirm pass, commit `feat: expose catalog and query api`**

### Task 7: Sync job

**Files:**
- Create: `server/src/jw/client.ts`, `server/src/sync.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/sync.test.ts`

**Interfaces:**
- Consumes: cipher, page parser, table parser, `replaceSemester`
- Produces: `startSync(input): SyncState`, `submitSlider(jobId, input): SyncState`, `getSync(jobId): SyncProgress`

- [ ] **Step 1: Test a fake client with two colleges stores both links for a teacher who appears in both**

- [ ] **Step 2: Test a second sync of the same semester replaces occupancies but keeps a pasted program**

- [ ] **Step 3: Test captcha-required stops in `NEED_SLIDER` and does not call the table endpoint**

- [ ] **Step 4: Test one college failure is listed in `failedColleges` while the other college is kept**

- [ ] **Step 5: Implement the job against an injected client. The live client follows the probed login chain and posts `skyx` once per college. Do not post the empty college**

- [ ] **Step 6: Confirm pass and commit `feat: sync timetables by college`**

The live login is not part of the unit test. `probe/jw-probe.mjs` remains the manual check.

### Task 8: Single-screen UI

**Files:**
- Create: `web/` Vite Vue app, `web/src/App.vue`, `web/src/components/Omnibar.vue`, `web/src/components/Matrix.vue`, `web/src/components/CellDrawer.vue`, `web/src/components/SyncCard.vue`, `web/src/components/PickerDrawer.vue`
- Test: `web/src/view.test.ts`

**Interfaces:**
- Consumes: the contract's response types
- Produces: no new API

- [ ] **Step 1: Test the view model: 0 busy is green `全员空闲`, 1 is yellow `仅 1 人忙碌`, 2 or more is red `多人冲突`**

- [ ] **Step 2: Test `missingImport` produces the dialog copy `这个学期还没有课表` and no matrix**

- [ ] **Step 3: Test a name query and an initials query both select the same teacher**

- [ ] **Step 4: Build the single screen: omnibar, three count capsules, 7×6 matrix, right drawer, non-blocking sync card, picker drawer with the paste box**

- [ ] **Step 5: Confirm the view test passes and commit `feat: add single-screen common-free ui`**

Keyboard: Up/Down moves across cells, Enter opens the drawer, Esc closes it.

### Task 9: Review gate

- [ ] **Step 1: Run server tests and the web view test**

- [ ] **Step 2: Ask `@reviewer` to read the diff against this plan and the spec**

- [ ] **Step 3: Fix only the defects the review names, then commit `fix: address common-free review`**

## Self-review notes

- Spec coverage: probe findings are fixed by Tasks 4 and 7; paste, presets, conflict capsules, matrix drawer, and week-1 setting are Tasks 5, 6, and 8.
- `semester_teachers` is added in Task 5 because presence cannot be inferred from occupancy rows.
- Excel export, automatic slider solving, and accounts are absent on purpose.
