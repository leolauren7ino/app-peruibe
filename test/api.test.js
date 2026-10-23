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
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
};

let admin, overview;
const players = {};
const loginAs = async (name) => {
  const c = client();
  const p = overview.participants.find((x) => x.name === name);
  const r = await c.post('/api/login', { name, password: p.password });
  assert.equal(r.status, 200, `login ${name}`);
  return c;
};

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peruibe-'));
  app = await createApp({ dataDir: dir, adminPassword: ADMIN, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
  admin = client();
  assert.equal((await admin.post('/api/login', { name: 'admin', password: ADMIN })).status, 200);
  overview = (await admin.get('/api/admin/overview')).body;
});
after(() => app.close());

test('login: senha errada, nome inexistente e rate limit', async () => {
  const c = client();
  assert.equal((await c.post('/api/login', { name: 'Baiano', password: 'errada' })).status, 401);
  assert.equal((await c.post('/api/login', { name: 'Zé Ninguém', password: 'x' })).status, 401);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('login aceita apelido/primeiro nome e senha sem hífen/maiúsculas', async () => {
  const p = overview.participants.find((x) => x.name === 'Murillo Moya');
  const c = client();
  const r = await c.post('/api/login', { name: ' moya ', password: p.password.toLowerCase().replaceAll('-', ' ') });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/me')).body.name, 'Murillo Moya');
});

test('antes de iniciar, o agente não vê missões nem papel', async () => {
  const c = await loginAs('Baiano');
  const me = (await c.get('/api/me')).body;
  assert.equal(me.game.status, 'setup');
  assert.deepEqual(me.missions, []);
  assert.equal(me.role, null);
});

test('admin vê o Agente Duplo e todas as senhas; participante não acessa admin', async () => {
  assert.ok(overview.doubleAgent?.name);
  assert.equal(overview.participants.length, 9);
  assert.ok(overview.participants.every((p) => p.password && p.missions.length === 3));
  const c = await loginAs('Baiano');
  for (const url of ['/api/admin/overview', '/api/admin/events', '/api/admin/missions']) {
    assert.equal((await c.get(url)).status, 403, url);
  }
  assert.equal((await c.post('/api/admin/start')).status, 403);
});

test('iniciar trava o sorteio', async () => {
  assert.equal((await admin.post('/api/admin/start')).status, 200);
  assert.equal((await admin.post('/api/admin/draw/double')).status, 409);
  assert.equal((await admin.post('/api/admin/draw/missions')).status, 409);
  assert.equal((await admin.post('/api/admin/draw/all')).status, 409);
  const after = (await admin.get('/api/admin/overview')).body;
  assert.equal(after.doubleAgent.id, overview.doubleAgent.id);
});

test('cada agente vê só as próprias 3 missões (2 médias + 1 difícil) com pontos 100/200', async () => {
  for (const p of overview.participants) {
    const c = await loginAs(p.name);
    players[p.name] = c;
    const me = (await c.get('/api/me')).body;
    assert.equal(me.missions.length, 3);
    assert.deepEqual(me.missions.map((m) => m.level), ['medio', 'dificil', 'medio']);
    assert.deepEqual(me.missions.map((m) => m.points), [100, 200, 100]);
    assert.ok(me.missions.every((m) => !m.description.includes('{alvo}')));
    assert.equal(me.role, p.isDouble ? 'AGENTE_DUPLO' : 'AGENTE_SECRETO');
  }
});

test('IDOR: agente não consegue agir sobre missão de outro nem ver a foto dela', async () => {
  const [a, b] = ['Baiano', 'Felipe Gomiero'];
  const bMissionId = overview.participants.find((p) => p.name === b).missions[0].id;
  const r = await players[a].post(`/api/me/missions/${bMissionId}/complete`, { note: 'hack' });
  assert.equal(r.status, 404);
  assert.equal((await players[a].post(`/api/me/missions/${bMissionId}/undo`)).status, 404);
  assert.equal((await players[a].get(`/api/me/missions/${bMissionId}/evidence`)).status, 404);
  const st = (await admin.get('/api/admin/overview')).body.participants.find((p) => p.name === b).missions[0].status;
  assert.equal(st, 'pendente');
});

test('Agente Duplo: só ele acessa a central; ranking e /me dos outros não vazam o papel', async () => {
  const dbl = overview.doubleAgent.name;
  const central = await players[dbl].get('/api/double/overview');
  assert.equal(central.status, 200);
  assert.equal(central.body.agents.length, 8);
  assert.ok(central.body.agents.every((a) => a.name !== dbl && a.missions.length === 3));

  for (const p of overview.participants.filter((x) => x.name !== dbl)) {
    assert.equal((await players[p.name].get('/api/double/overview')).status, 403, p.name);
  }
  const ranking = JSON.stringify((await players.Baiano.get('/api/ranking')).body);
  assert.ok(!/double|duplo|isDouble|role/i.test(ranking));
  for (const p of overview.participants.filter((x) => x.name !== dbl)) {
    const me = JSON.stringify((await players[p.name].get('/api/me')).body);
    assert.ok(!/AGENTE_DUPLO/.test(me));
  }
  assert.equal((await client().get('/api/double/overview')).status, 401);
});

test('fluxo: enviar → em análise → admin confirma → ranking atualiza; devolver e resetar', async () => {
  const name = 'Murillo Moya';
  const me = (await players[name].get('/api/me')).body;
  const hard = me.missions.find((m) => m.level === 'dificil');
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');

  const sent = await players[name].post(`/api/me/missions/${hard.id}/complete`, { note: 'feito!', photo: png });
  assert.equal(sent.body.status, 'analise');
  assert.equal((await players[name].get(`/api/me/missions/${hard.id}/evidence`)).status, 200);
  assert.equal((await players.Baiano.get(`/api/me/missions/${hard.id}/evidence`)).status, 404);
  assert.equal((await admin.get(`/api/admin/assignments/${hard.id}/evidence`)).status, 200);

  let rk = (await players.Baiano.get('/api/ranking')).body.ranking;
  assert.equal(rk.find((r) => r.name === name).points, 0); // ainda não conta

  assert.equal((await admin.post(`/api/admin/assignments/${hard.id}/confirm`)).status, 200);
  rk = (await players.Baiano.get('/api/ranking')).body.ranking;
  const row = rk.find((r) => r.name === name);
  assert.deepEqual([row.points, row.done, row.remaining, row.percent, row.position], [200, 1, 2, 33, 1]);

  assert.equal((await admin.post(`/api/admin/assignments/${hard.id}/confirm`)).status, 409);
  assert.equal((await players[name].post(`/api/me/missions/${hard.id}/complete`)).status, 409);

  const easy = me.missions[0];
  await players[name].post(`/api/me/missions/${easy.id}/complete`, {});
  assert.equal((await admin.post(`/api/admin/assignments/${easy.id}/reject`, { message: 'foto escura' })).status, 200);
  const back = (await players[name].get('/api/me')).body.missions[0];
  assert.equal(back.status, 'pendente');
  assert.equal(back.reviewMessage, 'foto escura');

  assert.equal((await admin.post(`/api/admin/assignments/${hard.id}/reset`)).status, 200);
  rk = (await players.Baiano.get('/api/ranking')).body.ranking;
  assert.equal(rk.find((r) => r.name === name).points, 0);

  const ev = (await admin.get('/api/admin/events')).body.events.map((e) => e.type);
  assert.ok(['enviada', 'confirmada', 'devolvida', 'resetada'].every((t) => ev.includes(t)));
});

test('foto inválida é recusada', async () => {
  const m = (await players.Baiano.get('/api/me')).body.missions[0];
  const fake = 'data:image/png;base64,' + Buffer.from('isto não é uma imagem').toString('base64');
  assert.equal((await players.Baiano.post(`/api/me/missions/${m.id}/complete`, { photo: fake })).status, 400);
  assert.equal((await players.Baiano.post(`/api/me/missions/${m.id}/complete`, { photo: 'data:text/html;base64,PGI+' })).status, 400);
});

test('pontuação configurável e novo agente recebe 3 missões sem mexer nos outros', async () => {
  assert.equal((await admin.patch('/api/admin/game', { pointsMedio: 150, pointsDificil: 300 })).status, 200);
  assert.deepEqual((await players.Baiano.get('/api/me')).body.missions.map((m) => m.points), [150, 300, 150]);

  const before = (await admin.get('/api/admin/overview')).body.participants.map((p) => p.missions.map((m) => m.missionId).join());
  const added = await admin.post('/api/admin/participants', { name: 'Novo Agente' });
  assert.equal(added.status, 200);
  assert.ok(added.body.password);
  const ov = (await admin.get('/api/admin/overview')).body;
  assert.equal(ov.participants.length, 10);
  assert.equal(ov.participants.at(-1).missions.length, 3);
  assert.deepEqual(ov.participants.slice(0, 9).map((p) => p.missions.map((m) => m.missionId).join()), before);
  const fresh = client();
  assert.equal((await fresh.post('/api/login', { name: 'Novo Agente', password: added.body.password })).status, 200);

  // remover: sessão cai, missões voltam ao pool
  const rem = ov.participants.at(-1);
  assert.equal((await admin.del(`/api/admin/participants/${rem.id}`)).status, 200);
  assert.equal((await fresh.get('/api/me')).status, 401);
  assert.equal((await admin.get('/api/admin/overview')).body.participants.length, 9);
});

test('catálogo: criar, editar, importar e desativar missões', async () => {
  const created = await admin.post('/api/admin/missions', { title: 'Teste', description: 'Faça {alvo} sorrir', level: 'medio', category: 'humor', target: '*' });
  assert.equal(created.status, 200);
  assert.equal((await admin.patch(`/api/admin/missions/${created.body.id}`, { points: 250 })).status, 200);
  assert.equal((await admin.post('/api/admin/missions', { title: 'x', description: 'y', level: 'impossivel' })).status, 400);
  assert.equal((await admin.post('/api/admin/missions/import', { missions: [{ title: 'A', description: 'b', level: 'dificil' }] })).body.count, 1);
  assert.equal((await admin.del(`/api/admin/missions/${created.body.id}`)).body.deleted, true);
});

test('trocar missão restabelece pendência e respeita restrição romântica', async () => {
  const ov = (await admin.get('/api/admin/overview')).body;
  const quinzani = ov.participants.find((p) => p.name === 'Matheus Quinzani');
  assert.ok(quinzani.restrictedRomantic);
  for (const m of quinzani.missions) assert.equal(m.romantic, false);
  const target = quinzani.missions[0];
  assert.equal((await admin.post(`/api/admin/assignments/${target.id}/swap`, {})).status, 200);
  const after = (await admin.get('/api/admin/overview')).body.participants.find((p) => p.name === 'Matheus Quinzani');
  assert.notEqual(after.missions[0].missionId, target.missionId);
  assert.equal(after.missions[0].level, target.level);
});

test('encerrar partida bloqueia ações dos agentes', async () => {
  assert.equal((await admin.post('/api/admin/finish')).status, 200);
  const m = (await players.Baiano.get('/api/me')).body.missions[0];
  assert.equal((await players.Baiano.post(`/api/me/missions/${m.id}/complete`)).status, 409);
});

test('segurança: arquivos estáticos não escapam do diretório e cookie é HttpOnly', async () => {
  const r = await fetch(base + '/..%2fserver%2fconfig.js');
  const txt = await r.text();
  assert.ok(!txt.includes('loadConfig'));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: ADMIN }) });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cross = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('senhas ficam hasheadas no banco (não em texto puro)', () => {
  const rows = app.db.prepare('SELECT pw_hash, pw_enc FROM participants').all();
  const plain = overview.participants.map((p) => p.password);
  for (const r of rows) {
    assert.match(r.pw_hash, /^scrypt\$/);
    assert.ok(!plain.some((pw) => r.pw_hash.includes(pw) || r.pw_enc.includes(pw)));
  }
});
