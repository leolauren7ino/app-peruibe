import { HANDLED, HttpError, int, str } from '../http.js';
import { needAdmin } from '../guards.js';
import { now, tx } from '../db.js';
import {
  addParticipant, assignmentsOfGame, assignmentView, computeStats, currentGame, drawAllMissions, drawDouble, fillNewcomer,
  label, logEvent, missionPoints, participantsOf, publicRanking, removeParticipant, requireGame, revealPassword, sanitizeName,
  setPassword, startGame, swapAssignment,
} from '../game.js';
import { removeEvidence, sendEvidence } from '../evidence.js';

export const CATEGORIES = ['infiltracao', 'social', 'foto', 'humor', 'bebida', 'investigacao', 'atuacao', 'viagem'];

function cleanMission(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('title')) out.title = str(b.title, 'Nome do desafio', { max: 80 });
  if (!partial || has('description')) out.description = str(b.description, 'Descrição', { max: 800 });
  if (!partial || has('points') || has('level')) {
    // aceita o formato antigo (level) para listas importadas da 1ª versão
    const raw = b.points ?? (b.level === 'dificil' ? 3 : b.level === 'medio' ? 2 : 2);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpError(400, 'Pontos deve ser um inteiro de 1 a 100 (ex.: 1, 2, 3, 5).');
    out.points = n;
  }
  if (!partial || has('category')) {
    const c = b.category || 'social';
    if (!CATEGORIES.includes(c)) throw new HttpError(400, `Categoria inválida (${CATEGORIES.join(', ')}).`);
    out.category = c;
  }
  if (!partial || has('target')) out.target = str(b.target, 'Alvo', { max: 60, required: false }) || null;
  if (!partial || has('romantic')) out.romantic = b.romantic ? 1 : 0;
  if (has('active')) out.active = b.active ? 1 : 0;
  return out;
}

