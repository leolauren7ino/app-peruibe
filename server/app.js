import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, ROOT } from './config.js';
import { openDb, tx, now } from './db.js';
import { loadSecretKey, LoginLimiter, readSession, hashPassword, verifyPassword, generatePassword } from './security.js';
import { createRouter, HANDLED, HttpError, parseCookies, readJson, sendJson, serveStatic } from './http.js';
import { addParticipant, currentGame, drawAllMissions, drawDouble, setPassword } from './game.js';
import { createBackup } from './backup.js';
import { authRoutes } from './routes/auth.js';
import { playerRoutes } from './routes/player.js';
import { adminRoutes } from './routes/admin.js';

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  fs.mkdirSync(path.join(cfg.dataDir, 'evidence'), { recursive: true });
  const dbFile = path.join(cfg.dataDir, 'peruibe.db');
  const notes = [];
  const backup = cfg.backup ? createBackup({ ...cfg.backup, dbFile }) : null;
  if (backup) {
    // se não der para consultar o Gist, falha de propósito: melhor não subir do que começar um jogo novo por cima do salvo
    const state = await backup.restoreIfMissing();
    if (state === 'restored') notes.push('Banco restaurado do backup (Gist).');
    if (!cfg.appSecret) notes.push('ATENÇÃO: defina APP_SECRET; sem ele as senhas visíveis ao admin não sobrevivem a um reinício.');
  }
  const db = openDb(dbFile);
  const key = loadSecretKey(cfg.dataDir, cfg.appSecret);
  const limiter = new LoginLimiter();
  const app = { cfg, db, key, limiter, notes };

  // salva o banco no Gist pouco depois de qualquer alteração (várias seguidas viram um único envio)
  let timer = null;
  let chain = Promise.resolve();
  app.flush = async () => {
    if (!backup) return;
    clearTimeout(timer);
    timer = null;
    chain = chain.catch(() => {}).then(() => backup.save(db));
    await chain;
  };
  app.dirty = () => {
    if (!backup || timer) return;
    timer = setTimeout(() => { timer = null; app.flush().catch((e) => console.error(e.message)); }, cfg.backupDelayMs);
  };

  await setupAdmin(app);
  if (cfg.seed) await seedIfEmpty(app);

  const router = createRouter();
  authRoutes(router, app);
  playerRoutes(router, app);
  adminRoutes(router, app);

  app.dirty();
  const server = http.createServer((req, res) => handle(app, router, req, res));
  return {
    ...app,
    server,
    listen: () => new Promise((ok) => server.listen(cfg.port, () => ok(server.address().port))),
    close: async () => {
      await app.flush().catch((e) => console.error(e.message));
      await new Promise((ok) => { server.close(() => { db.close(); ok(); }); server.closeAllConnections?.(); });
    },
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

const CATALOG_VERSION = 2; // 2 = desafios do Peruibiza (pontos 1/2/3/5)
const TEXTS_VERSION = 3; // 3 = textos exatamente como o organizador escreveu (sem reescritas); Agente Duplo ligado por padrão

function ensureCatalog(app) {
  const { db } = app;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'catalog_version'").get();
  if (Number(row?.value) >= CATALOG_VERSION) return false;
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/missions.json'), 'utf8'));
  const ins = db.prepare(`INSERT INTO missions (title, description, points, category, target, romantic, created_at) VALUES (?,?,?,?,?,?,?)`);
  tx(db, () => {
    db.prepare('UPDATE missions SET active = 0').run(); // o catálogo da 1ª versão fica no histórico, mas fora do sorteio
    seed.forEach((m) => ins.run(m.title, m.description, m.points, m.category, m.target ?? null, m.romantic ? 1 : 0, now()));
    db.prepare("INSERT INTO settings (key, value) VALUES ('catalog_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(CATALOG_VERSION));
    db.prepare("INSERT INTO settings (key, value) VALUES ('texts_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(TEXTS_VERSION));
  });
  return true;
}

/** Bancos que já tinham os desafios recebem os textos oficiais no lugar (sem mexer em sorteios em andamento) uma única vez. */
function syncSeedTexts(app) {
  const { db } = app;
  if (Number(db.prepare("SELECT value FROM settings WHERE key = 'texts_version'").get()?.value) >= TEXTS_VERSION) return;
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/missions.json'), 'utf8'));
  const upd = db.prepare('UPDATE missions SET title = ?, description = ?, points = ?, category = ?, target = ?, romantic = ? WHERE title IN (?, ?)');
  tx(db, () => {
    for (const m of seed) upd.run(m.title, m.description, m.points, m.category, m.target ?? null, m.romantic ? 1 : 0, m.title, m.title === 'Missão [ALVO]' ? 'Missão Moya' : m.title);
    db.prepare("INSERT INTO settings (key, value) VALUES ('texts_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(TEXTS_VERSION));
  });
  // partida ainda em preparação: liga e sorteia o Agente Duplo (em partida já iniciada o sorteio está travado)
  const g = currentGame(db);
  if (g && g.status === 'setup') {
    db.prepare('UPDATE games SET double_enabled = 1 WHERE id = ?').run(g.id);
    if (!g.double_agent_id) drawDouble(db, { ...g, double_enabled: 1 });
  }
}

/**
 * Senhas escolhidas à mão ficam em data/credenciais.json ({ "Nome do agente": "SENHA" }), fora do git.
 * Aplicadas uma única vez (depois, edições feitas no painel prevalecem). Nomes ocultos vêm do seed.
 */
const readCredentials = (cfg) => {
  const file = path.join(cfg.dataDir, 'credenciais.json');
  const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // em hospedagens sem acesso a arquivos: CREDENTIALS_JSON='{"Nome":"SENHA",...}'
  return { ...fromFile, ...(process.env.CREDENTIALS_JSON ? JSON.parse(process.env.CREDENTIALS_JSON) : {}) };
};

async function applySeedCredentials(app) {
  const { db, key, cfg } = app;
  const game = currentGame(db);
  if (!game) return;
  const people = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/participants.json'), 'utf8'));
  for (const sp of people) {
    const p = db.prepare('SELECT * FROM participants WHERE game_id = ? AND name = ?').get(game.id, sp.name);
    if (p && sp.alias && !p.alias) db.prepare('UPDATE participants SET alias = ? WHERE id = ?').run(sp.alias, p.id);
  }
  const creds = readCredentials(cfg);
  if (!Object.keys(creds).length || db.prepare("SELECT 1 FROM settings WHERE key = 'seed_credentials_applied'").get()) return;
  for (const [name, pw] of Object.entries(creds)) {
    const p = db.prepare('SELECT * FROM participants WHERE game_id = ? AND name = ?').get(game.id, name);
    if (p) await setPassword(db, key, p.id, pw);
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_credentials_applied', '1')").run();
}

/** Anúncio do Clássico (uma única vez; depois o admin controla: resultado, ocultar). */
function seedAnnouncements(app) {
  const { db } = app;
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'classico_seeded'").get()) return;
  db.prepare(`INSERT INTO announcements (kind, title, subtitle, body, left_name, right_name, left_image, right_image, created_at)
              VALUES ('versus', 'O CLÁSSICO', 'SUPER FERAS', ?, 'Vovô Slavic', 'Brunão', 'classico-esquerda.jpg', 'classico-direita.jpg', ?)`)
    .run('Vovô Slavic x Brunão se enfrentam em Super Feras. Quem ganhar controla o outro por todo o dia.', now());
  db.prepare("INSERT INTO settings (key, value) VALUES ('classico_seeded', '1')").run();
}

/** Primeira execução: partida com os 9 agentes, já sorteada (ainda não iniciada). Bancos antigos são atualizados. */
async function seedIfEmpty(app) {
  const { db, cfg, key } = app;
  seedAnnouncements(app);
  const changed = ensureCatalog(app);
  syncSeedTexts(app); // o título de Moya usa [ALVO] para não entregar o nome de quem tem "nome oculto"
  const existing = currentGame(db);
  if (existing) {
    await applySeedCredentials(app);
    if (!changed) return;
    if (existing.status === 'setup') {
      db.prepare('DELETE FROM assignments WHERE game_id = ?').run(existing.id);
      drawAllMissions(db, cfg.dataDir, existing);
      app.notes.push(`Catálogo atualizado e missões de "${existing.name}" sorteadas de novo com as regras novas.`);
    } else {
      app.notes.push(`Catálogo atualizado. A partida "${existing.name}" já tinha começado com as regras antigas: crie uma NOVA PARTIDA no painel (mantendo agentes e senhas).`);
    }
    return;
  }
  const r = db.prepare('INSERT INTO games (name, start_date, double_enabled, created_at) VALUES (?, ?, 1, ?)').run('Peruibiza 4ª Edição', '2026-10-30', now());
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(r.lastInsertRowid);
  const people = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/participants.json'), 'utf8'));
  const creds = readCredentials(cfg);
  for (const p of people) await addParticipant(db, key, game, { ...p, password: creds[p.name] });
  if (Object.keys(creds).length) db.prepare("INSERT INTO settings (key, value) VALUES ('seed_credentials_applied', '1')").run();
  drawDouble(db, game);
  drawAllMissions(db, cfg.dataDir, game);
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
    if (mutating && !/^\/api\/(login|logout)$/.test(url.pathname)) app.dirty();
    if (out !== HANDLED) sendJson(res, 200, out ?? { ok: true }, ctx.headers);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Erro interno.' });
  }
}
