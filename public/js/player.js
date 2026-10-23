import { h, sheet, closeSheet, sheetIsOpen, toast, busy, statusChip, fmtDate, imageToDataUrl, rankingList, LEVEL, CATEGORY } from './dom.js';
import { get, post } from './api.js';

const RULES = [
  ['🤝', 'Consentimento sempre', 'Ninguém é obrigado a participar: nem agente, nem funcionário, nem desconhecido. Ouviu um "não"? Agradeça e siga.'],
  ['🍻', 'Bebida é opcional', 'Nenhuma missão exige álcool nem quantidade. Vale água, suco ou o que você quiser. Nunca dirija depois de beber.'],
  ['🚫', 'Nada de risco', 'Sem fogo, sem perigo, sem invadir lugar fechado. Se alguém puder se machucar, não é missão.'],
  ['📸', 'Fotos com respeito', 'Só fotografe quem topar. Apague se a pessoa pedir.'],
  ['😂', 'Zoeira com limite', 'A graça é o grupo rir junto. Nada de constranger, assediar ou expor ninguém.'],
  ['🎭', 'Blefe liberado', 'Mentir pro jogo vale. Mentir pra machucar não.'],
  ['🔐', 'Seu pacote é secreto', 'Não mostre sua tela. Ninguém confia em ninguém.'],
];