export function adminRoutes(router, app) {
  const { db, cfg, key } = app;
  const admin = (path, method, fn) => router.add(method, path, (ctx) => { needAdmin(ctx); return fn(ctx); });
  const game = () => requireGame(db);
  const person = (gameId, id) => {
    const p = db.prepare('SELECT * FROM participants WHERE id = ? AND game_id = ?').get(id, gameId);
    if (!p) throw new HttpError(404, 'Agente não encontrado.');
    return p;
  };
  const gameInfo = (g) => ({
    id: g.id, name: g.name, status: g.status, unlockedDay: g.unlocked_day, doubleEnabled: !!g.double_enabled,
    startDate: g.start_date, autoConfirm: !!g.auto_confirm, startedAt: g.started_at, finishedAt: g.finished_at,
    missionsDrawnAt: g.missions_drawn_at, doubleDrawnAt: g.double_drawn_at,
  });

  admin('/api/admin/overview', 'GET', () => {
    const g = currentGame(db);
    if (!g) return { game: null };
    const people = participantsOf(db, g.id);
    const rows = assignmentsOfGame(db, g.id);
    const stats = computeStats(db, g);
    const participants = people.map((p) => ({
      id: p.id, name: p.name, nickname: p.nickname, alias: p.alias, restrictedRomantic: !!p.restricted_romantic,
      password: revealPassword(key, p),
      isDouble: !!g.double_enabled && g.double_agent_id === p.id,
      stats: stats.find((s) => s.id === p.id),
      missions: rows.filter((r) => r.participant_id === p.id).map((r) => ({
        ...assignmentView(r, g, { real: true }), missionId: r.mission_id, targetLabel: r.target_label || r.target_name, romantic: !!r.romantic,
      })),
    }));
    const double = g.double_enabled ? people.find((p) => p.id === g.double_agent_id) : null;
    const flagrantes = db.prepare("SELECT * FROM flagrantes WHERE game_id = ? AND status = 'pendente' ORDER BY id").all(g.id).map((f) => ({
      id: f.id, guess: f.guess, createdAt: f.created_at,
      accuserId: f.accuser_id, accuserName: people.find((p) => p.id === f.accuser_id)?.name,
      accusedId: f.accused_id, accusedName: people.find((p) => p.id === f.accused_id)?.name,
      candidates: participants.find((p) => p.id === f.accused_id)?.missions.filter((m) => ['pendente', 'analise'].includes(m.status)) || [],
    }));
    return {
      flagrantes,
      adjustments: db.prepare('SELECT a.*, p.name FROM adjustments a JOIN participants p ON p.id = a.participant_id WHERE a.game_id = ? ORDER BY a.id DESC LIMIT 50').all(g.id),
      game: gameInfo(g),
      doubleAgent: double ? { id: double.id, name: double.name } : null,
      participants,
      pending: participants.flatMap((p) => p.missions.filter((m) => m.status === 'analise')
        .map((m) => ({ ...m, participantId: p.id, participantName: p.name })))
        .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt))),
      ranking: publicRanking(db, g),
    };
  });

  // ---- partida ------------------------------------------------------------------
  admin('/api/admin/games', 'POST', async (ctx) => {
    const name = str(ctx.body.name, 'Nome da partida', { max: 60 });
    const prev = currentGame(db);
    const id = tx(db, () => {
      if (prev && prev.status !== 'finished') db.prepare("UPDATE games SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), prev.id);
      const r = db.prepare('INSERT INTO games (name, auto_confirm, double_enabled, start_date, created_at) VALUES (?,?,?,?,?)')
        .run(name, prev?.auto_confirm ?? 0, prev?.double_enabled ?? 0, ctx.body.startDate || null, now());
      const gid = Number(r.lastInsertRowid);
      if (prev && ctx.body.copyParticipants) {
        const ins = db.prepare(`INSERT INTO participants (game_id, name, nickname, pw_hash, pw_enc, restricted_romantic, created_at)
                                SELECT ?, name, nickname, pw_hash, pw_enc, restricted_romantic, ? FROM participants WHERE game_id = ? ORDER BY id`);
        ins.run(gid, now(), prev.id);
      }
      return gid;
    });
    db.prepare('DELETE FROM sessions WHERE kind = ?').run('player');
    return { id };
  });

  admin('/api/admin/game', 'PATCH', (ctx) => {
    const g = game();
    const b = ctx.body;
    if (b.doubleEnabled !== undefined && !!b.doubleEnabled !== !!g.double_enabled && g.status !== 'setup') {
      throw new HttpError(409, 'O Agente Duplo só pode ser ligado ou desligado antes de iniciar a operação.');
    }
    let start = g.start_date;
    if (b.startDate !== undefined) {
      start = b.startDate ? String(b.startDate) : null;
      if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new HttpError(400, 'Data inválida (use AAAA-MM-DD).');
    }
    const double = b.doubleEnabled !== undefined ? (b.doubleEnabled ? 1 : 0) : g.double_enabled;
    db.prepare('UPDATE games SET name = ?, auto_confirm = ?, double_enabled = ?, double_agent_id = ?, start_date = ? WHERE id = ?').run(
      b.name !== undefined ? str(b.name, 'Nome', { max: 60 }) : g.name,
      b.autoConfirm !== undefined ? (b.autoConfirm ? 1 : 0) : g.auto_confirm,
      double, double ? g.double_agent_id : null, start, g.id,
    );
    return { ok: true };
  });

  // Flagrante aceito: o desafio descoberto é perdido pelo dono e quem descobriu ganha 1 ponto.
  admin('/api/admin/flagrantes/:id/accept', 'POST', (ctx) => {
    const g = game();
    const f = db.prepare("SELECT * FROM flagrantes WHERE id = ? AND game_id = ? AND status = 'pendente'").get(int(ctx.params.id), g.id);
    if (!f) throw new HttpError(404, 'Flagrante não encontrado.');
    const a = assignment(g, int(ctx.body.assignmentId, 'assignmentId'));
    if (a.participant_id !== f.accused_id) throw new HttpError(400, 'Esse desafio não é do acusado.');
    if (!['pendente', 'analise'].includes(a.status)) throw new HttpError(409, 'Esse desafio já foi concluído ou encerrado.');
    tx(db, () => {
      removeEvidence(cfg, a.evidence_file);
      db.prepare("UPDATE assignments SET status = 'flagrante', evidence_file = NULL, submitted_at = NULL, points_awarded = 0 WHERE id = ?").run(a.id);
      db.prepare("UPDATE flagrantes SET status = 'aceito' WHERE id = ?").run(f.id);
      db.prepare('INSERT INTO adjustments (game_id, participant_id, points, reason, created_at) VALUES (?,?,?,?,?)')
        .run(g.id, f.accuser_id, 1, `Flagrante: ${a.title}`, now());
      logEvent(db, g, { type: 'flagrante', participant: db.prepare('SELECT * FROM participants WHERE id = ?').get(f.accuser_id), assignmentId: a.id, missionTitle: a.title, points: 1 });
    });
    return { ok: true };
  });

  admin('/api/admin/flagrantes/:id/reject', 'POST', (ctx) => {
    const g = game();
    const r = db.prepare("UPDATE flagrantes SET status = 'recusado' WHERE id = ? AND game_id = ? AND status = 'pendente'").run(int(ctx.params.id), g.id);
    if (!r.changes) throw new HttpError(404, 'Flagrante não encontrado.');
    return { ok: true };
  });

  // Ajuste manual de pontos (ex.: fuga sem ficha de passe = -1).
  admin('/api/admin/participants/:id/adjust', 'POST', (ctx) => {
    const g = game();
    const p = person(g.id, int(ctx.params.id));
    const pts = Number(ctx.body.points);
    if (!Number.isInteger(pts) || pts === 0 || Math.abs(pts) > 20) throw new HttpError(400, 'Pontos deve ser um inteiro entre -20 e 20 (diferente de 0).');
    const reason = str(ctx.body.reason, 'Motivo', { max: 120 });
    db.prepare('INSERT INTO adjustments (game_id, participant_id, points, reason, created_at) VALUES (?,?,?,?,?)').run(g.id, p.id, pts, reason, now());
    logEvent(db, g, { type: 'ajuste', participant: p, points: pts, detail: reason });
    return { ok: true };
  });

  admin('/api/admin/draw/double', 'POST', () => { const p = drawDouble(db, game()); return { id: p.id, name: p.name }; });
  admin('/api/admin/draw/missions', 'POST', () => ({ count: drawAllMissions(db, cfg.dataDir, game()) }));
  admin('/api/admin/draw/all', 'POST', () => {
    const g = game();
    const p = g.double_enabled ? drawDouble(db, g) : null;
    return { double: p?.name ?? null, count: drawAllMissions(db, cfg.dataDir, g) };
  });
  admin('/api/admin/start', 'POST', () => { startGame(db, game()); return { ok: true }; });
  admin('/api/admin/finish', 'POST', () => {
    const g = game();
    if (g.status === 'finished') throw new HttpError(409, 'A partida já foi encerrada.');
    db.prepare("UPDATE games SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), g.id);
    logEvent(db, g, { type: 'encerrada' });
    return { ok: true };
  });

  // ---- agentes ---------------------------------------------------------------------
  admin('/api/admin/participants', 'POST', async (ctx) => {
    const g = game();
    if (g.status === 'finished') throw new HttpError(409, 'A partida foi encerrada.');
    const id = await addParticipant(db, key, g, {
      name: ctx.body.name, nickname: str(ctx.body.nickname, 'Apelido', { max: 40, required: false }), alias: str(ctx.body.alias, 'Nome oculto', { max: 30, required: false }),
      restrictedRomantic: !!ctx.body.restrictedRomantic, password: ctx.body.password || null,
    });
    // Em operação em andamento, o novo agente recebe suas 3 missões na hora; os demais não mudam.
    if (g.status === 'active') {
      try { fillNewcomer(db, g, id); } catch (e) {
        db.prepare('DELETE FROM participants WHERE id = ?').run(id);
        throw e;
      }
    }
    return { id, password: revealPassword(key, db.prepare('SELECT * FROM participants WHERE id = ?').get(id)) };
  });

  admin('/api/admin/participants/:id', 'PATCH', async (ctx) => {
    const g = game();
    const p = person(g.id, int(ctx.params.id));
    const b = ctx.body;
    const name = b.name !== undefined ? sanitizeName(b.name) : p.name;
    const restricted = b.restrictedRomantic !== undefined ? (b.restrictedRomantic ? 1 : 0) : p.restricted_romantic;
    try {
      db.prepare('UPDATE participants SET name = ?, nickname = ?, alias = ?, restricted_romantic = ? WHERE id = ?').run(
        name, b.nickname !== undefined ? str(b.nickname, 'Apelido', { max: 40, required: false }) || null : p.nickname,
        b.alias !== undefined ? str(b.alias, 'Nome oculto', { max: 30, required: false }) || null : p.alias, restricted, p.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um agente com esse nome.');
      throw e;
    }
    let password;
    if (b.regeneratePassword || b.password) password = await setPassword(db, key, p.id, b.password || null);
    if (restricted && !p.restricted_romantic) {
      // passou a ter restrição: troca missões românticas que ainda não foram concluídas
      for (const r of assignmentsOfGame(db, g.id).filter((x) => x.participant_id === p.id && x.romantic && x.status !== 'concluida')) {
        swapAssignment(db, cfg.dataDir, g, r.id);
      }
    }
    return { ok: true, password };
  });

  admin('/api/admin/participants/:id', 'DELETE', (ctx) => {
    const g = game();
    removeParticipant(db, cfg.dataDir, g, person(g.id, int(ctx.params.id)));
    return { ok: true };
  });

  // ---- missões da partida ----------------------------------------------------------------
  const assignment = (g, id) => {
    const a = db.prepare('SELECT a.*, m.title, m.points FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ? AND a.game_id = ?').get(id, g.id);
    if (!a) throw new HttpError(404, 'Missão não encontrada.');
    return a;
  };
  const owner = (a) => db.prepare('SELECT * FROM participants WHERE id = ?').get(a.participant_id);

  admin('/api/admin/assignments/:id/confirm', 'POST', (ctx) => {
    const g = game();
    const a = assignment(g, int(ctx.params.id));
    if (a.status === 'concluida') throw new HttpError(409, 'Missão já concluída.');
    if (['flagrante', 'passe'].includes(a.status)) throw new HttpError(409, 'Desafio encerrado (passe ou flagrante). Resete antes para reabrir.');
    const pts = missionPoints(a);
    db.prepare("UPDATE assignments SET status = 'concluida', confirmed_at = ?, points_awarded = ?, review_message = NULL WHERE id = ?").run(now(), pts, a.id);
    logEvent(db, g, { type: 'confirmada', participant: owner(a), assignmentId: a.id, missionTitle: a.title, points: pts });
    return { ok: true };
  });

  admin('/api/admin/assignments/:id/reject', 'POST', (ctx) => {
    const g = game();
    const a = assignment(g, int(ctx.params.id));
    if (a.status !== 'analise') throw new HttpError(409, 'Só missões em análise podem ser devolvidas.');
    const msg = str(ctx.body.message, 'Mensagem', { max: 200, required: false }) || 'Evidência não aceita. Tente de novo.';
    removeEvidence(cfg, a.evidence_file);
    db.prepare("UPDATE assignments SET status = 'pendente', submitted_at = NULL, evidence_file = NULL, review_message = ? WHERE id = ?").run(msg, a.id);
    logEvent(db, g, { type: 'devolvida', participant: owner(a), assignmentId: a.id, missionTitle: a.title, detail: msg });
    return { ok: true };
  });

  admin('/api/admin/assignments/:id/reset', 'POST', (ctx) => {
    const g = game();
    const a = assignment(g, int(ctx.params.id));
    removeEvidence(cfg, a.evidence_file);
    db.prepare(`UPDATE assignments SET status = 'pendente', submitted_at = NULL, confirmed_at = NULL, note = NULL,
                evidence_file = NULL, points_awarded = NULL, review_message = NULL WHERE id = ?`).run(a.id);
    logEvent(db, g, { type: 'resetada', participant: owner(a), assignmentId: a.id, missionTitle: a.title });
    return { ok: true };
  });

  admin('/api/admin/assignments/:id/swap', 'POST', (ctx) => {
    const g = game();
    const a = assignment(g, int(ctx.params.id));
    swapAssignment(db, cfg.dataDir, g, a.id, ctx.body.missionId ? int(ctx.body.missionId, 'missionId') : null);
    return { ok: true };
  });

  admin('/api/admin/assignments/:id/evidence', 'GET', (ctx) => {
    const a = db.prepare('SELECT evidence_file FROM assignments WHERE id = ?').get(int(ctx.params.id));
    if (!a?.evidence_file) throw new HttpError(404, 'Foto não encontrada.');
    sendEvidence(cfg, ctx.res, a.evidence_file);
    return HANDLED;
  });

  admin('/api/admin/events', 'GET', () => {
    const g = currentGame(db);
    return { events: g ? db.prepare('SELECT * FROM events WHERE game_id = ? ORDER BY id DESC LIMIT 300').all(g.id) : [] };
  });

  // ---- catálogo de missões -----------------------------------------------------------------------
  admin('/api/admin/missions', 'GET', () => {
    const g = currentGame(db);
    const used = new Map();
    if (g) {
      for (const r of db.prepare('SELECT a.mission_id, p.name FROM assignments a JOIN participants p ON p.id = a.participant_id WHERE a.game_id = ?').all(g.id)) {
        used.set(r.mission_id, r.name);
      }
    }
    return {
      categories: CATEGORIES,
      missions: db.prepare('SELECT * FROM missions ORDER BY points, id').all()
        .map((m) => ({ ...m, romantic: !!m.romantic, active: !!m.active, usedBy: used.get(m.id) || null })),
    };
  });

  const insertMission = db.prepare(`INSERT INTO missions (title, description, points, category, target, romantic, active, created_at)
                                    VALUES (@title, @description, @points, @category, @target, @romantic, @active, @created_at)`);
  admin('/api/admin/missions', 'POST', (ctx) => {
    const m = cleanMission(ctx.body);
    const r = insertMission.run({ active: 1, ...m, created_at: now() });
    return { id: Number(r.lastInsertRowid) };
  });

  admin('/api/admin/missions/import', 'POST', (ctx) => {
    const list = ctx.body.missions;
    if (!Array.isArray(list) || !list.length || list.length > 300) throw new HttpError(400, 'Envie "missions": uma lista com até 300 itens.');
    const cleaned = list.map((m, i) => {
      try { return cleanMission(m); } catch (e) { throw new HttpError(400, `Item ${i + 1}: ${e.message}`); }
    });
    tx(db, () => cleaned.forEach((m) => insertMission.run({ active: 1, ...m, created_at: now() })));
    return { count: cleaned.length };
  });

  admin('/api/admin/missions/:id', 'PATCH', (ctx) => {
    const id = int(ctx.params.id);
    if (!db.prepare('SELECT 1 FROM missions WHERE id = ?').get(id)) throw new HttpError(404, 'Missão não encontrada.');
    const m = cleanMission(ctx.body, { partial: true });
    const cols = Object.keys(m);
    if (cols.length) db.prepare(`UPDATE missions SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...m, id });
    return { ok: true };
  });

  admin('/api/admin/missions/:id', 'DELETE', (ctx) => {
    const id = int(ctx.params.id);
    if (db.prepare('SELECT 1 FROM assignments WHERE mission_id = ?').get(id)) {
      db.prepare('UPDATE missions SET active = 0 WHERE id = ?').run(id);
      return { deactivated: true }; // já foi usada em alguma partida: preserva o histórico
    }
    db.prepare('DELETE FROM missions WHERE id = ?').run(id);
    return { deleted: true };
  });
}
