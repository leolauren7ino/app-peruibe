import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

let app, base;
const ADMIN = 'ADMIN-TESTE-1';

// pequeno cliente HTTP com "cookie jar" por usuário
const client = () => {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
};

let admin, overview;
const players = {};
const loginAs = async (name) => {
  const c = client();
  const p = overview.participants.find((x) => x.name === name);
  assert.equal((await c.post('/api/login', { name, password: p.password })).status, 200, `login ${name}`);
  return c;
};
const ov = async () => (await admin.get('/api/admin/overview')).body;
const mine = async (name) => (await players[name].get('/api/me')).body;
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peruibe-'));
  app = await createApp({ dataDir: dir, adminPassword: ADMIN, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
  admin = client();
  assert.equal((await admin.post('/api/login', { name: 'admin', password: ADMIN })).status, 200);
  overview = await ov();
});
after(() => app.close());

test('login: senha errada e nome inexistente', async () => {
  const c = client();
  assert.equal((await c.post('/api/login', { name: 'Baiano', password: 'errada' })).status, 401);
  assert.equal((await c.post('/api/login', { name: 'Zé Ninguém', password: 'x' })).status, 401);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('login aceita apelido/primeiro nome e senha sem hífen/maiúsculas', async () => {
  const p = overview.participants.find((x) => x.name === 'Murillo Moya');
  const c = client();
  assert.equal((await c.post('/api/login', { name: ' moya ', password: p.password.toLowerCase().replaceAll('-', ' ') })).status, 200);
  assert.equal((await c.get('/api/me')).body.name, 'Murillo Moya');
});

test('antes de iniciar, o agente não vê desafios nem papel', async () => {
  const me = (await (await loginAs('Baiano')).get('/api/me')).body;
  assert.equal(me.game.status, 'setup');
  assert.deepEqual(me.missions, []);
  assert.equal(me.role, null);
});

test('admin vê tudo e agentes não acessam a área admin', async () => {
  assert.equal(overview.game.doubleEnabled, false);
  assert.equal(overview.doubleAgent, null);
  assert.equal(overview.participants.length, 9);
  assert.ok(overview.participants.every((p) => p.password && p.missions.length === 3));
  const c = await loginAs('Baiano');
  for (const url of ['/api/admin/overview', '/api/admin/events', '/api/admin/missions']) assert.equal((await c.get(url)).status, 403, url);
  assert.equal((await c.post('/api/admin/start')).status, 403);
  assert.equal((await c.post('/api/admin/day', { day: 3 })).status, 403);
});

test('sorteio: 1 desafio por dia, pontuação equilibrada, ninguém recebe desafio com o próprio nome', async () => {
  const totals = overview.participants.map((p) => p.missions.reduce((s, m) => s + m.points, 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 2, `totais: ${totals}`);
  for (const p of overview.participants) {
    assert.deepEqual(p.missions.map((m) => m.day), [1, 2, 3]);
    assert.ok(p.missions.every((m) => !/\[ALVO\]|\{alvo\}/i.test(m.description)), 'alvo substituído');
    assert.ok(p.missions.every((m) => !m.description.includes(p.name)), `${p.name} recebeu desafio com o próprio nome`);
    assert.ok(p.missions.filter((m) => m.points >= 5).every((m) => m.day === 3));
    if (p.restrictedRomantic) assert.ok(p.missions.every((m) => !m.romantic));
  }
});

test('Agente Duplo é opcional: desligado por padrão, ligado só antes de iniciar', async () => {
  assert.equal((await admin.post('/api/admin/draw/double')).status, 409);
  assert.equal((await admin.patch('/api/admin/game', { doubleEnabled: true })).status, 200);
  assert.equal((await admin.post('/api/admin/draw/double')).status, 200);
  overview = await ov();
  assert.ok(overview.doubleAgent?.name);
});

test('iniciar trava o sorteio e libera só o dia 1', async () => {
  assert.equal((await admin.post('/api/admin/start')).status, 200);
  for (const u of ['/api/admin/draw/double', '/api/admin/draw/missions', '/api/admin/draw/all']) assert.equal((await admin.post(u)).status, 409, u);
  assert.equal((await admin.patch('/api/admin/game', { doubleEnabled: false })).status, 409);
  assert.equal((await ov()).doubleAgent.id, overview.doubleAgent.id);
});

test('cada agente vê só o desafio do dia 1; dias futuros chegam trancados e sem conteúdo', async () => {
  for (const p of overview.participants) {
    players[p.name] = await loginAs(p.name);
    const me = await mine(p.name);
    assert.equal(me.missions.length, 3);
    const [d1, d2, d3] = me.missions;
    assert.equal(d1.locked, false);
    assert.equal(d1.points, p.missions[0].points);
    assert.deepEqual(d2, { number: 2, day: 2, locked: true });
    assert.deepEqual(d3, { number: 3, day: 3, locked: true });
    assert.equal(me.role, p.isDouble ? 'AGENTE_DUPLO' : 'AGENTE_SECRETO');
  }
});

test('desafio de dia trancado não pode ser acionado nem enumerado', async () => {
  const p = overview.participants.find((x) => x.name === 'Baiano');
  const day2 = p.missions[1];
  assert.equal((await players.Baiano.post(`/api/me/missions/${day2.id}/complete`, {})).status, 404);
  assert.equal((await players.Baiano.post(`/api/me/missions/${day2.id}/pass`)).status, 404);
  assert.ok(!JSON.stringify(await mine('Baiano')).includes(day2.title));
});

test('IDOR: agente não consegue agir sobre desafio de outro nem ver a foto dele', async () => {
  const other = overview.participants.find((p) => p.name === 'Felipe Gomiero').missions[0].id;
  assert.equal((await players.Baiano.post(`/api/me/missions/${other}/complete`, { note: 'hack' })).status, 404);
  assert.equal((await players.Baiano.post(`/api/me/missions/${other}/undo`)).status, 404);
  assert.equal((await players.Baiano.post(`/api/me/missions/${other}/pass`)).status, 404);
  assert.equal((await players.Baiano.get(`/api/me/missions/${other}/evidence`)).status, 404);
  assert.equal((await ov()).participants.find((p) => p.name === 'Felipe Gomiero').missions[0].status, 'pendente');
});

test('Agente Duplo: só ele acessa a central; ranking e /me dos outros não vazam o papel', async () => {
  const dbl = overview.doubleAgent.name;
  const central = await players[dbl].get('/api/double/overview');
  assert.equal(central.status, 200);
  assert.equal(central.body.agents.length, 8);
  for (const p of overview.participants.filter((x) => x.name !== dbl)) {
    assert.equal((await players[p.name].get('/api/double/overview')).status, 403, p.name);
    assert.ok(!JSON.stringify(await mine(p.name)).includes('AGENTE_DUPLO'));
  }
  assert.ok(!/double|duplo|isDouble|role/i.test(JSON.stringify((await players.Baiano.get('/api/ranking')).body)));
  assert.equal((await client().get('/api/double/overview')).status, 401);
});

test('fluxo: enviar → em análise → admin confirma → pontos do desafio → ranking; devolver e resetar', async () => {
  const name = 'Murillo Moya';
  const d1 = (await mine(name)).missions[0];
  assert.equal((await players[name].post(`/api/me/missions/${d1.id}/complete`, { note: 'feito!', photo: PNG })).body.status, 'analise');
  assert.equal((await players[name].get(`/api/me/missions/${d1.id}/evidence`)).status, 200);
  assert.equal((await players.Baiano.get(`/api/me/missions/${d1.id}/evidence`)).status, 404);
  assert.equal((await admin.get(`/api/admin/assignments/${d1.id}/evidence`)).status, 200);

  let row = (await players.Baiano.get('/api/ranking')).body.ranking.find((r) => r.name === name);
  assert.equal(row.points, 0);
  assert.equal((await admin.post(`/api/admin/assignments/${d1.id}/confirm`)).status, 200);
  row = (await players.Baiano.get('/api/ranking')).body.ranking.find((r) => r.name === name);
  assert.deepEqual([row.points, row.done, row.remaining, row.percent], [d1.points, 1, 2, 33]);
  assert.equal((await admin.post(`/api/admin/assignments/${d1.id}/confirm`)).status, 409);
  assert.equal((await players[name].post(`/api/me/missions/${d1.id}/complete`)).status, 409);

  assert.equal((await admin.post(`/api/admin/assignments/${d1.id}/reset`)).status, 200);
  await players[name].post(`/api/me/missions/${d1.id}/complete`, {});
  assert.equal((await admin.post(`/api/admin/assignments/${d1.id}/reject`, { message: 'foto escura' })).status, 200);
  const back = (await mine(name)).missions[0];
  assert.deepEqual([back.status, back.reviewMessage], ['pendente', 'foto escura']);
  const types = (await admin.get('/api/admin/events')).body.events.map((e) => e.type);
  assert.ok(['enviada', 'confirmada', 'devolvida', 'resetada'].every((t) => types.includes(t)));
});

test('foto inválida é recusada', async () => {
  const m = (await mine('Baiano')).missions[0];
  const fake = 'data:image/png;base64,' + Buffer.from('isto não é uma imagem').toString('base64');
  assert.equal((await players.Baiano.post(`/api/me/missions/${m.id}/complete`, { photo: fake })).status, 400);
  assert.equal((await players.Baiano.post(`/api/me/missions/${m.id}/complete`, { photo: 'data:text/html;base64,PGI+' })).status, 400);
});

test('liberar o dia 2 revela o desafio; dia 3 só depois', async () => {
  assert.equal((await admin.post('/api/admin/day', { day: 2 })).status, 200);
  const me = await mine('Baiano');
  assert.equal(me.missions[1].locked, false);
  assert.equal(me.missions[2].locked, true);
  assert.equal((await admin.post('/api/admin/day', { day: 9 })).status, 400);
});

test('fichas de passe: 2 por agente, sem perder pontos; a 3ª é recusada', async () => {
  const name = 'Henrique Gomiero';
  const [d1, d2] = (await mine(name)).missions;
  assert.equal((await players[name].post(`/api/me/missions/${d1.id}/pass`)).body.left, 1);
  assert.equal((await players[name].post(`/api/me/missions/${d2.id}/pass`)).body.left, 0);
  assert.equal((await players[name].post(`/api/me/missions/${d1.id}/pass`)).status, 409);
  const me = await mine(name);
  assert.equal(me.passes.left, 0);
  assert.equal(me.stats.points, 0);
  assert.equal(me.missions[0].status, 'passe');
  assert.equal((await players[name].post(`/api/me/missions/${d1.id}/complete`)).status, 409);
  assert.equal((await admin.post(`/api/admin/assignments/${d1.id}/confirm`)).status, 409);
});

test('flagrante: acusador ganha 1 ponto e o dono perde aquele desafio', async () => {
  const [acc, vic] = ['Vovô Slavic', 'Bruno Picarelli'];
  const vid = overview.participants.find((p) => p.name === vic).id;
  assert.equal((await players[acc].post('/api/me/flagrantes', { accusedId: vid, guess: 'tá fazendo brinde combinado' })).status, 200);
  assert.equal((await players[acc].post('/api/me/flagrantes', { accusedId: overview.participants.find((p) => p.name === acc).id, guess: 'eu' })).status, 400);
  const o = await ov();
  assert.equal(o.flagrantes.length, 1);
  const target = o.flagrantes[0].candidates[0];
  assert.equal((await admin.post(`/api/admin/flagrantes/${o.flagrantes[0].id}/accept`, { assignmentId: target.id })).status, 200);
  assert.equal((await mine(vic)).missions.find((m) => m.id === target.id).status, 'flagrante');
  assert.equal((await mine(acc)).stats.points, 1);
  assert.equal((await players[vic].post(`/api/me/missions/${target.id}/complete`)).status, 409);
  assert.equal((await ov()).flagrantes.length, 0);
});

test('ajuste manual de pontos (fuga = -1) entra no ranking', async () => {
  const p = overview.participants.find((x) => x.name === 'Matheus Italiano');
  assert.equal((await admin.post(`/api/admin/participants/${p.id}/adjust`, { points: -1, reason: 'fugiu sem ficha' })).status, 200);
  assert.equal((await admin.post(`/api/admin/participants/${p.id}/adjust`, { points: 0, reason: 'x' })).status, 400);
  assert.equal((await players['Matheus Italiano'].get('/api/ranking')).body.ranking.find((r) => r.id === p.id).points, -1);
});

test('revelação final só depois de encerrar', async () => {
  assert.equal((await players.Baiano.get('/api/reveal')).status, 403);
});

test('novo agente recebe 3 desafios sem mexer nos outros; remover derruba a sessão', async () => {
  const before = (await ov()).participants.map((p) => p.missions.map((m) => m.missionId).join());
  // o catálogo padrão tem exatamente 27 desafios para 9 agentes: sem sobra, um 10º agente é recusado com aviso claro
  const full = await admin.post('/api/admin/participants', { name: 'Novo Agente' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /faltam/i);
  assert.equal((await ov()).participants.length, 9);
  await admin.post('/api/admin/missions/import', { missions: [1, 2, 3].map((i) => ({ title: `Extra ${i}`, description: 'Brindar com [ALVO]', points: i === 3 ? 3 : 1, target: '*' })) });
  const added = await admin.post('/api/admin/participants', { name: 'Novo Agente' });
  assert.equal(added.status, 200);
  const o = await ov();
  assert.equal(o.participants.length, 10);
  assert.deepEqual(o.participants.at(-1).missions.map((m) => m.day), [1, 2, 3]);
  assert.deepEqual(o.participants.slice(0, 9).map((p) => p.missions.map((m) => m.missionId).join()), before);
  const fresh = client();
  assert.equal((await fresh.post('/api/login', { name: 'Novo Agente', password: added.body.password })).status, 200);
  assert.equal((await admin.del(`/api/admin/participants/${o.participants.at(-1).id}`)).status, 200);
  assert.equal((await fresh.get('/api/me')).status, 401);
  assert.equal((await ov()).participants.length, 9);
});

test('catálogo: criar, editar, importar (inclusive formato antigo) e apagar', async () => {
  const created = await admin.post('/api/admin/missions', { title: 'Teste', description: 'Faça [ALVO] sorrir', points: 2, category: 'humor', target: '*' });
  assert.equal(created.status, 200);
  assert.equal((await admin.patch(`/api/admin/missions/${created.body.id}`, { points: 3 })).status, 200);
  assert.equal((await admin.post('/api/admin/missions', { title: 'x', description: 'y', points: 0 })).status, 400);
  assert.equal((await admin.post('/api/admin/missions/import', { missions: [{ title: 'A', description: 'b', level: 'dificil' }, { title: 'B', description: 'c', points: 5 }] })).body.count, 2);
  assert.equal((await admin.del(`/api/admin/missions/${created.body.id}`)).body.deleted, true);
});

test('trocar desafio mantém o dia, respeita restrição e zera o status', async () => {
  const q = (await ov()).participants.find((p) => p.name === 'Matheus Quinzani');
  const t = q.missions[0];
  assert.equal((await admin.post(`/api/admin/assignments/${t.id}/swap`, {})).status, 200);
  const after = (await ov()).participants.find((p) => p.name === 'Matheus Quinzani');
  assert.notEqual(after.missions[0].missionId, t.missionId);
  assert.ok(after.missions.every((m) => !m.romantic));
});

test('encerrar revela tudo e bloqueia ações dos agentes', async () => {
  assert.equal((await admin.post('/api/admin/finish')).status, 200);
  const m = (await mine('Baiano')).missions;
  assert.ok(m.every((x) => !x.locked));
  assert.equal((await players.Baiano.post(`/api/me/missions/${m[0].id}/complete`)).status, 409);
  const reveal = await players.Baiano.get('/api/reveal');
  assert.equal(reveal.status, 200);
  assert.equal(reveal.body.agents.length, 9);
});

test('segurança: estáticos não escapam do diretório, cookie HttpOnly e Origin cruzada recusada', async () => {
  const txt = await (await fetch(base + '/..%2fserver%2fconfig.js')).text();
  assert.ok(!txt.includes('loadConfig'));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: ADMIN }) });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cross = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('senhas ficam hasheadas no banco (não em texto puro)', () => {
  const plain = overview.participants.map((p) => p.password);
  for (const r of app.db.prepare('SELECT pw_hash, pw_enc FROM participants').all()) {
    assert.match(r.pw_hash, /^scrypt\$/);
    assert.ok(!plain.some((pw) => r.pw_hash.includes(pw) || r.pw_enc.includes(pw)));
  }
});

test('bloqueia login após muitas tentativas erradas', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c.post('/api/login', { name: 'Baiano', password: `chute${i}` });
  assert.equal(last.status, 429);
});
