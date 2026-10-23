import crypto from 'node:crypto';

/**
 * Sorteio de missões — função pura (sem banco), para ser fácil de testar e ajustar.
 *
 * Regras duras: 1 difícil + 2 médias por agente; nenhuma missão repetida na partida;
 * ninguém é alvo da própria missão; agentes com `restricted` nunca recebem missões `romantic`.
 * Regras suaves (pontuadas e otimizadas em várias tentativas): esforço total parecido entre
 * agentes, alvos distribuídos por igual, sem repetir alvo/categoria para o mesmo agente.
 */
export class DrawError extends Error {}

export const SLOTS = [
  { level: 'medio', position: 1 },
  { level: 'dificil', position: 2 },
  { level: 'medio', position: 3 },
];

export const secureRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

export function shuffle(list, rng = secureRng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const variance = (xs) => {
  if (!xs.length) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
};

/** Escolhe o alvo de uma missão: null (sem alvo), id fixo, ou o menos "usado" quando target === '*'. */
export function pickTarget(mission, agent, everyone, load, avoid = new Set(), rng = secureRng) {
  if (mission.target == null) return null;
  if (mission.target !== '*') return mission.target === agent.id ? undefined : mission.target;
  const pool = everyone.filter((p) => p.id !== agent.id);
  if (!pool.length) return undefined;
  const cost = (p) => (load[p.id] || 0) + (avoid.has(p.id) ? 3 : 0) + rng() * 0.5;
  return pool.map((p) => [p, cost(p)]).sort((a, b) => a[1] - b[1])[0][0].id;
}

/**
 * @param fill      agentes que precisam de missões: [{ id, restricted }]
 * @param everyone  todos os agentes da partida (possíveis alvos): [{ id }]
 * @param missions  catálogo ativo: [{ id, level, category, romantic, effort, target }]
 *                  onde target é null | '*' | id do participante (já resolvido)
 * @param used      ids de missões já em uso na partida
 * @param targetLoad  quantas vezes cada participante já é alvo { [id]: n }
 */
export function drawMissions({ fill, everyone, missions, used = new Set(), targetLoad = {}, rng = secureRng, tries = 400 }) {
  const avail = missions.filter((m) => !used.has(m.id));
  for (const { level } of [SLOTS[0], SLOTS[1]]) {
    const need = fill.length * (level === 'medio' ? 2 : 1);
    const have = avail.filter((m) => m.level === level).length;
    if (have < need) {
      throw new DrawError(`Catálogo insuficiente: faltam ${need - have} missão(ões) ${level === 'medio' ? 'médias' : 'difíceis'} ativas.`);
    }
  }

  let best = null;
  for (let t = 0; t < tries; t++) {
    const taken = new Set();
    const load = { ...targetLoad };
    const picks = [];
    const effortOf = new Map();
    let dupCats = 0;
    let ok = true;

    for (const agent of shuffle(fill, rng)) {
      const myTargets = new Set();
      const myCats = new Set();
      // difícil primeiro: é o nível mais escasso
      for (const slot of [SLOTS[1], SLOTS[0], SLOTS[2]]) {
        let choice = null;
        let choiceCost = Infinity;
        for (const m of shuffle(avail.filter((x) => x.level === slot.level && !taken.has(x.id)), rng)) {
          if (agent.restricted && m.romantic) continue;
          const tid = pickTarget(m, agent, everyone, load, myTargets, rng);
          if (tid === undefined) continue;
          const cost = (tid != null ? (load[tid] || 0) * 2 + (myTargets.has(tid) ? 6 : 0) : 0)
            + (myCats.has(m.category) ? 3 : 0) + rng() * 1.5;
          if (cost < choiceCost) { choice = { m, tid }; choiceCost = cost; }
        }
        if (!choice) { ok = false; break; }
        const { m, tid } = choice;
        taken.add(m.id);
        if (tid != null) { load[tid] = (load[tid] || 0) + 1; myTargets.add(tid); }
        if (myCats.has(m.category)) dupCats++;
        myCats.add(m.category);
        effortOf.set(agent.id, (effortOf.get(agent.id) || 0) + (m.effort || 2));
        picks.push({ participantId: agent.id, missionId: m.id, targetId: tid, position: slot.position, level: m.level });
      }
      if (!ok) break;
    }
    if (!ok) continue;

    const score = variance([...effortOf.values()]) * 3
      + variance(everyone.map((p) => load[p.id] || 0)) * 2
      + dupCats * 0.5;
    if (!best || score < best.score) best = { picks, score };
  }
  if (!best) {
    throw new DrawError('Não foi possível sortear respeitando as regras (restrições românticas, alvos fixos). Cadastre mais missões.');
  }
  return best;
}
