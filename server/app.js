import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, ROOT } from './config.js';
import { openDb, tx, now } from './db.js';
import { loadSecretKey, LoginLimiter, readSession, hashPassword, verifyPassword, generatePassword } from './security.js';
import { createRouter, HANDLED, HttpError, parseCookies, readJson, sendJson, serveStatic } from './http.js';
import { addParticipant, currentGame, drawDouble, drawAllMissions } from './game.js';
import { authRoutes } from './routes/auth.js';
import { playerRoutes } from './routes/player.js';
import { adminRoutes } from './routes/admin.js';

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  fs.mkdirSync(path.join(cfg.dataDir, 'evidence'), { recursive: true });
  const db = openDb(path.join(cfg.dataDir, 'peruibe.db'));
  const key = loadSecretKey(cfg.dataDir, cfg.appSecret);
  const limiter = new LoginLimiter();
  const app = { cfg, db, key, limiter, notes: [] };

  await setupAdmin(app);
  if (cfg.seed) await seedIfEmpty(app);

  const router = createRouter();
  authRoutes(router, app);
  playerRoutes(router, app);
  adminRoutes(router, app);

  const server = http.createServer((req, res) => handle(app, router, req, res));
  return {
    ...app,
    server,
    listen: () => new Promise((ok) => server.listen(cfg.port, () => ok(server.address().port))),
    close: () => new Promise((ok) => { server.close(() => { db.close(); ok(); }); server.closeAllConnections?.(); }),
  };
}

async function setupAdmin(app) {
  const { db, cfg } = app;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_hash'").get();
  let plain = cfg.adminPassword;
  if (plain && row && (await verifyPassword(plain, row.value))) return;
  if (!plain && row) return;
  let generated = false;
  if (!plain) { plain = generatePassword(); generated = true; }
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(await hashPassword(plain));
  if (generated) {
    fs.writeFileSync(path.join(cfg.dataDir, 'ADMIN_PASSWORD.txt'), `${plain}\n`, { mode: 0o600 });
    app.notes.push(`Senha do ADMIN gerada: ${plain}  (salva em ${path.join(cfg.dataDir, 'ADMIN_PASSWORD.txt')})`);
  }
}

/** Primeira execução: catálogo de missões + partida com os 9 agentes, já sorteada (ainda não iniciada). */
async function seedIfEmpty(app) {
  const { db, cfg, key } = app;
  if (db.prepare('SELECT COUNT(*) AS n FROM missions').get().n === 0) {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/missions.json'), 'utf8'));
    const ins = db.prepare(`INSERT INTO missions (title, description, level, category, target, romantic, effort, created_at)
                            VALUES (?,?,?,?,?,?,?,?)`);
    tx(db, () => seed.forEach((m) => ins.run(m.title, m.description, m.level, m.category, m.target ?? null, m.romantic ? 1 : 0, m.effort ?? 2, now())));
  }
  if (currentGame(db)) return;
  const r = db.prepare('INSERT INTO games (name, created_at) VALUES (?, ?)').run('Operação Peruíbe', now());
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(r.lastInsertRowid);
  const people = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/participants.json'), 'utf8'));
  for (const p of people) await addParticipant(db, key, game, p);
  drawDouble(db, game);
  drawAllMissions(db, cfg.dataDir, db.prepare('SELECT * FROM games WHERE id = ?').get(game.id));
  app.notes.push(`Partida "${game.name}" criada com ${people.length} agentes e já sorteada. Entre como admin para ver as senhas e iniciar a operação.`);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function handle(app, router, req, res) {
  const { cfg, db } = app;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      return serveStatic(req, res, cfg.publicDir);
    }

    const mutating = !['GET', 'HEAD'].includes(req.method);
    const origin = req.headers.origin;
    if (mutating && origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.');

    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Rota não encontrada.');

    const cookies = parseCookies(req.headers.cookie);
    const forwarded = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const secure = !!req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const ctx = {
      req, res, app, db, cfg, key: app.key,
      params: match.params,
      query: Object.fromEntries(url.searchParams),
      body: mutating ? await readJson(req, cfg.maxImageBytes * 2) : {},
      session: readSession(db, cookies.sid),
      token: cookies.sid,
      ip: forwarded || req.socket.remoteAddress || '?',
      secure,
      headers: {},
    };
    const out = await match.handler(ctx);
    if (out !== HANDLED) sendJson(res, 200, out ?? { ok: true }, ctx.headers);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Erro interno.' });
  }
}
