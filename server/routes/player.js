import { HANDLED, HttpError, int, str } from '../http.js';
import { needPlayer, needAnyone } from '../guards.js';
import {
  assignmentsOf, assignmentsOfGame, assignmentView, computeStats, logEvent, missionPoints, participantsOf, publicRanking, currentGame,
} from '../game.js';
import { saveEvidence, removeEvidence, sendEvidence } from '../evidence.js';
import { now } from '../db.js';

export function playerRoutes(router, app) {
  const { db, cfg } = app;

  const roleOf = (p, game) => (game.status === 'setup' ? null : game.double_agent_id === p.id ? 'AGENTE_DUPLO' : 'AGENTE_SECRETO');

  router.add('GET', '/api/me', (ctx) => {
    const { p, game } = needPlayer(ctx);
    const started = game.status !== 'setup';
    return {
      id: p.id,
      name: p.name,
      nickname: p.nickname,
      game: { name: game.name, status: game.status },
      role: roleOf(p, game), // só o próprio agente recebe o próprio papel
      missions: started ? assignmentsOf(db, p.id).map((r) => assignmentView(r, game)) : [],
      stats: computeStats(db, game).find((s) => s.id === p.id),
    };
  });

  router.add('POST', '/api/me/missions/:id/complete', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const id = int(ctx.params.id);
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND participant_id = ?').get(id, p.id);
    if (!a) throw new HttpError(404, 'Missão não encontrada.'); // 404, nunca revela que existe para outro agente
    if (a.status === 'concluida') throw new HttpError(409, 'Missão já concluída.');
    const note = str(ctx.body.note, 'Observação', { max: 500, required: false }) || null;
    let evidence = a.evidence_file;
    if (ctx.body.photo) {
      removeEvidence(cfg, evidence);
      evidence = saveEvidence(cfg, a.id, ctx.body.photo);
    }
    const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(a.mission_id);
    const auto = !!game.auto_confirm;
    const points = missionPoints(mission, game);
    db.prepare(`UPDATE assignments SET status = ?, submitted_at = ?, confirmed_at = ?, points_awarded = ?,
                note = ?, evidence_file = ?, review_message = NULL WHERE id = ?`)
      .run(auto ? 'concluida' : 'analise', now(), auto ? now() : null, auto ? points : null, note, evidence, a.id);
    logEvent(db, game, { type: auto ? 'concluida' : 'enviada', participant: p, assignmentId: a.id, missionTitle: mission.title, points });
    return { status: auto ? 'concluida' : 'analise' };
  });

  router.add('POST', '/api/me/missions/:id/undo', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status !== 'active') throw new HttpError(409, 'A operação não está em andamento.');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND participant_id = ?').get(int(ctx.params.id), p.id);
    if (!a) throw new HttpError(404, 'Missão não encontrada.');
    if (a.status !== 'analise') throw new HttpError(409, 'Só dá para desfazer o que está em análise.');
    removeEvidence(cfg, a.evidence_file);
    db.prepare("UPDATE assignments SET status = 'pendente', submitted_at = NULL, evidence_file = NULL WHERE id = ?").run(a.id);
    const m = db.prepare('SELECT title FROM missions WHERE id = ?').get(a.mission_id);
    logEvent(db, game, { type: 'desfeita', participant: p, assignmentId: a.id, missionTitle: m.title });
    return { status: 'pendente' };
  });

  router.add('GET', '/api/me/missions/:id/evidence', (ctx) => {
    const { p } = needPlayer(ctx);
    const a = db.prepare('SELECT evidence_file FROM assignments WHERE id = ? AND participant_id = ?').get(int(ctx.params.id), p.id);
    if (!a?.evidence_file) throw new HttpError(404, 'Foto não encontrada.');
    sendEvidence(cfg, ctx.res, a.evidence_file);
    return HANDLED;
  });

  router.add('GET', '/api/ranking', (ctx) => {
    needAnyone(ctx);
    const game = currentGame(db);
    return { game: game && { name: game.name, status: game.status }, ranking: game ? publicRanking(db, game) : [] };
  });

  // Central do Agente Duplo: a permissão é checada no servidor, a cada chamada.
  router.add('GET', '/api/double/overview', (ctx) => {
    const { p, game } = needPlayer(ctx);
    if (game.status === 'setup' || game.double_agent_id !== p.id) throw new HttpError(403, 'Acesso negado.');
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
            return { number: v.number, title: v.title, description: v.description, level: v.level, category: v.category, points: v.points, status: v.status };
          }),
        };
      });
    return { agents };
  });
}
