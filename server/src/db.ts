import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS colleges (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT
);

CREATE TABLE IF NOT EXISTS semesters (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  is_current INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teachers (
  name TEXT PRIMARY KEY,
  pinyin_initials TEXT NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teacher_colleges (
  teacher_name TEXT NOT NULL,
  college_code TEXT NOT NULL,
  PRIMARY KEY (teacher_name, college_code),
  FOREIGN KEY (teacher_name) REFERENCES teachers(name),
  FOREIGN KEY (college_code) REFERENCES colleges(code)
);

CREATE TABLE IF NOT EXISTS teacher_programs (
  teacher_name TEXT PRIMARY KEY,
  program_name TEXT NOT NULL,
  FOREIGN KEY (teacher_name) REFERENCES teachers(name)
);

CREATE TABLE IF NOT EXISTS occupancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_code TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  slot_code TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  week_end INTEGER NOT NULL,
  occupancy_text TEXT NOT NULL,
  FOREIGN KEY (semester_code) REFERENCES semesters(code),
  FOREIGN KEY (teacher_name) REFERENCES teachers(name)
);

CREATE INDEX IF NOT EXISTS occupancies_semester_teacher
  ON occupancies (semester_code, teacher_name);

CREATE TABLE IF NOT EXISTS preset_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_group_members (
  group_id TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  PRIMARY KEY (group_id, teacher_name),
  FOREIGN KEY (group_id) REFERENCES preset_groups(id),
  FOREIGN KEY (teacher_name) REFERENCES teachers(name)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semester_teachers (
  semester_code TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  college_code TEXT NOT NULL,
  PRIMARY KEY (semester_code, teacher_name, college_code),
  FOREIGN KEY (semester_code) REFERENCES semesters(code),
  FOREIGN KEY (teacher_name) REFERENCES teachers(name),
  FOREIGN KEY (college_code) REFERENCES colleges(code)
);
`

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  return db
}
