import fs from 'node:fs';
import path from 'node:path';
import { tx, now } from './db.js';
import { normalize, encrypt, decrypt, hashPassword, generatePassword, normalizePassword } from './security.js';
import { drawMissions, pickTarget, shuffle, dayAllowed, DrawError } from './draw.js';
import { HttpError } from './http.js';

/** Até que dia os desafios estão liberados para os agentes (tudo aberto depois do encerramento). */
export const visibleDay = (game) => (game.status === 'finished' ? 3 : game.status === 'active' ? game.unlocked_day : 0);

export const currentGame = (db) => db.prepare('SELECT * FROM games ORDER BY id DESC LIMIT 1').get() || null;

export function requireGame(db) {
  const g = currentGame(db);
  if (!g) throw new HttpError(409, 'Nenhuma partida criada.');
  return g;
}

export const participantsOf = (db, gameId) =>
  db.prepare('SELECT * FROM participants WHERE game_id = ? ORDER BY id').all(gameId);

export const label = (p) => (p ? (p.nickname ? `${p.name} (${p.nickname})` : p.name) : null);

export const missionPoints = (m) => m.points;

export const LOST = ['flagrante', 'passe'];
export const PASSES_PER_AGENT = 2;
export const TARGET_TOKEN = /\[ALVO\]|\{alvo\}/gi;

