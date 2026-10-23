import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','active','finished')),
  double_agent_id INTEGER,
  missions_drawn_at TEXT,
  double_drawn_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  points_medio INTEGER NOT NULL DEFAULT 100,
  points_dificil INTEGER NOT NULL DEFAULT 200,
  auto_confirm INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  nickname TEXT,
  pw_hash TEXT NOT NULL,
  pw_enc TEXT NOT NULL,
  restricted_romantic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, name)
);

-- Catálogo global de missões (reaproveitado entre partidas).
CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('medio','dificil')),
  category TEXT NOT NULL DEFAULT 'social',
  target TEXT,
  romantic INTEGER NOT NULL DEFAULT 0,
  effort INTEGER NOT NULL DEFAULT 2,
  points INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  mission_id INTEGER NOT NULL REFERENCES missions(id),
  target_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  target_name TEXT,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','analise','concluida')),
  submitted_at TEXT,
  confirmed_at TEXT,
  note TEXT,
  evidence_file TEXT,
  review_message TEXT,
  points_awarded INTEGER,
  UNIQUE (game_id, mission_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_participant ON assignments(participant_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  participant_id INTEGER,
  participant_name TEXT,
  assignment_id INTEGER,
  mission_title TEXT,
  points INTEGER,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('admin','player')),
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();
