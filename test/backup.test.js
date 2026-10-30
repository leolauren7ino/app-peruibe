import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createBackup } from '../server/backup.js';

// Gist falso em memória
const fakeGist = () => {
  const store = { files: {} };
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'PATCH') {
      Object.assign(store.files, Object.fromEntries(Object.entries(JSON.parse(opts.body).files).map(([k, v]) => [k, { content: v.content }])));
      return { ok: true, status: 200, json: async () => store };
    }
    return { ok: true, status: 200, json: async () => store };
  };
  return { store, fetchImpl };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peruibe-bk-'));

test('backup: o jogo sobrevive a um servidor com disco novo', async () => {
  const gist = fakeGist();
  const mkCfg = (dir) => ({ dataDir: dir, adminPassword: 'adm-teste', appSecret: 'segredo-teste', port: 0, backupDelayMs: 50 });
  const patchBackup = (cfg) => ({ ...cfg, backup: { gistId: 'g', token: 't' } });

  // monkey: injeta o fetch falso via global (createApp usa fetch global por padrão)
  const realFetch = globalThis.fetch;
  globalThis.fetch = gist.fetchImpl;
  try {
    const a = await createApp(patchBackup(mkCfg(tmp())));
    const gameA = a.db.prepare('SELECT * FROM games ORDER BY id DESC LIMIT 1').get();
    const firstPw = a.db.prepare('SELECT pw_enc FROM participants WHERE game_id = ? ORDER BY id LIMIT 1').get(gameA.id).pw_enc;
    a.db.prepare("UPDATE games SET name = 'Jogo Salvo' WHERE id = ?").run(gameA.id);
    await a.close(); // flush
    assert.ok(gist.store.files['peruibe.db.b64'].content.length > 1000);

    // "servidor novo": diretório vazio, mesmo Gist
    const b = await createApp(patchBackup(mkCfg(tmp())));
    const gameB = b.db.prepare('SELECT * FROM games ORDER BY id DESC LIMIT 1').get();
    assert.equal(gameB.name, 'Jogo Salvo');
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n, 9);
    assert.equal(b.db.prepare('SELECT pw_enc FROM participants ORDER BY id LIMIT 1').get().pw_enc, firstPw);
    assert.ok(b.notes.some((n) => /restaurado/i.test(n)));
    await b.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('backup: se o GitHub não responder, o app NÃO sobe com banco novo por cima do salvo', async () => {
  const failing = createBackup({ gistId: 'g', token: 't', dbFile: path.join(tmp(), 'x.db'), fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => failing.restoreIfMissing(), /503/);
});

test('backup: Gist vazio (recém-criado) não conta como banco', async () => {
  const dbFile = path.join(tmp(), 'x.db');
  const b = createBackup({ gistId: 'g', token: 't', dbFile, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ files: { 'peruibe.db.b64': { content: 'x' } } }) }) });
  assert.equal(await b.restoreIfMissing(), 'empty');
  assert.equal(fs.existsSync(dbFile), false);
});
