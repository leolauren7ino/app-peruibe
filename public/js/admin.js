import { h, sheet, closeSheet, sheetIsOpen, toast, busy, statusChip, fmtDate, rankingList, confirmSheet, tier, dayLabel, CATEGORY } from './dom.js';
import { get, post, patch, del } from './api.js';

const STATUS_LABEL = { setup: 'PREPARAÇÃO', active: 'EM ANDAMENTO', finished: 'ENCERRADA' };
const EVENT_LABEL = {
  sorteio_duplo: '🎲 Sorteou o Agente Duplo', sorteio_missoes: '🎲 Sorteou as missões', inicio: '▶ Operação iniciada',
  enviada: '📨 Enviou para análise', desfeita: '↩ Desfez o envio', concluida: '✅ Concluiu (automático)', confirmada: '✅ Confirmada',
  devolvida: '↩ Devolvida', resetada: '♻ Resetada', troca: '🔀 Missão trocada', encerrada: '🏁 Partida encerrada',
  agente_removido: '🗑 Agente removido', missoes_novo_agente: '🎲 Missões do novo agente', passe: '🎫 Usou ficha de passe',
  flagrante_denuncia: '🚨 Denunciou flagrante', flagrante: '🚨 Flagrante aceito', ajuste: '± Ajuste de pontos', dia_liberado: '🔓 Dia liberado',
};