export function startPlayer(root, logout) {
  const st = { tab: 'missions', me: null, ranking: null, central: null, revealed: false };
  let revealTimer;
  const main = h('main');
  const nav = h('nav', { class: 'nav' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, 'PERUÍBE ', h('b', {}, 'LOW PROFILE')), h('button', { onclick: logout }, 'SAIR')),
    main), nav);

  const tabs = () => [
    ['missions', '📁', 'Missões'], ['ranking', '🏆', 'Ranking'], ['rules', '📜', 'Regras'],
    ...(st.me?.role === 'AGENTE_DUPLO' ? [['central', '🔒', 'Cofre']] : []),
  ];

  async function load() {
    st.me = await get('/api/me');
    if (st.tab === 'ranking') st.ranking = (await get('/api/ranking')).ranking;
    if (st.tab === 'central') st.central = (await get('/api/double/overview')).agents;
  }

  function render() {
    nav.replaceChildren(...tabs().map(([id, icon, label]) =>
      h('button', { class: st.tab === id ? 'on' : '', onclick: () => select(id) }, h('span', {}, icon), label)));
    const view = { missions: missionsView, ranking: rankingView, rules: rulesView, central: centralView }[st.tab];
    main.replaceChildren(view());
  }

  async function select(tab) {
    st.tab = tab;
    try { await load(); } catch (e) { toast(e.message, 'err'); }
    render();
    window.scrollTo(0, 0);
  }

  // ---- Missões --------------------------------------------------------------------------------
  function missionsView() {
    const { me } = st;
    if (me.game.status === 'setup') {
      return h('div', { class: 'wait' }, h('div', { class: 'big' }, '⏳'), h('h1', {}, 'Briefing em preparação'),
        h('p', { class: 'muted mono' }, 'A OPERAÇÃO AINDA NÃO COMEÇOU.\nSEU PACOTE SERÁ LIBERADO PELO COMANDO.'));
    }
    const s = me.stats;
    const roleBtn = h('button', { class: `role ${st.revealed ? 'shown' : ''}`, onclick: toggleRole },
      st.revealed
        ? `🕵️ Seu papel: ${me.role === 'AGENTE_DUPLO' ? 'AGENTE DUPLO' : 'AGENTE SECRETO'}`
        : '👁 TOQUE PARA VER SEU PAPEL (some em 6s)');
    return h('div', {},
      h('div', { class: 'welcome' }, h('h1', {}, 'Bem-vindo, agente.'), h('div', { class: 'who' }, me.name.toUpperCase())),
      roleBtn,
      h('div', { class: 'score' },
        h('div', {}, h('b', {}, s.points), h('small', {}, 'Pontos')),
        h('div', {}, h('b', {}, `${s.done}/${s.total}`), h('small', {}, 'Concluídas')),
        h('div', {}, h('b', {}, `${s.percent}%`), h('small', {}, 'Progresso'))),
      h('div', { class: 'bar' }, h('i', { style: `width:${s.percent}%` })),
      me.game.status === 'finished' && h('div', { class: 'card red', style: 'margin-top:14px' }, h('b', {}, '🏁 OPERAÇÃO ENCERRADA'), h('div', { class: 'muted' }, 'Veja o ranking final.')),
      h('h2', {}, 'Suas missões'),
      me.missions.map((m, i) => missionCard(m, i)));
  }

  function toggleRole() {
    st.revealed = !st.revealed;
    clearTimeout(revealTimer);
    if (st.revealed) revealTimer = setTimeout(() => { st.revealed = false; if (st.tab === 'missions' && !sheetIsOpen()) render(); }, 6000);
    render();
  }

  function missionCard(m) {
    const L = LEVEL[m.level];
    return h('button', { class: `mission ${m.level} ${m.status}`, onclick: () => openMission(m) },
      h('div', { class: 'head' }, h('span', {}, `${L.icon} Missão ${String(m.number).padStart(2, '0')} — ${m.points} pts`), statusChip(m.status)),
      h('div', { class: 'title' }, m.title),
      h('div', { class: 'foot' }, h('span', { class: 'chip' }, CATEGORY[m.category] || m.category), h('span', { class: 'tap' }, 'ABRIR ARQUIVO ›')));
  }

  function openMission(m) {
    const L = LEVEL[m.level];
    const parts = [
      h('div', { class: 'row' }, h('span', { class: 'chip red' }, `${L.icon} ${L.label} · ${m.points} pts`), h('span', { class: 'chip' }, CATEGORY[m.category] || m.category), statusChip(m.status)),
      h('p', { class: 'desc' }, m.description),
    ];
    if (m.reviewMessage && m.status === 'pendente') parts.push(h('div', { class: 'card red' }, h('b', {}, '↩ DEVOLVIDA PELO COMANDO'), h('div', {}, m.reviewMessage)));

    if (m.status === 'pendente' && st.me.game.status === 'active') {
      const note = h('textarea', { placeholder: 'Como foi? (opcional)', maxlength: 500 });
      const preview = h('div');
      let photo = null;
      const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
        if (!file.files[0]) return;
        try {
          photo = await imageToDataUrl(file.files[0]);
          preview.replaceChildren(h('img', { class: 'ev', src: photo, alt: 'prévia da evidência' }));
        } catch (e) { toast(e.message, 'err'); }
      } });
      const send = h('button', { class: 'btn primary', onclick: () => busy(send, async () => {
        const r = await post(`/api/me/missions/${m.id}/complete`, { note: note.value, photo });
        closeSheet();
        toast(r.status === 'concluida' ? '✅ Missão concluída!' : '🔎 Enviada para análise do comando', 'ok');
        await select(st.tab);
      }) }, '☑ Marcar como concluída');
      parts.push(h('label', {}, 'Evidência (opcional)'), file,
        h('button', { class: 'btn', onclick: () => file.click() }, '📸 Anexar foto'), preview,
        h('label', {}, 'Observações'), note, send);
    } else if (m.status === 'analise') {
      parts.push(h('div', { class: 'card' }, h('b', {}, '🔎 Aguardando o comando confirmar'), h('div', { class: 'muted' }, `Enviada em ${fmtDate(m.submittedAt)}`)));
      if (m.hasEvidence) parts.push(h('img', { class: 'ev', src: `/api/me/missions/${m.id}/evidence?t=${Date.now()}`, alt: 'sua evidência' }));
      if (st.me.game.status === 'active') {
        const undo = h('button', { class: 'btn danger', onclick: () => busy(undo, async () => {
          await post(`/api/me/missions/${m.id}/undo`); closeSheet(); toast('Envio desfeito'); await select(st.tab);
        }) }, '↩ Desfazer envio');
        parts.push(undo);
      }
    } else if (m.status === 'concluida') {
      parts.push(h('div', { class: 'card' }, h('b', {}, `✅ MISSÃO CUMPRIDA · +${m.points} pts`), h('div', { class: 'muted' }, `Confirmada em ${fmtDate(m.confirmedAt)}`)));
      if (m.hasEvidence) parts.push(h('img', { class: 'ev', src: `/api/me/missions/${m.id}/evidence`, alt: 'sua evidência' }));
    }
    parts.push(h('button', { class: 'btn', onclick: closeSheet }, 'Fechar'));
    sheet(`${L.icon} ${m.title}`, ...parts);
  }

  // ---- Ranking ---------------------------------------------------------------------------------------
  function rankingView() {
    return h('div', {}, h('h2', {}, '🏆 Ranking Low Profile'), st.ranking ? rankingList(st.ranking, st.me.id) : h('div', { class: 'empty' }, 'CARREGANDO…'),
      h('p', { class: 'muted mono', style: 'font-size:11px' }, 'SÓ MISSÕES CONFIRMADAS PELO COMANDO CONTAM PONTOS.'));
  }

  function rulesView() {
    return h('div', {}, h('h2', {}, '📜 Regras de ouro'),
      RULES.map(([i, t, d]) => h('div', { class: 'card' }, h('b', {}, `${i} ${t}`), h('div', { class: 'muted' }, d))));
  }

  // ---- Central do Agente Duplo (o servidor só responde se este agente for o duplo) --------------------
  function centralView() {
    if (!st.central) return h('div', { class: 'empty' }, 'CARREGANDO…');
    return h('div', {},
      h('div', { class: 'card red' }, h('span', { class: 'stamp' }, 'Ultra secreto'), h('h1', { style: 'font-size:18px;margin-top:12px' }, '🕵️ Central do Agente Duplo'),
        h('div', { class: 'muted' }, 'Acompanhe os outros agentes e atrapalhe com classe. Nunca revele esta tela.')),
      st.central.map((a) => {
        const body = h('div', { class: 'hidden' }, a.missions.map((m) => h('div', { class: 'mini' },
          h('div', { class: 'row between' }, h('span', { class: 't' }, `${LEVEL[m.level].icon} ${m.title}`), statusChip(m.status)),
          h('div', { class: 'd' }, m.description),
          h('span', { class: 'chip' }, `${m.points} pts`))));
        return h('div', { class: 'card' },
          h('div', { class: 'acc-head', onclick: () => body.classList.toggle('hidden') },
            h('div', {}, h('b', {}, a.name), h('div', { class: 'muted mono', style: 'font-size:12px' }, `${a.position}º · ${a.points} pts · ${a.done}/${a.total} missões`)),
            h('span', { class: 'chip' }, 'ABRIR')),
          body);
      }));
  }

  // ---- ciclo de vida -----------------------------------------------------------------------------------------
  const tick = async () => {
    if (document.hidden || sheetIsOpen() || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    try { await load(); render(); } catch { /* sessão expirada tratada pelo handler global */ }
  };
  const timer = setInterval(tick, 15000);
  document.addEventListener('visibilitychange', tick);

  load().then(render).catch((e) => toast(e.message, 'err'));
  return () => { clearInterval(timer); clearTimeout(revealTimer); document.removeEventListener('visibilitychange', tick); closeSheet(); };
}
