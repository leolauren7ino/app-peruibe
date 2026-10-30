import crypto from 'node:crypto';

/**
 * Sorteio de desafios — função pura (sem banco), fácil de testar e ajustar.
 *
 * Cada agente recebe 3 desafios, um por dia (position = 1, 2, 3).
 * Regras duras (violação = sorteio inválido):
 *   - nenhum desafio repetido na partida;
 *   - ninguém recebe desafio que leve o próprio nome (alvo fixo = dono);
 *   - agentes com `restricted` não recebem desafios `romantic`;
 *   - desafios de 5+ pontos só no último dia.
 * Regras suaves (otimizadas): pontuação total parecida entre agentes, alvos fixos distribuídos
 * por igual, sem repetir o mesmo alvo ou categoria para o mesmo agente.
 * Alvos sorteados ([ALVO], target '*') são escolhidos no fim, nunca o dono.
 */
export class DrawError extends Error {}

export const DAYS = [1, 2, 3];
export const LAST_DAY = 3;
export const RISKY_POINTS = 5;
export const dayAllowed = (m, day) => (m.points >= RISKY_POINTS ? day === LAST_DAY : true);

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
 * @param fill        agentes que precisam de desafios: [{ id, restricted }]
 * @param everyone    todos os agentes da partida (possíveis alvos): [{ id }]
 * @param missions    catálogo ativo: [{ id, points, category, romantic, target }]
 *                    onde target é null | '*' | id do participante (já resolvido)
 * @param used        ids de missões já em uso na partida
 * @param targetLoad  quantas vezes cada participante já é alvo { [id]: n }
 * @param baseTotals  pontos já planejados dos agentes que NÃO estão em `fill` { [id]: n }
 */
export function drawMissions({ fill, everyone, missions, used = new Set(), targetLoad = {}, baseTotals = {}, rng = secureRng, restarts = 8, iterations = 5000 }) {
  const pool = missions.filter((m) => !used.has(m.id));
  const slots = fill.flatMap((p) => DAYS.map((day) => ({ p, day })));
  if (pool.length < slots.length) {
    throw new DrawError(`Catálogo insuficiente: faltam ${slots.length - pool.length} desafio(s) ativos (precisa de ${slots.length}, há ${pool.length}).`);
  }
  const lastSlots = slots.filter((s) => s.day === LAST_DAY).length;
  if (pool.filter((m) => m.points >= RISKY_POINTS).length > 0 && lastSlots === 0) { /* sem último dia: arriscados simplesmente não entram */ }

  const fixedLoad = (assign) => {
    const load = { ...targetLoad };
    for (const mi of assign) { const t = pool[mi].target; if (typeof t === 'number') load[t] = (load[t] || 0) + 1; }
    return load;
  };

  const evaluate = (assign) => {
    let violations = 0;
    const totals = new Map(fill.map((p) => [p.id, baseTotals[p.id] || 0]));
    const seenTargets = new Map();
    const seenCats = new Map();
    let dups = 0;
    assign.forEach((mi, si) => {
      const { p, day } = slots[si];
      const m = pool[mi];
      if (!dayAllowed(m, day)) violations++;
      if (p.restricted && m.romantic) violations++;
      if (m.target === p.id) violations++;
      totals.set(p.id, totals.get(p.id) + m.points);
      if (typeof m.target === 'number') {
        const k = `${p.id}:${m.target}`;
        if (seenTargets.has(k)) dups += 3;
        seenTargets.set(k, 1);
      }
      const ck = `${p.id}:${m.category}`;
      if (seenCats.has(ck)) dups += 0.5;
      seenCats.set(ck, 1);
    });
    const others = Object.entries(baseTotals).filter(([id]) => !fill.some((p) => p.id === Number(id))).map(([, v]) => v);
    const load = fixedLoad(assign);
    const score = variance([...totals.values(), ...others]) * 4 + variance(everyone.map((p) => load[p.id] || 0)) + dups;
    return { violations, score, cost: violations * 1000 + score };
  };

  let best = null;
  for (let r = 0; r < restarts; r++) {
    // arriscados primeiro nos slots do último dia; o resto embaralhado
    const order = shuffle(pool.map((_, i) => i), rng);
    const assign = new Array(slots.length).fill(-1);
    const free = [];
    const risky = order.filter((i) => pool[i].points >= RISKY_POINTS);
    const rest = order.filter((i) => pool[i].points < RISKY_POINTS);
    const lastIdx = shuffle(slots.map((s, i) => (s.day === LAST_DAY ? i : -1)).filter((i) => i >= 0), rng);
    for (const si of lastIdx) if (risky.length) assign[si] = risky.shift();
    free.push(...risky, ...rest);
    for (let si = 0; si < assign.length; si++) if (assign[si] < 0) assign[si] = free.shift();
    const unused = new Set(free);

    let cur = evaluate(assign);
    for (let it = 0; it < iterations; it++) {
      const temp = 3 * (1 - it / iterations) + 0.01;
      const i = Math.floor(rng() * assign.length);
      let undo;
      if (unused.size && rng() < 0.35) {
        const pick = [...unused][Math.floor(rng() * unused.size)];
        const old = assign[i];
        assign[i] = pick; unused.delete(pick); unused.add(old);
        undo = () => { assign[i] = old; unused.delete(old); unused.add(pick); };
      } else {
        const k = Math.floor(rng() * assign.length);
        if (k === i) continue;
        [assign[i], assign[k]] = [assign[k], assign[i]];
        undo = () => { [assign[i], assign[k]] = [assign[k], assign[i]]; };
      }
      const next = evaluate(assign);
      if (next.cost <= cur.cost || rng() < Math.exp((cur.cost - next.cost) / temp)) cur = next;
      else undo();
      if (cur.violations === 0 && (!best || cur.score < best.score)) best = { assign: assign.slice(), score: cur.score };
    }
  }
  if (!best) {
    throw new DrawError('Não foi possível sortear respeitando as regras (alvos fixos, restrições de flerte, desafios de 5 pontos só no último dia). Cadastre mais desafios.');
  }

  // alvos sorteados: distribui entre todos, nunca o dono, evitando repetir para o mesmo agente
  const load = fixedLoad(best.assign);
  const mine = new Map();
  const picks = shuffle(best.assign.map((mi, si) => ({ mi, si })), rng).map(({ mi, si }) => {
    const { p, day } = slots[si];
    const m = pool[mi];
    const avoid = mine.get(p.id) || new Set();
    const tid = pickTarget(m, p, everyone, load, avoid, rng);
    if (tid === undefined) throw new DrawError('Não há alvo possível para um dos desafios. Cadastre mais agentes.');
    if (tid != null) {
      if (m.target === '*') load[tid] = (load[tid] || 0) + 1;
      mine.set(p.id, avoid.add(tid));
    }
    return { participantId: p.id, missionId: m.id, targetId: tid, position: day, points: m.points };
  });
  return { picks, score: best.score };
}
