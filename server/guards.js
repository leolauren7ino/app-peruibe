import { HttpError } from './http.js';
import { currentGame } from './game.js';

/** Exige sessão de agente válida na partida atual. Retorna { p, game }. */
export function needPlayer({ db, session }) {
  if (session?.kind !== 'player') throw new HttpError(401, 'Acesso restrito. Faça login.');
  const game = currentGame(db);
  const p = game && db.prepare('SELECT * FROM participants WHERE id = ? AND game_id = ?').get(session.participantId, game.id);
  if (!p) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  return { p, game };
}

export function needAdmin({ session }) {
  if (session?.kind !== 'admin') throw new HttpError(403, 'Acesso restrito ao administrador.');
}

export function needAnyone({ session }) {
  if (!session) throw new HttpError(401, 'Acesso restrito. Faça login.');
}
