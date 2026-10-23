import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMissions, DrawError } from '../server/draw.js';
import fs from 'node:fs';

const people = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, restricted: [2, 5, 8].includes(i + 1) }));
const catalog = JSON.parse(fs.readFileSync(new URL('../server/seed/missions.json', import.meta.url)))
  .map((m, i) => ({ id: i + 1, ...m, romantic: !!m.romantic, target: m.target === '*' || !m.target ? (m.target ?? null) : people.find((p) => p.id === 1)?.id }));

test('cada agente recebe 2 médias + 1 difícil, sem repetir missão nem alvo = si mesmo', () => {
  for (let run = 0; run < 30; run++) {
    const { picks } = drawMissions({ fill: people, everyone: people, missions: catalog });
    assert.equal(picks.length, 27);
    assert.equal(new Set(picks.map((p) => p.missionId)).size, 27);
    for (const p of people) {
      const mine = picks.filter((x) => x.participantId === p.id);
      assert.deepEqual(mine.map((x) => x.level).sort(), ['dificil', 'medio', 'medio']);
      assert.ok(mine.every((x) => x.targetId !== p.id));
    }
  }
});

test('agentes restritos nunca recebem missão romântica', () => {
  const rom = catalog.filter((m) => m.romantic);
  assert.ok(rom.length > 0);
  for (let run = 0; run < 50; run++) {
    const { picks } = drawMissions({ fill: people, everyone: people, missions: catalog });
    for (const pick of picks) {
      const m = catalog.find((x) => x.id === pick.missionId);
      const who = people.find((p) => p.id === pick.participantId);
      assert.ok(!(who.restricted && m.romantic));
    }
  }
});

test('esforço fica equilibrado entre agentes', () => {
  const { picks } = drawMissions({ fill: people, everyone: people, missions: catalog });
  const sums = people.map((p) => picks.filter((x) => x.participantId === p.id)
    .reduce((s, x) => s + catalog.find((m) => m.id === x.missionId).effort, 0));
  assert.ok(Math.max(...sums) - Math.min(...sums) <= 2, `esforços: ${sums}`);
});

test('catálogo insuficiente gera erro claro', () => {
  assert.throws(() => drawMissions({ fill: people, everyone: people, missions: catalog.slice(0, 5) }), DrawError);
});
