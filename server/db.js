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
  unlocked_day INTEGER NOT NULL DEFAULT 0,
  double_enabled INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  nickname TEXT,
  alias TEXT,
  pw_hash TEXT NOT NULL,
  pw_enc TEXT NOT NULL,
  restricted_romantic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, name)
);

-- Catálogo global de desafios (reaproveitado entre partidas). "points" é a pontuação do desafio (1, 2, 3, 5...).
CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 2,
  category TEXT NOT NULL DEFAULT 'social',
  target TEXT,
  romantic INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- position = dia do desafio (1 = sexta, 2 = sábado, 3 = domingo)
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  mission_id INTEGER NOT NULL REFERENCES missions(id),
  target_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  target_name TEXT,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','analise','concluida','flagrante','passe')),
  submitted_at TEXT,
  confirmed_at TEXT,
  note TEXT,
  evidence_file TEXT,
  review_message TEXT,
  points_awarded INTEGER,
  UNIQUE (game_id, mission_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_participant ON assignments(participant_id);

-- Ajustes manuais de pontos: flagrante (+1), fuga (-1), correções.
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Denúncias de flagrante feitas pelos agentes, julgadas pelo organizador.
CREATE TABLE IF NOT EXISTS flagrantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  accuser_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  accused_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  guess TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aceito','recusado')),
  created_at TEXT NOT NULL
);

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

-- Avisos em destaque para todos os agentes (ex.: o "Clássico"). left/right = lados do confronto.
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'versus',
  title TEXT NOT NULL,
  subtitle TEXT,
  body TEXT,
  left_name TEXT,
  right_name TEXT,
  left_image TEXT,
  right_image TEXT,
  winner TEXT CHECK (winner IN ('left','right')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('admin','player')),
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** Bancos da 1ª versão (níveis médio/difícil) ganham o modelo novo preservando agentes e senhas. */
function migrate(db) {
  for (const [col, ddl] of [['unlocked_day', 'INTEGER NOT NULL DEFAULT 0'], ['double_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['start_date', 'TEXT']]) {
    if (!columns(db, 'games').includes(col)) db.exec(`ALTER TABLE games ADD COLUMN ${col} ${ddl}`);
  }
  if (!columns(db, 'participants').includes('alias')) db.exec('ALTER TABLE participants ADD COLUMN alias TEXT');
  if (!columns(db, 'missions').includes('level')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE missions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 2,
      category TEXT NOT NULL DEFAULT 'social', target TEXT, romantic INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
    db.exec(`INSERT INTO missions_new (id, title, description, points, category, target, romantic, active, created_at)
             SELECT id, title, description, CASE level WHEN 'dificil' THEN 3 ELSE 2 END, category, target, romantic, active, created_at FROM missions`);
    db.exec('DROP TABLE missions');
    db.exec('ALTER TABLE missions_new RENAME TO missions');
    db.exec(`CREATE TABLE assignments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE, mission_id INTEGER NOT NULL REFERENCES missions(id),
      target_id INTEGER REFERENCES participants(id) ON DELETE SET NULL, target_name TEXT, position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','analise','concluida','flagrante','passe')),
      submitted_at TEXT, confirmed_at TEXT, note TEXT, evidence_file TEXT, review_message TEXT, points_awarded INTEGER,
      UNIQUE (game_id, mission_id))`);
    db.exec(`INSERT INTO assignments_new SELECT id, game_id, participant_id, mission_id, target_id, target_name, position, status, submitted_at,
             confirmed_at, note, evidence_file, review_message, points_awarded FROM assignments`);
    db.exec('DROP TABLE assignments');
    db.exec('ALTER TABLE assignments_new RENAME TO assignments');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assign_participant ON assignments(participant_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Em bancos antigos, as tabelas antigas precisam ser migradas ANTES de o schema novo criar índices/tabelas.
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'").get();
  if (old) migrate(db);
  db.exec(SCHEMA);
  migrate(db);
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