export function logEvent(db, game, { type, participant = null, assignmentId = null, missionTitle = null, points = null, detail = null }) {
  db.prepare(`INSERT INTO events (game_id, ts, type, participant_id, participant_name, assignment_id, mission_title, points, detail)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(game.id, now(), type, participant?.id ?? null, participant?.name ?? null, assignmentId, missionTitle, points, detail);
}

/** Missão como o dono a enxerga: texto com {alvo} resolvido e pontos calculados. */
export function assignmentView(row, game) {
  const target = row.target_label || row.target_name || 'o alvo';
  return {
    id: row.id,
    number: row.position,
    day: row.position,
    title: row.title,
    description: row.description.replace(TARGET_TOKEN, target),
    category: row.category,
    points: row.points_awarded ?? missionPoints(row),
    status: row.status,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    note: row.note,
    hasEvidence: !!row.evidence_file,
    reviewMessage: row.review_message,
  };
}

const ASSIGN_SQL = `
  SELECT a.*, m.title, m.description, m.category, m.points, m.romantic, m.target AS mission_target,
         CASE WHEN t.id IS NULL THEN NULL
              WHEN t.nickname IS NULL OR t.nickname = '' THEN t.name
              ELSE t.name || ' (' || t.nickname || ')' END AS target_label
  FROM assignments a
  JOIN missions m ON m.id = a.mission_id
  LEFT JOIN participants t ON t.id = a.target_id`;

export const assignmentsOf = (db, participantId) =>
  db.prepare(`${ASSIGN_SQL} WHERE a.participant_id = ? ORDER BY a.position`).all(participantId);

export const assignmentsOfGame = (db, gameId) =>
  db.prepare(`${ASSIGN_SQL} WHERE a.game_id = ? ORDER BY a.participant_id, a.position`).all(gameId);

/** Pontos, concluídas, etc. de todos os participantes — base do ranking e do painel. */
export function computeStats(db, game) {
  const people = participantsOf(db, game.id);
  const rows = assignmentsOfGame(db, game.id);
  const adj = new Map();
  for (const a of db.prepare('SELECT participant_id, SUM(points) AS n FROM adjustments WHERE game_id = ? GROUP BY participant_id').all(game.id)) adj.set(a.participant_id, a.n);
  const stats = people.map((p) => {
    const mine = rows.filter((r) => r.participant_id === p.id);
    const done = mine.filter((r) => r.status === 'concluida');
    const lost = mine.filter((r) => LOST.includes(r.status));
    const passes = mine.filter((r) => r.status === 'passe').length;
    return {
      id: p.id,
      name: p.name,
      nickname: p.nickname,
      points: done.reduce((s, r) => s + (r.points_awarded ?? missionPoints(r)), 0) + (adj.get(p.id) || 0),
      adjustments: adj.get(p.id) || 0,
      done: done.length,
      inReview: mine.filter((r) => r.status === 'analise').length,
      lost: lost.length,
      passesUsed: passes,
      passesLeft: Math.max(0, PASSES_PER_AGENT - passes),
      total: mine.length,
      remaining: mine.length - done.length - lost.length,
      percent: mine.length ? Math.round((done.length / mine.length) * 100) : 0,
      lastDoneAt: done.map((r) => r.confirmed_at).sort().at(-1) || null,
    };
  });
  stats.sort((a, b) => b.points - a.points || b.done - a.done || (a.lastDoneAt || 'z').localeCompare(b.lastDoneAt || 'z') || a.name.localeCompare(b.name));
  let pos = 0;
  stats.forEach((s, i) => {
    const prev = stats[i - 1];
    if (!prev || prev.points !== s.points) pos = i + 1;
    s.position = pos;
  });
  return stats;
}

/** Ranking público: nada que revele papéis, missões ou análises pendentes dos outros. */
export const publicRanking = (db, game) =>
  computeStats(db, game).map(({ position, id, name, nickname, points, done, remaining, lost, total, percent }) =>
    ({ position, id, name, nickname, points, done, remaining, lost, total, percent }));

// ---- participantes -------------------------------------------------------------
export function sanitizeName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Nome é obrigatório.');
  if (name.length > 60) throw new HttpError(400, 'Nome muito longo.');
  if (['admin', 'administrador', 'adm'].includes(normalize(name))) throw new HttpError(400, 'Nome reservado.');
  return name;
}

export async function addParticipant(db, key, game, { name, nickname = '', restrictedRomantic = false, password }) {
  name = sanitizeName(name);
  const plain = password ? normalizePassword(password) : null;
  if (password && plain.length < 4) throw new HttpError(400, 'Senha muito curta (mín. 4 caracteres).');
  const shown = password ? String(password).trim() : generatePassword();
  const hash = await hashPassword(normalizePassword(shown));
  try {
    const r = db.prepare(`INSERT INTO participants (game_id, name, nickname, pw_hash, pw_enc, restricted_romantic, created_at)
                          VALUES (?,?,?,?,?,?,?)`)
      .run(game.id, name, String(nickname).trim() || null, hash, encrypt(key, shown), restrictedRomantic ? 1 : 0, now());
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um agente com esse nome.');
    throw e;
  }
}

export async function setPassword(db, key, participantId, password) {
  const shown = password ? String(password).trim() : generatePassword();
  if (normalizePassword(shown).length < 4) throw new HttpError(400, 'Senha muito curta (mín. 4 caracteres).');
  db.prepare('UPDATE participants SET pw_hash = ?, pw_enc = ? WHERE id = ?')
    .run(await hashPassword(normalizePassword(shown)), encrypt(key, shown), participantId);
  db.prepare('DELETE FROM sessions WHERE participant_id = ?').run(participantId);
  return shown;
}

export const revealPassword = (key, p) => decrypt(key, p.pw_enc);

// ---- catálogo / elegibilidade -----------------------------------------------------
function resolveCatalog(db, people) {
  const byName = new Map();
  for (const p of people) {
    byName.set(normalize(p.name), p.id);
    if (p.nickname) byName.set(normalize(p.nickname), p.id);
  }
  return db.prepare('SELECT * FROM missions WHERE active = 1').all()
    .map((m) => ({
      ...m,
      romantic: !!m.romantic,
      target: !m.target ? null : m.target === '*' ? '*' : (byName.get(normalize(m.target)) ?? 'missing'),
    }))
    .filter((m) => m.target !== 'missing'); // alvo fixo que não está na partida: missão indisponível
}

const targetLoadOf = (db, gameId) => {
  const load = {};
  for (const r of db.prepare('SELECT target_id FROM assignments WHERE game_id = ? AND target_id IS NOT NULL').all(gameId)) {
    load[r.target_id] = (load[r.target_id] || 0) + 1;
  }
  return load;
};

function insertPicks(db, game, people, picks) {
  const name = new Map(people.map((p) => [p.id, label(p)]));
  const stmt = db.prepare(`INSERT INTO assignments (game_id, participant_id, mission_id, target_id, target_name, position)
                           VALUES (?,?,?,?,?,?)`);
  for (const p of picks) stmt.run(game.id, p.participantId, p.missionId, p.targetId, p.targetId ? name.get(p.targetId) : null, p.position);
}

function deleteEvidenceFiles(db, dataDir, where, ...args) {
  for (const r of db.prepare(`SELECT evidence_file FROM assignments WHERE evidence_file IS NOT NULL AND ${where}`).all(...args)) {
    fs.rmSync(path.join(dataDir, 'evidence', r.evidence_file), { force: true });
  }
}

// ---- sorteios ----------------------------------------------------------------------
function assertSetup(game, what) {
  if (game.status !== 'setup') throw new HttpError(409, `O sorteio de ${what} já foi travado: a operação começou.`);
}

export function drawDouble(db, game) {
  assertSetup(game, 'Agente Duplo');
  if (!game.double_enabled) throw new HttpError(409, 'O Agente Duplo está desativado nesta partida.');
  const people = participantsOf(db, game.id);
  if (people.length < 3) throw new HttpError(409, 'São necessários pelo menos 3 agentes.');
  const chosen = shuffle(people)[0];
  db.prepare('UPDATE games SET double_agent_id = ?, double_drawn_at = ? WHERE id = ?').run(chosen.id, now(), game.id);
  logEvent(db, game, { type: 'sorteio_duplo', participant: chosen });
  return chosen;
}

export function drawAllMissions(db, dataDir, game) {
  assertSetup(game, 'missões');
  const people = participantsOf(db, game.id);
  if (people.length < 2) throw new HttpError(409, 'Cadastre pelo menos 2 agentes.');
  try {
    return tx(db, () => {
      deleteEvidenceFiles(db, dataDir, 'game_id = ?', game.id);
      db.prepare('DELETE FROM assignments WHERE game_id = ?').run(game.id);
      const { picks, score } = drawMissions({
        fill: people.map((p) => ({ id: p.id, restricted: !!p.restricted_romantic })),
        everyone: people,
        missions: resolveCatalog(db, people),
      });
      insertPicks(db, game, people, picks);
      db.prepare('UPDATE games SET missions_drawn_at = ? WHERE id = ?').run(now(), game.id);
      logEvent(db, game, { type: 'sorteio_missoes', detail: `score ${score.toFixed(2)}` });
      return picks.length;
    });
  } catch (e) {
    if (e instanceof DrawError) throw new HttpError(409, e.message);
    throw e;
  }
}

/** Sorteia as 3 missões de um agente que entrou depois (sem mexer nos demais). */
export function fillNewcomer(db, game, participantId) {
  const people = participantsOf(db, game.id);
  const me = people.find((p) => p.id === participantId);
  const used = new Set(db.prepare('SELECT mission_id FROM assignments WHERE game_id = ?').all(game.id).map((r) => r.mission_id));
  try {
    const baseTotals = {};
    for (const r of assignmentsOfGame(db, game.id)) baseTotals[r.participant_id] = (baseTotals[r.participant_id] || 0) + r.points;
    const { picks } = drawMissions({
      fill: [{ id: me.id, restricted: !!me.restricted_romantic }],
      everyone: people,
      missions: resolveCatalog(db, people),
      used,
      targetLoad: targetLoadOf(db, game.id),
      baseTotals,
    });
    insertPicks(db, game, people, picks);
    logEvent(db, game, { type: 'missoes_novo_agente', participant: me });
  } catch (e) {
    if (e instanceof DrawError) throw new HttpError(409, e.message);
    throw e;
  }
}

/** Troca o desafio de uma atribuição (a pedido do admin, ou ao reparar alvo removido), mantendo pontuação parecida. */
export function swapAssignment(db, dataDir, game, assignmentId, wantedMissionId = null) {
  const a = db.prepare('SELECT a.*, m.points AS cur_points FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ? AND a.game_id = ?').get(assignmentId, game.id);
  if (!a) throw new HttpError(404, 'Missão não encontrada.');
  const people = participantsOf(db, game.id);
  const me = people.find((p) => p.id === a.participant_id);
  const used = new Set(db.prepare('SELECT mission_id FROM assignments WHERE game_id = ? AND id != ?').all(game.id, a.id).map((r) => r.mission_id));
  const load = targetLoadOf(db, game.id);
  const ok = (m) => !used.has(m.id) && m.id !== a.mission_id && dayAllowed(m, a.position) && !(me.restricted_romantic && m.romantic) && m.target !== me.id;
  const catalog = resolveCatalog(db, people).filter(ok);

  let pool;
  if (wantedMissionId) {
    pool = catalog.filter((m) => m.id === wantedMissionId);
    if (!pool.length) throw new HttpError(409, 'Esse desafio não pode ser atribuído a este agente neste dia.');
  } else {
    const dist = (m) => Math.abs(m.points - a.cur_points);
    const min = Math.min(...catalog.map(dist));
    pool = catalog.filter((m) => dist(m) === min);
  }
  if (!pool.length) throw new HttpError(409, 'Não há desafio disponível no catálogo para a troca.');
  const m = shuffle(pool)[0];
  const tid = pickTarget(m, me, people, load);
  tx(db, () => {
    deleteEvidenceFiles(db, dataDir, 'id = ?', a.id);
    db.prepare(`UPDATE assignments SET mission_id = ?, target_id = ?, target_name = ?, status = 'pendente', submitted_at = NULL,
                confirmed_at = NULL, note = NULL, evidence_file = NULL, review_message = NULL, points_awarded = NULL WHERE id = ?`)
      .run(m.id, tid ?? null, tid ? label(people.find((p) => p.id === tid)) : null, a.id);
    logEvent(db, game, { type: 'troca', participant: me, assignmentId: a.id, missionTitle: m.title });
  });
}

/** Missões cujo alvo foi removido da partida ganham novo conteúdo (se ainda não concluídas). */
export function repairOrphans(db, dataDir, game) {
  const rows = db.prepare(`SELECT a.id, a.status, m.target FROM assignments a JOIN missions m ON m.id = a.mission_id
                           WHERE a.game_id = ? AND a.target_id IS NULL AND m.target IS NOT NULL`).all(game.id);
  for (const r of rows) {
    if (r.status === 'concluida') continue;
    try { swapAssignment(db, dataDir, game, r.id); } catch { /* sem substituta no catálogo: admin troca manualmente */ }
  }
}

export function removeParticipant(db, dataDir, game, p) {
  tx(db, () => {
    deleteEvidenceFiles(db, dataDir, 'participant_id = ?', p.id);
    // Missões concluídas por outros que apontavam para ele mantêm o nome (target_name) no histórico.
    db.prepare('DELETE FROM participants WHERE id = ?').run(p.id);
    if (game.double_agent_id === p.id) db.prepare('UPDATE games SET double_agent_id = NULL, double_drawn_at = NULL WHERE id = ?').run(game.id);
    logEvent(db, game, { type: 'agente_removido', participant: p });
  });
  if (game.status === 'active') repairOrphans(db, dataDir, game);
}

export function startGame(db, game) {
  if (game.status !== 'setup') throw new HttpError(409, 'A operação já foi iniciada.');
  const people = participantsOf(db, game.id);
  if (game.double_enabled && !game.double_agent_id) throw new HttpError(409, 'Sorteie o Agente Duplo antes de iniciar.');
  const counts = db.prepare('SELECT participant_id, COUNT(*) AS n FROM assignments WHERE game_id = ? GROUP BY participant_id').all(game.id);
  const byId = new Map(counts.map((c) => [c.participant_id, c.n]));
  const orphans = db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN missions m ON m.id = a.mission_id
                              WHERE a.game_id = ? AND a.target_id IS NULL AND m.target IS NOT NULL`).get(game.id).n;
  if (!people.length || people.some((p) => byId.get(p.id) !== 3) || orphans) {
    throw new HttpError(409, 'Sorteie as missões novamente: a lista de agentes mudou depois do sorteio.');
  }
  db.prepare("UPDATE games SET status = 'active', started_at = ?, unlocked_day = 1 WHERE id = ?").run(now(), game.id);
  logEvent(db, game, { type: 'inicio' });
}
