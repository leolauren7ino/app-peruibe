import { HANDLED, HttpError, int, str } from '../http.js';
import { needPlayer, needAnyone } from '../guards.js';
import {
  assignmentsOf, assignmentsOfGame, assignmentView, computeStats, logEvent, missionPoints, participantsOf, publicRanking, currentGame,
  visibleDay, LOST, PASSES_PER_AGENT,
} from '../game.js';
import { saveEvidence, removeEvidence, sendEvidence } from '../evidence.js';
import { now } from '../db.js';

export function playerRoutes(router, app) {
  const { db, cfg } = app;

  // O papel de Agente Duplo só existe se a partida o ativou, e só o próprio agente recebe o próprio papel.
  const roleOf = (p, game) => (!game.double_enabled || game.status === 'setup' ? null : game.double_agent_id === p.id ? 'AGENTE_DUPLO' : 'AGENTE_SECRETO');

  /** Missão do dono, desde que o dia dela já esteja liberado (404 igual a "não existe"). */
  const ownAssignment = (p, game, id) => {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND participant_id = ?').get(id, p.id);
    if (!a || a.position > visibleDay(game)) throw new HttpError(404, 'Missão não encontrada.');
    return a;
  };

  router.add('GET', '/api/me', (ctx) => {
    const { p, game } = needPlayer(ctx);
    const unlocked = visibleDay(game);
    const stats = computeStats(db, game).find((s) => s.id === p.id);
    return {
      id: p.id,
      name: p.name,
      nickname: p.nickname,
      game: { name: game.name, status: game.status, unlockedDay: unlocked, startDate: game.start_date },
      role: roleOf(p, game),
      // dias ainda trancados vão só como "cadeado": nada do conteúdo sai do servidor
      missions: game.status === 'setup' ? [] : assignmentsOf(db, p.id).map((r) =>
        (r.position <= unlocked ? { ...assignmentView(r, game), locked: false } : { number: r.position, day: r.position, locked: true })),
      stats,
      passes: { total: PASSES_PER_AGENT, used: stats.passesUsed, left: stats.passesLeft },
    };
  });

  router.add('POST', '/api/me/missions/:id/complete', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const a = ownAssignment(p, game, int(ctx.params.id));
    if (a.status === 'concluida') throw new HttpError(409, 'Desafio já concluído.');
    if (LOST.includes(a.status)) throw new HttpError(409, 'Este desafio já foi encerrado.');
    const note = str(ctx.body.note, 'Observação', { max: 500, required: false }) || null;
    let evidence = a.evidence_file;
    if (ctx.body.photo) {
      removeEvidence(cfg, evidence);
      evidence = saveEvidence(cfg, a.id, ctx.body.photo);
    }
    const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(a.mission_id);
    const auto = !!game.auto_confirm;
    const points = missionPoints(mission);
    db.prepare(`UPDATE assignments SET status = ?, submitted_at = ?, confirmed_at = ?, points_awarded = ?,
                note = ?, evidence_file = ?, review_message = NULL WHERE id = ?`)
      .run(auto ? 'concluida' : 'analise', now(), auto ? now() : null, auto ? points : null, note, evidence, a.id);
    logEvent(db, game, { type: auto ? 'concluida' : 'enviada', participant: p, assignmentId: a.id, missionTitle: mission.title, points });
    return { status: auto ? 'concluida' : 'analise' };
  });

  router.add('POST', '/api/me/missions/:id/undo', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const a = ownAssignment(p, game, int(ctx.params.id));
    if (a.status !== 'analise') throw new HttpError(409, 'Só dá para desfazer o que está em análise.');
    removeEvidence(cfg, a.evidence_file);
    db.prepare("UPDATE assignments SET status = 'pendente', submitted_at = NULL, evidence_file = NULL WHERE id = ?").run(a.id);
    const m = db.prepare('SELECT title FROM missions WHERE id = ?').get(a.mission_id);
    logEvent(db, game, { type: 'desfeita', participant: p, assignmentId: a.id, missionTitle: m.title });
    return { status: 'pendente' };
  });

  // Ficha de passe: recusa a rodada sem perder pontos. Cada agente tem PASSES_PER_AGENT.
  router.add('POST', '/api/me/missions/:id/pass', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const a = ownAssignment(p, game, int(ctx.params.id));
    if (a.status !== 'pendente') throw new HttpError(409, 'Só dá para passar um desafio pendente.');
    const used = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE participant_id = ? AND status = 'passe'").get(p.id).n;
    if (used >= PASSES_PER_AGENT) throw new HttpError(409, 'Você já usou suas fichas de passe.');
    db.prepare("UPDATE assignments SET status = 'passe', review_message = NULL WHERE id = ?").run(a.id);
    const m = db.prepare('SELECT title FROM missions WHERE id = ?').get(a.mission_id);
    logEvent(db, game, { type: 'passe', participant: p, assignmentId: a.id, missionTitle: m.title });
    return { left: PASSES_PER_AGENT - used - 1 };
  });

  router.add('GET', '/api/me/missions/:id/evidence', (ctx) => {
    const { p, game } = needPlayer(ctx);
    const a = ownAssignment(p, game, int(ctx.params.id));
    if (!a.evidence_file) throw new HttpError(404, 'Foto não encontrada.');
    sendEvidence(cfg, ctx.res, a.evidence_file);
    return HANDLED;
  });

  // Flagrante: o agente acusa alguém de ter um desafio em andamento; o organizador julga.
  router.add('POST', '/api/me/flagrantes', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const accused = int(ctx.body.accusedId, 'accusedId');
    if (accused === p.id) throw new HttpError(400, 'Você não pode se acusar.');
    if (!db.prepare('SELECT 1 FROM participants WHERE id = ? AND game_id = ?').get(accused, game.id)) throw new HttpError(404, 'Agente não encontrado.');
    const guess = str(ctx.body.guess, 'Palpite', { max: 300 });
    const pending = db.prepare("SELECT COUNT(*) AS n FROM flagrantes WHERE accuser_id = ? AND status = 'pendente'").get(p.id).n;
    if (pending >= 5) throw new HttpError(429, 'Aguarde o organizador julgar seus flagrantes pendentes.');
    const r = db.prepare('INSERT INTO flagrantes (game_id, accuser_id, accused_id, guess, created_at) VALUES (?,?,?,?,?)').run(game.id, p.id, accused, guess, now());
    logEvent(db, game, { type: 'flagrante_denuncia', participant: p, detail: `contra #${accused}: ${guess}` });
    return { id: Number(r.lastInsertRowid) };
  });

  router.add('GET', '/api/me/flagrantes', (ctx) => {
    const { p, game } = needPlayer(ctx);
    return {
      flagrantes: db.prepare(`SELECT f.id, f.status, f.guess, f.created_at, t.name AS accused FROM flagrantes f
                              JOIN participants t ON t.id = f.accused_id WHERE f.accuser_id = ? AND f.game_id = ? ORDER BY f.id DESC`).all(p.id, game.id),
    };
  });

  router.add('GET', '/api/ranking', (ctx) => {
    needAnyone(ctx);
    const game = currentGame(db);
    return { game: game && { name: game.name, status: game.status }, ranking: game ? publicRanking(db, game) : [] };
  });

  // Revelação final (segunda): só depois de a partida ser encerrada.
  router.add('GET', '/api/reveal', (ctx) => {
    needAnyone(ctx);
    const game = currentGame(db);
    if (!game || game.status !== 'finished') throw new HttpError(403, 'Os desafios só são revelados no fechamento.');
    const rows = assignmentsOfGame(db, game.id);
    return {
      agents: computeStats(db, game).map((s) => ({
        id: s.id, name: s.name, position: s.position, points: s.points,
        missions: rows.filter((r) => r.participant_id === s.id).map((r) => {
          const v = assignmentView(r, game);
          return { day: v.day, title: v.title, description: v.description, points: v.points, status: v.status };
        }),
      })),
    };
  });

  // Central do Agente Duplo (opcional): a permissão é checada no servidor, a cada chamada.
  router.add('GET', '/api/double/overview', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (!game.double_enabled || game.status === 'setup' || game.double_agent_id !== p.id) throw new HttpError(403, 'Acesso negado.');
    const rows = assignmentsOfGame(db, game.id);
    const stats = computeStats(db, game);
    const agents = participantsOf(db, game.id)
      .filter((o) => o.id !== p.id)
      .map((o) => {
        const s = stats.find((x) => x.id === o.id);
        return {
          id: o.id, name: o.name, nickname: o.nickname,
          points: s.points, done: s.done, total: s.total, percent: s.percent, position: s.position,
          missions: rows.filter((r) => r.participant_id === o.id).map((r) => {
            const v = assignmentView(r, game);
            return { number: v.number, title: v.title, description: v.description, points: v.points, status: v.status };
          }),
        };
      });
    return { agents };
  });
}
