import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { drawMissions, DrawError } from '../server/draw.js';

const NAMES = { 'Murillo Moya': 1, 'Matheus Quinzani': 2, Baiano: 3, 'Vovô Slavic': 4, 'Bruno Picarelli': 5, 'Henrique Gomiero': 6, 'Felipe Gomiero': 7, 'Matheus Italiano': 8, 'Leo Laurentino': 9 };
const RESTRICTED = [2, 5, 8];
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, restricted: RESTRICTED.includes(i + 1) }));
const catalog = (n) => JSON.parse(fs.readFileSync(new URL('../server/seed/missions.json', import.meta.url)))
  .map((m, i) => ({ id: i + 1, ...m, romantic: !!m.romantic, target: m.target === '*' || !m.target ? (m.target ?? null) : NAMES[m.target] }))
  .filter((m) => typeof m.target !== 'number' || m.target <= n);

for (const n of [9, 8]) {
  test(`${n} agentes: 3 desafios por agente, sem repetir, sem o próprio nome`, () => {
    const ppl = people(n), cat = catalog(n);
    for (let run = 0; run < 10; run++) {
      const { picks } = drawMissions({ fill: ppl, everyone: ppl, missions: cat });
      assert.equal(picks.length, n * 3);
      assert.equal(new Set(picks.map((p) => p.missionId)).size, n * 3);
      for (const p of ppl) {
        const mine = picks.filter((x) => x.participantId === p.id);
        assert.deepEqual(mine.map((x) => x.position).sort(), [1, 2, 3]);
        assert.ok(mine.every((x) => x.targetId !== p.id), 'alvo nunca é o dono');
      }
      for (const pick of picks) {
        const m = cat.find((x) => x.id === pick.missionId);
        const who = ppl.find((x) => x.id === pick.participantId);
        assert.ok(!(who.restricted && m.romantic), 'restritos sem flerte');
        if (m.target === '*') assert.ok(typeof pick.targetId === 'number');
      }
    }
  });
}

test('pontuação total fica equilibrada entre os agentes', () => {
  const ppl = people(9);
  const { picks } = drawMissions({ fill: ppl, everyone: ppl, missions: catalog(9) });
  const totals = ppl.map((p) => picks.filter((x) => x.participantId === p.id).reduce((s, x) => s + x.points, 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 2, `totais: ${totals}`);
});

test('catálogo insuficiente gera erro claro', () => {
  const ppl = people(9);
  assert.throws(() => drawMissions({ fill: ppl, everyone: ppl, missions: catalog(9).slice(0, 5) }), DrawError);
});