export function startAdmin(root, logout) {
  const st = { tab: 'ops', data: null, catalog: null, events: null, filter: 'todas', open: new Set() };
  const main = h('main');
  const nav = h('nav', { class: 'nav' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, 'COMANDO ', h('b', {}, 'LOW PROFILE')), h('button', { onclick: logout }, 'SAIR')), main), nav);

  const TABS = [['ops', '🎯', 'Operação'], ['agents', '🕵️', 'Agentes'], ['missions', '📁', 'Missões'], ['ranking', '🏆', 'Ranking'], ['log', '🧾', 'Log']];

  async function load() {
    st.data = await get('/api/admin/overview');
    if (st.tab === 'missions') st.catalog = await get('/api/admin/missions');
    if (st.tab === 'log') st.events = (await get('/api/admin/events')).events;
  }
  function render() {
    nav.replaceChildren(...TABS.map(([id, icon, label]) => h('button', { class: st.tab === id ? 'on' : '', onclick: () => select(id) }, h('span', {}, icon), label)));
    const view = { ops: opsView, agents: agentsView, missions: missionsView, ranking: rankingView, log: logView }[st.tab];
    main.replaceChildren(st.data ? view() : h('div', { class: 'empty' }, 'CARREGANDO…'));
  }
  async function select(tab) {
    st.tab = tab;
    try { await load(); } catch (e) { toast(e.message, 'err'); }
    render();
    window.scrollTo(0, 0);
  }
  /** Executa uma ação do admin, avisa e recarrega a tela. */
  const act = (btn, fn, okMsg) => busy(btn, async () => { await fn(); if (okMsg) toast(okMsg, 'ok'); await load(); render(); });

  const noGame = () => h('div', {}, h('div', { class: 'empty' }, 'NENHUMA PARTIDA CRIADA'), newGameButton());

  function newGameButton(label = '＋ Nova partida') {
    return h('button', { class: 'btn', onclick: () => {
      const name = h('input', { type: 'text', placeholder: 'Ex.: Operação Peruíbe 2027', value: '' });
      const copy = h('input', { type: 'checkbox', checked: true });
      const go = h('button', { class: 'btn primary', onclick: () => act(go, async () => {
        await post('/api/admin/games', { name: name.value, copyParticipants: copy.checked }); closeSheet();
      }, 'Partida criada') }, 'Criar partida');
      sheet('Nova partida', h('p', { class: 'muted' }, 'A partida atual (se houver) será encerrada.'),
        h('label', {}, 'Nome'), name, h('label', { class: 'check' }, copy, 'Manter os mesmos agentes e senhas'), go);
    } }, label);
  }

  // ---- Operação ---------------------------------------------------------------------------------------
  function opsView() {
    const d = st.data;
    if (!d.game) return noGame();
    const g = d.game;
    const ask = (msg, fn, ok, danger) => async (e) => { if (await confirmSheet(msg, { ok: 'Sim', danger })) act(e.target, fn, ok); };
    const when = (n) => dayLabel(g.startDate, n);

    const controls = [];
    if (g.status === 'setup') {
      controls.push(
        h('div', { class: 'row' },
          g.doubleEnabled && h('button', { class: 'btn', onclick: (e) => act(e.target, () => post('/api/admin/draw/double'), 'Agente Duplo sorteado') }, '🎲 Sortear duplo'),
          h('button', { class: 'btn', onclick: (e) => act(e.target, () => post('/api/admin/draw/missions'), 'Desafios sorteados') }, '🎲 Sortear desafios')),
        h('button', { class: 'btn primary', onclick: ask('Iniciar a operação? Isso TRAVA o sorteio e libera o desafio do dia 1 para todos.', () => post('/api/admin/start'), 'Operação iniciada!') }, '▶ Iniciar operação'));
    } else if (g.status === 'active') {
      const next = g.unlockedDay + 1;
      controls.push(
        h('div', { class: 'card' }, h('div', { class: 'muted mono', style: 'font-size:12px' }, 'DESAFIOS LIBERADOS'),
          h('b', {}, `Dia ${g.unlockedDay} de 3 · ${when(g.unlockedDay)}`),
          next <= 3 && h('button', { class: 'btn primary', onclick: ask(`Liberar os desafios do dia ${next} (${when(next)}) para todos os agentes?`, () => post('/api/admin/day', { day: next }), `Dia ${next} liberado`) }, `🔓 Liberar dia ${next} · ${when(next)}`)),
        h('button', { class: 'btn danger', onclick: ask('Encerrar a partida? Os desafios de todo mundo são revelados e ninguém mais envia nada.', () => post('/api/admin/finish'), 'Partida encerrada', true) }, '🏁 Encerrar e revelar'));
    } else controls.push(newGameButton());

    const start = h('input', { type: 'date', value: g.startDate || '' });
    const auto = h('input', { type: 'checkbox', checked: g.autoConfirm });
    const dbl = h('input', { type: 'checkbox', checked: g.doubleEnabled, disabled: g.status !== 'setup' });
    const save = h('button', { class: 'btn', onclick: () => act(save, () => patch('/api/admin/game', { startDate: start.value, autoConfirm: auto.checked, doubleEnabled: dbl.checked }), 'Configurações salvas') }, 'Salvar configurações');

    return h('div', {},
      h('div', { class: 'row between', style: 'margin-top:16px' }, h('h1', { style: 'font-size:20px' }, g.name), h('span', { class: 'chip red' }, STATUS_LABEL[g.status])),
      g.doubleEnabled && h('div', { class: 'card red double-banner', style: 'margin-top:12px' }, h('small', {}, '🕵️‍♂️ AGENTE DUPLO · SÓ VOCÊ VÊ'),
        h('b', {}, d.doubleAgent ? d.doubleAgent.name : '— ainda não sorteado —')),
      h('div', { style: 'margin-top:12px' }), ...controls,
      d.flagrantes.length > 0 && h('h2', {}, `🚨 Flagrantes (${d.flagrantes.length})`),
      d.flagrantes.map(flagranteCard),
      d.pending.length > 0 && h('h2', {}, `🔎 Em análise (${d.pending.length})`),
      d.pending.map(pendingCard),
      h('h2', {}, 'Agentes e desafios'),
      d.participants.map(participantCard),
      h('h2', {}, 'Configurações'),
      h('div', { class: 'card' },
        h('label', {}, 'Data da sexta (dia 1)'), start,
        h('label', { class: 'check' }, auto, 'Aprovar automaticamente (sem fila de análise)'),
        h('label', { class: 'check' }, dbl, 'Usar Agente Duplo (lê todos os desafios; desligado por padrão)'), save,
        h('p', { class: 'muted', style: 'font-size:13px' }, 'A pontuação é de cada desafio (1, 2, 3 ou 5) e se edita na aba Missões. O Agente Duplo só liga/desliga antes de iniciar.')),
      g.status !== 'finished' && h('div', {}, newGameButton('＋ Nova partida (encerra a atual)')));
  }

  function flagranteCard(f) {
    return h('div', { class: 'card red' },
      h('div', {}, h('b', {}, f.accuserName), ' acusa ', h('b', {}, f.accusedName)),
      h('div', { class: 'mini' }, h('div', { class: 'd' }, `💬 ${f.guess}`)),
      h('div', { class: 'muted mono', style: 'font-size:12px' }, 'DESAFIOS EM ABERTO DO ACUSADO — TOQUE NO QUE FOI DESCOBERTO:'),
      f.candidates.length === 0 && h('div', { class: 'muted' }, 'Nenhum desafio em aberto.'),
      f.candidates.map((m) => h('div', { class: 'mini' }, h('div', { class: 't' }, `${tier(m.points).icon} Dia ${m.day} · ${m.title}`), h('div', { class: 'd' }, m.description),
        h('button', { class: 'btn small primary', onclick: async (e) => {
          if (await confirmSheet(`Aceitar o flagrante? ${f.accusedName} perde "${m.title}" e ${f.accuserName} ganha 1 ponto.`, { ok: 'Aceitar' })) {
            act(e.target, () => post(`/api/admin/flagrantes/${f.id}/accept`, { assignmentId: m.id }), 'Flagrante aceito');
          }
        } }, '🚨 Foi esse'))),
      h('button', { class: 'btn', onclick: (e) => act(e.target, () => post(`/api/admin/flagrantes/${f.id}/reject`), 'Flagrante recusado') }, '✖ Recusar flagrante'));
  }

  function pendingCard(m) {
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('b', {}, m.participantName), h('span', { class: 'chip' }, `${m.points} pt${m.points > 1 ? 's' : ''}`)),
      h('div', { class: 'mini' }, h('div', { class: 't' }, `${tier(m.points).icon} Dia ${m.day} · ${m.title}`), h('div', { class: 'd' }, m.description),
        m.note && h('div', {}, `💬 ${m.note}`), h('div', { class: 'muted mono', style: 'font-size:11px' }, `Enviado ${fmtDate(m.submittedAt)}`)),
      m.hasEvidence && h('img', { class: 'ev-thumb', src: `/api/admin/assignments/${m.id}/evidence`, alt: 'evidência', loading: 'lazy',
        onclick: () => sheet(m.title, h('img', { class: 'ev', src: `/api/admin/assignments/${m.id}/evidence`, alt: 'evidência' }), h('button', { class: 'btn', onclick: closeSheet }, 'Fechar')) }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: (e) => act(e.target, () => post(`/api/admin/assignments/${m.id}/confirm`), 'Confirmado') }, '✔ Confirmar'),
        h('button', { class: 'btn', onclick: () => {
          const msg = h('input', { type: 'text', placeholder: 'Motivo (opcional)', maxlength: 200 });
          const go = h('button', { class: 'btn danger', onclick: () => act(go, async () => { await post(`/api/admin/assignments/${m.id}/reject`, { message: msg.value }); closeSheet(); }, 'Devolvido') }, '↩ Devolver ao agente');
          sheet('Devolver desafio', h('label', {}, 'Mensagem para o agente'), msg, go);
        } }, '↩ Devolver')));
  }

  function participantCard(p) {
    const key = `p${p.id}`;
    const box = h('div', { class: st.open.has(key) ? '' : 'hidden' }, p.missions.map((m) => missionRow(m, p)),
      h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => adjustPoints(p) }, '± Ajustar pontos'));
    const s = p.stats;
    return h('div', { class: 'card' },
      h('div', { class: 'acc-head', onclick: () => { box.classList.toggle('hidden'); st.open.has(key) ? st.open.delete(key) : st.open.add(key); } },
        h('div', {}, h('b', {}, p.isDouble ? '🕵️‍♂️ ' : '', p.name), h('div', { class: 'muted mono', style: 'font-size:12px' }, `${s.points} pts · ${s.done}/${s.total} · passes ${s.passesUsed}/2${s.adjustments ? ` · ajuste ${s.adjustments > 0 ? '+' : ''}${s.adjustments}` : ''}`)),
        h('span', { class: 'chip' }, 'VER')),
      box);
  }

  function adjustPoints(p) {
    const pts = h('input', { type: 'number', value: -1, inputmode: 'numeric' });
    const reason = h('input', { type: 'text', placeholder: 'Ex.: fugiu sem ficha de passe', maxlength: 120, value: 'Fugiu sem ficha de passe' });
    const go = h('button', { class: 'btn primary', onclick: () => act(go, async () => { await post(`/api/admin/participants/${p.id}/adjust`, { points: Number(pts.value), reason: reason.value }); closeSheet(); }, 'Pontos ajustados') }, 'Aplicar');
    sheet(`Ajustar pontos de ${p.name}`, h('label', {}, 'Pontos (negativo tira)'), pts, h('label', {}, 'Motivo'), reason, go);
  }

  function missionRow(m, p) {
    const closed = ['flagrante', 'passe'].includes(m.status);
    return h('div', { class: 'mini' },
      h('div', { class: 'row between' }, h('span', { class: 't' }, `${tier(m.points).icon} Dia ${m.day} · ${m.title}`), statusChip(m.status)),
      h('div', { class: 'd' }, m.description),
      h('div', { class: 'row' },
        !closed && m.status !== 'concluida' && h('button', { class: 'btn small primary', onclick: (e) => act(e.target, () => post(`/api/admin/assignments/${m.id}/confirm`), 'Confirmado') }, '✔ Confirmar'),
        m.status !== 'pendente' && h('button', { class: 'btn small', onclick: async (e) => { if (await confirmSheet(`Resetar "${m.title}" de ${p.name}? Apaga evidência e pontos.`, { ok: 'Resetar', danger: true })) act(e.target, () => post(`/api/admin/assignments/${m.id}/reset`), 'Desafio resetado'); } }, '♻ Resetar'),
        m.status !== 'concluida' && h('button', { class: 'btn small', onclick: async (e) => { if (await confirmSheet(`Trocar "${m.title}" por outro desafio do catálogo, de pontuação parecida?`, { ok: 'Trocar' })) act(e.target, () => post(`/api/admin/assignments/${m.id}/swap`), 'Desafio trocado'); } }, '🔀 Trocar')));
  }

  // ---- Agentes -----------------------------------------------------------------------------------------
  function agentsView() {
    const d = st.data;
    if (!d.game) return noGame();
    const name = h('input', { type: 'text', placeholder: 'Nome completo' });
    const nick = h('input', { type: 'text', placeholder: 'Apelido (opcional)' });
    const restricted = h('input', { type: 'checkbox' });
    const add = h('button', { class: 'btn primary', onclick: () => act(add, async () => {
      const r = await post('/api/admin/participants', { name: name.value, nickname: nick.value, restrictedRomantic: restricted.checked });
      toast(`Senha de ${name.value}: ${r.password}`, 'ok');
    }) }, '＋ Adicionar agente');
    return h('div', {},
      h('h2', {}, 'Novo agente'),
      h('div', { class: 'card' }, h('label', {}, 'Nome'), name, h('label', {}, 'Apelido'), nick,
        h('label', { class: 'check' }, restricted, 'Sem missões de flerte/ficar (relacionamento sério)'), add,
        d.game.status === 'active' && h('p', { class: 'muted', style: 'font-size:13px' }, 'Com a operação em andamento, o novo agente recebe 3 missões na hora e ninguém mais muda.'),
        d.game.status === 'setup' && h('p', { class: 'muted', style: 'font-size:13px' }, 'Depois de mudar a lista de agentes, refaça o sorteio antes de iniciar.')),
      h('h2', {}, `Agentes e senhas (${d.participants.length})`),
      d.participants.map(agentCard));
  }

  function agentCard(p) {
    const pw = h('button', { class: 'pw', onclick: () => { pw.textContent = pw.dataset.shown ? '•••• •••• ••  (toque para ver)' : p.password; pw.dataset.shown = pw.dataset.shown ? '' : '1'; } }, '•••• •••• ••  (toque para ver)');
    const msg = `🕶️ PERUÍBE LOW PROFILE\nAgente: ${p.name}\nSenha: ${p.password}\nAcesso: ${location.origin}\n\nNinguém confia em ninguém.`;
    return h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {}, h('b', {}, p.isDouble && '🕵️‍♂️ ', p.name), p.nickname && h('span', { class: 'muted' }, ` “${p.nickname}”`)),
        p.restrictedRomantic && h('span', { class: 'chip' }, 'sem flerte')),
      pw,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(p.password).then(() => toast('Senha copiada', 'ok')).catch(() => toast(p.password)) }, '📋 Copiar'),
        h('a', { class: 'btn small', style: 'text-decoration:none;color:inherit', target: '_blank', rel: 'noopener', href: `https://wa.me/?text=${encodeURIComponent(msg)}` }, '💬 WhatsApp'),
        h('button', { class: 'btn small', onclick: () => editAgent(p) }, '✏ Editar')));
  }

  function editAgent(p) {
    const name = h('input', { type: 'text', value: p.name });
    const nick = h('input', { type: 'text', value: p.nickname || '' });
    const restricted = h('input', { type: 'checkbox', checked: p.restrictedRomantic });
    const pass = h('input', { type: 'text', placeholder: 'Deixe vazio para manter', autocapitalize: 'characters' });
    const save = h('button', { class: 'btn primary', onclick: () => act(save, async () => {
      await patch(`/api/admin/participants/${p.id}`, { name: name.value, nickname: nick.value, restrictedRomantic: restricted.checked, password: pass.value || undefined });
      closeSheet();
    }, 'Agente atualizado') }, 'Salvar');
    const regen = h('button', { class: 'btn', onclick: () => act(regen, async () => {
      const r = await patch(`/api/admin/participants/${p.id}`, { regeneratePassword: true }); closeSheet(); toast(`Nova senha: ${r.password}`, 'ok');
    }) }, '🔑 Gerar nova senha');
    const remove = h('button', { class: 'btn danger', onclick: async () => {
      if (await confirmSheet(`Remover ${p.name}? As missões dele(a) voltam ao catálogo.${p.isDouble ? ' ELE(A) É O AGENTE DUPLO: será preciso sortear outro.' : ''}`, { ok: 'Remover', danger: true })) {
        act(remove, () => del(`/api/admin/participants/${p.id}`), 'Agente removido');
      }
    } }, '🗑 Remover agente');
    sheet(`Editar ${p.name}`, h('label', {}, 'Nome'), name, h('label', {}, 'Apelido'), nick,
      h('label', { class: 'check' }, restricted, 'Sem missões de flerte/ficar'), h('label', {}, 'Nova senha (opcional)'), pass, save, regen, remove);
  }

  // ---- Missões (catálogo) --------------------------------------------------------------------------------------
  function missionsView() {
    if (!st.catalog) return h('div', { class: 'empty' }, 'CARREGANDO…');
    const FILTERS = [['todas', 'Todas'], ['1', '🟢 1 pt'], ['2', '🟡 2 pts'], ['3', '🔴 3 pts'], ['5', '☠️ 5 pts'], ['inativas', 'Inativas']];
    const list = st.catalog.missions.filter((m) => st.filter === 'todas' ? m.active : st.filter === 'inativas' ? !m.active : m.active && String(m.points) === st.filter);
    return h('div', {},
      h('button', { class: 'btn primary', onclick: () => editMission(null) }, '＋ Novo desafio'),
      h('button', { class: 'btn', onclick: importMissions }, '⬆ Importar lista (JSON)'),
      h('div', { class: 'filters', style: 'margin-top:14px' }, FILTERS.map(([id, label]) => h('button', { class: `btn small ${st.filter === id ? 'on' : ''}`, onclick: () => { st.filter = id; render(); } }, label))),
      h('p', { class: 'muted mono', style: 'font-size:11px' }, `${list.length} DESAFIOS · [ALVO] NA DESCRIÇÃO VIRA O NOME DO ALVO SORTEADO`),
      list.map((m) => h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('b', {}, `${tier(m.points).icon} ${m.title}`), h('span', { class: 'chip' }, `${m.points} pt${m.points > 1 ? 's' : ''}`)),
        h('div', { class: 'muted', style: 'font-size:14px;margin:6px 0' }, m.description),
        h('div', { class: 'row' }, h('span', { class: 'chip' }, CATEGORY[m.category] || m.category), m.target && h('span', { class: 'chip' }, m.target === '*' ? 'alvo sorteado' : `alvo: ${m.target}`),
          m.romantic && h('span', { class: 'chip red' }, 'flerte'), m.usedBy && h('span', { class: 'chip analise' }, `com ${m.usedBy}`)),
        h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => editMission(m) }, '✏ Editar'))));
  }

  function editMission(m) {
    const f = {
      title: h('input', { type: 'text', value: m?.title || '', maxlength: 80 }),
      description: h('textarea', { maxlength: 800 }, m?.description || ''),
      points: h('select', { value: String(m?.points ?? 2) }, ['1', '2', '3', '5'].map((n) => h('option', { value: n }, `${tier(Number(n)).icon} ${n} ponto${n === '1' ? '' : 's'} · ${tier(Number(n)).label}`))),
      category: h('select', { value: m?.category || 'social' }, st.catalog.categories.map((c) => h('option', { value: c }, CATEGORY[c] || c))),
      target: h('input', { type: 'text', value: m?.target || '', placeholder: 'vazio = sem alvo · * = sorteado · ou um nome' }),
      romantic: h('input', { type: 'checkbox', checked: m?.romantic }),
      active: h('input', { type: 'checkbox', checked: m ? m.active : true }),
    };
    const body = () => ({ title: f.title.value, description: f.description.value, points: Number(f.points.value), category: f.category.value, target: f.target.value, romantic: f.romantic.checked, active: f.active.checked });
    const save = h('button', { class: 'btn primary', onclick: () => act(save, async () => {
      m ? await patch(`/api/admin/missions/${m.id}`, body()) : await post('/api/admin/missions', body());
      closeSheet(); st.catalog = await get('/api/admin/missions');
    }, 'Desafio salvo') }, 'Salvar');
    const remove = m && h('button', { class: 'btn danger', onclick: () => act(remove, async () => {
      const r = await del(`/api/admin/missions/${m.id}`); closeSheet(); st.catalog = await get('/api/admin/missions');
      toast(r.deactivated ? 'Já usado: desativado' : 'Desafio apagado', 'ok');
    }) }, '🗑 Apagar / desativar');
    sheet(m ? 'Editar desafio' : 'Novo desafio', h('label', {}, 'Nome'), f.title, h('label', {}, 'Descrição (use [ALVO])'), f.description,
      h('label', {}, 'Pontuação'), f.points, h('label', {}, 'Categoria'), f.category, h('label', {}, 'Alvo'), f.target,
      h('label', { class: 'check' }, f.romantic, 'Envolve flerte (não vai para quem tem restrição)'),
      h('label', { class: 'check' }, f.active, 'Ativo no sorteio'), save, remove);
  }

  function importMissions() {
    const ta = h('textarea', { style: 'min-height:200px;font-family:var(--mono);font-size:13px', placeholder: '[{"title":"...","description":"... [ALVO] ...","points":2,"category":"social","target":"*"}]' });
    const go = h('button', { class: 'btn primary', onclick: () => act(go, async () => {
      let missions;
      try { missions = JSON.parse(ta.value); } catch { throw new Error('JSON inválido.'); }
      const r = await post('/api/admin/missions/import', { missions });
      closeSheet(); st.catalog = await get('/api/admin/missions'); toast(`${r.count} missões importadas`, 'ok');
    }) }, 'Importar');
    sheet('Importar missões', h('p', { class: 'muted' }, 'Cole uma lista JSON. Campos: title, description, points (1, 2, 3, 5), category, target, romantic.'), ta, go);
  }

  // ---- Ranking / Log ---------------------------------------------------------------------------------------------
  function rankingView() {
    const d = st.data;
    return h('div', {}, h('h2', {}, d.game?.status === 'finished' ? '🏁 Ranking final' : '🏆 Ranking Low Profile'), rankingList(d.ranking));
  }

  function logView() {
    if (!st.events) return h('div', { class: 'empty' }, 'CARREGANDO…');
    if (!st.events.length) return h('div', { class: 'empty' }, 'SEM REGISTROS');
    return h('div', {}, h('h2', {}, 'Registro de operações'), st.events.map((e) => h('div', { class: 'log' },
      h('b', {}, fmtDate(e.ts)), ` · ${e.participant_name ? e.participant_name + ' · ' : ''}${EVENT_LABEL[e.type] || e.type}`,
      e.mission_title && ` · ${e.mission_title}`, e.points != null && ` · ${e.points} pts`, e.detail && ` · ${e.detail}`)));
  }

  const tick = async () => {
    if (document.hidden || sheetIsOpen() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    try { await load(); render(); } catch { /* handler global cuida de 401 */ }
  };
  const timer = setInterval(tick, 15000);
  load().then(render).catch((e) => toast(e.message, 'err'));
  return () => { clearInterval(timer); closeSheet(); };
}
