import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

const opts = (dir) => ({ dataDir: dir, adminPassword: 'adm-teste', appSecret: 'segredo-teste', port: 0 });
const row = (app) => app.db.prepare("SELECT subtitle, body FROM announcements WHERE title = 'O CLÁSSICO'").get();

test('banco que já tinha o Clássico com Super Feras passa para Uno, uma vez só e sem pisar em edição', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peruibe-uno-'));
  let app = await createApp(opts(dir));
  // simula o banco antigo: texto de Super Feras e marcador de migração ausente
  app.db.prepare("UPDATE announcements SET subtitle = 'SUPER FERAS', body = ? WHERE title = 'O CLÁSSICO'").run('Vovô Slavic x Brunão se enfrentam em Super Feras. Quem ganhar controla o outro por todo o dia.');
  app.db.prepare("DELETE FROM settings WHERE key = 'classico_uno'").run();
  await app.close();

  app = await createApp(opts(dir));
  assert.deepEqual({ ...row(app) }, { subtitle: 'UNO', body: 'Vovô Slavic x Brunão se enfrentam no Uno. Quem ganhar controla o outro por todo o dia.' });

  // edição posterior do admin não é desfeita em novos reinícios
  app.db.prepare("UPDATE announcements SET body = 'Texto novo do admin' WHERE title = 'O CLÁSSICO'").run();
  await app.close();
  app = await createApp(opts(dir));
  assert.equal(row(app).body, 'Texto novo do admin');
  await app.close();
});

test('texto editado pelo admin antes da migração é preservado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peruibe-uno2-'));
  let app = await createApp(opts(dir));
  app.db.prepare("UPDATE announcements SET subtitle = 'SUPER FERAS', body = 'Texto do admin' WHERE title = 'O CLÁSSICO'").run();
  app.db.prepare("DELETE FROM settings WHERE key = 'classico_uno'").run();
  await app.close();
  app = await createApp(opts(dir));
  assert.deepEqual({ ...row(app) }, { subtitle: 'UNO', body: 'Texto do admin' });
  await app.close();
});
