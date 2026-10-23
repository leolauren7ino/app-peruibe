import { HttpError, str } from '../http.js';
import { createSession, destroySession, verifyPassword, normalize, normalizePassword } from '../security.js';
import { currentGame, participantsOf } from '../game.js';

// Hash fixo só para gastar o mesmo tempo quando o nome não existe (evita enumerar nomes por tempo de resposta).
const DUMMY = 'scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

const matches = (p, q) => {
  const fields = [normalize(p.name), normalize(p.nickname)].filter(Boolean);
  return fields.some((f) => f === q || f.split(' ').includes(q) || (q.length >= 3 && f.startsWith(q)));
};

export function authRoutes(router, { db, cfg, limiter }) {
  router.add('POST', '/api/login', async (ctx) => {
    const name = str(ctx.body.name, 'Nome', { max: 80 });
    const password = str(ctx.body.password, 'Senha', { max: 100 });
    if (limiter.blocked(ctx.ip) || limiter.blocked('*')) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    }
    const q = normalize(name);
    let session = null;

    if (['admin', 'administrador', 'adm'].includes(q)) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_hash'").get();
      if (row && (await verifyPassword(password, row.value))) session = { kind: 'admin' };
    } else {
      const game = currentGame(db);
      const cands = game ? participantsOf(db, game.id).filter((p) => matches(p, q)) : [];
      const pw = normalizePassword(password);
      if (!cands.length) await verifyPassword(pw, DUMMY);
      for (const p of cands) {
        if (await verifyPassword(pw, p.pw_hash)) { session = { kind: 'player', participantId: p.id }; break; }
      }
    }

    if (!session) {
      limiter.fail(ctx.ip);
      limiter.fail('*');
      throw new HttpError(401, 'Credenciais inválidas.');
    }
    limiter.reset(ctx.ip);
    const { token, maxAge } = createSession(db, { ...session, days: cfg.sessionDays });
    ctx.headers['Set-Cookie'] = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${ctx.secure ? '; Secure' : ''}`;
    return { kind: session.kind };
  });

  router.add('POST', '/api/logout', (ctx) => {
    destroySession(db, ctx.token);
    ctx.headers['Set-Cookie'] = 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
    return { ok: true };
  });

  router.add('GET', '/api/session', (ctx) => {
    if (!ctx.session) throw new HttpError(401, 'Sem sessão.');
    return { kind: ctx.session.kind };
  });
}
