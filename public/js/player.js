import { h, sheet, closeSheet, sheetIsOpen, toast, busy, statusChip, fmtDate, imageToDataUrl, rankingList, confirmSheet, tier, CATEGORY, MEDAL } from './dom.js';
import { get, post } from './api.js';

const RULES = [
  ['🎯', 'Como funciona', 'Você tem 3 desafios secretos para cumprir ao longo da viagem, na ordem que quiser. Cumpra sem o grupo perceber que era um desafio. Segunda é o fechamento.'],
  ['✅', 'Como validar', 'Cumpriu? Toque em "Marcar como concluída" e avise só o organizador. Ele confirma com foto ou testemunha e os pontos entram.'],
  ['⭐', 'Pontos', '1 fácil · 2 médio · 3 difícil · 5 arriscado.'],
  ['🚨', 'Flagrante', 'Descobriu o desafio de outro? Denuncie na aba Flagrante: se o organizador confirmar, você ganha 1 ponto e o dono perde aquele desafio.'],
  ['🎫', 'Ficha de passe', 'Você tem 2 fichas para recusar um desafio sem perder pontos. Fugir do jogo sem gastar uma ficha custa 1 ponto.'],
  ['🍻', 'Beber com segurança', 'Quem bebe num desafio aceita beber. Nunca coloque bebida em copo alheio sem avisar (alergia, remédio, quem não bebe). Sem garrafa inteira, sem beber até apagar. Sem álcool vale sempre.'],
  ['🌊', 'Nada de mar nem volante', 'Ninguém entra no mar depois de beber. Ninguém dirige. Um responsável sóbrio por noite fica com os celulares para chamar socorro.'],
  ['🤝', 'Consentimento', 'Funcionários, desconhecidos e amigos só entram se toparem. Ouviu um "não"? Agradeça e siga.'],
  ['🏆', 'Fim de jogo', 'Segunda (02/11): soma dos pontos, revelação dos desafios e coroação de "O Low Profile do Peruibiza". O último colocado paga a primeira rodada da próxima edição.'],
];

export function startPlayer(root, logout) {
  const st = { tab: 'missions', me: null, ranking: null, central: null, reveal: null, flags: null, revealed: false };
  let revealTimer;
  const main = h('main');
  const nav = h('nav', { class: 'nav' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, 'PERUÍBE ', h('b', {}, 'LOW PROFILE')), h('button', { onclick: logout }, 'SAIR')), main), nav);

  const finished = () => st.me?.game.status === 'finished';
  const tabs = () => [
    ['missions', '📁', 'Desafios'], ['ranking', '🏆', 'Ranking'],
    finished() ? ['reveal', '🎭', 'Revelação'] : ['flag', '🚨', 'Flagrante'],
    ['rules', '📜', 'Regras'],
    ...(st.me?.role === 'AGENTE_DUPLO' ? [['central', '🔒', 'Cofre']] : []),
  ];

  async function load() {
    st.me = await get('/api/me');
    if (['ranking', 'flag'].includes(st.tab)) st.ranking = (await get('/api/ranking')).ranking;
    if (st.tab === 'flag') st.flags = (await get('/api/me/flagrantes')).flagrantes;
    if (st.tab === 'central') st.central = (await get('/api/double/overview')).agents;
    if (st.tab === 'reveal') st.reveal = (await get('/api/reveal')).agents;
  }

  function render() {
    if (!tabs().some(([id]) => id === st.tab)) st.tab = 'missions';
    nav.replaceChildren(...tabs().map(([id, icon, label]) =>
      h('button', { class: st.tab === id ? 'on' : '', onclick: () => select(id) }, h('span', {}, icon), label)));
    const view = { missions: missionsView, ranking: rankingView, flag: flagView, reveal: revealView, rules: rulesView, central: centralView }[st.tab];
    main.replaceChildren(view());
  }

  async function select(tab) {
    st.tab = tab;
    try { await load(); } catch (e) { toast(e.message, 'err'); }
    render();
    window.scrollTo(0, 0);
  }

  // ---- Desafios -----------------------------------------------------------------------------------
  function missionsView() {
    const { me } = st;
    if (me.game.status === 'setup') {
      return h('div', { class: 'wait' }, h('div', { class: 'big' }, '⏳'), h('h1', {}, 'Briefing em preparação'),
        h('p', { class: 'muted mono' }, 'A OPERAÇÃO AINDA NÃO COMEÇOU.\nSEUS DESAFIOS SERÃO LIBERADOS PELO COMANDO.'));
    }
    const s = me.stats;
    const roleBtn = me.role && h('button', { class: `role ${st.revealed ? 'shown' : ''}`, onclick: toggleRole },
      st.revealed ? `🕵️ Seu papel: ${me.role === 'AGENTE_DUPLO' ? 'AGENTE DUPLO' : 'AGENTE SECRETO'}` : '👁 TOQUE PARA VER SEU PAPEL (some em 6s)');
    return h('div', {},
      h('div', { class: 'welcome' }, h('h1', {}, 'Bem-vindo, agente.'), h('div', { class: 'who' }, me.name.toUpperCase())),
      roleBtn,
      h('div', { class: 'score' },
        h('div', {}, h('b', {}, s.points), h('small', {}, 'Pontos')),
        h('div', {}, h('b', {}, `${s.done}/${s.total}`), h('small', {}, 'Concluídos')),
        h('div', {}, h('b', {}, `${me.passes.left}`), h('small', {}, 'Fichas de passe'))),
      h('div', { class: 'bar' }, h('i', { style: `width:${s.percent}%` })),
      finished() && h('div', { class: 'card red', style: 'margin-top:14px' }, h('b', {}, '🏁 OPERAÇÃO ENCERRADA'), h('div', { class: 'muted' }, 'Veja o ranking final e a revelação dos desafios.')),
      h('h2', {}, 'Seus desafios'),
      me.missions.map(missionCard));
  }

  function toggleRole() {
    st.revealed = !st.revealed;
    clearTimeout(revealTimer);
    if (st.revealed) revealTimer = setTimeout(() => { st.revealed = false; if (st.tab === 'missions' && !sheetIsOpen()) render(); }, 6000);
    render();
  }

  function missionCard(m) {
    const T = tier(m.points);
    return h('button', { class: `mission ${m.points >= 5 ? 'arriscado' : m.points >= 3 ? 'dificil' : ''} ${m.status}`, onclick: () => openMission(m) },
      h('div', { class: 'head' }, h('span', {}, `${T.icon} Desafio ${String(m.day).padStart(2, '0')} — ${m.points} pt${m.points > 1 ? 's' : ''}`), statusChip(m.status)),
      h('div', { class: 'title' }, m.title),
      h('div', { class: 'foot' }, h('span', { class: 'chip' }, CATEGORY[m.category] || m.category), h('span', { class: 'tap' }, 'ABRIR ARQUIVO ›')));
  }

  function openMission(m) {
    const T = tier(m.points);
    const active = st.me.game.status === 'active';
    const parts = [
      h('div', { class: 'row' }, h('span', { class: 'chip red' }, `${T.icon} ${T.label} · ${m.points} pt${m.points > 1 ? 's' : ''}`), h('span', { class: 'chip' }, CATEGORY[m.category] || m.category), statusChip(m.status)),
      h('p', { class: 'desc' }, m.description),
    ];
    if (m.reviewMessage && m.status === 'pendente') parts.push(h('div', { class: 'card red' }, h('b', {}, '↩ DEVOLVIDO PELO COMANDO'), h('div', {}, m.reviewMessage)));

    if (m.status === 'pendente' && active) {
      const note = h('textarea', { placeholder: 'Quem viu? Como foi? (opcional)', maxlength: 500 });
      const preview = h('div');
      let photo = null;
      const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
        if (!file.files[0]) return;
        try { photo = await imageToDataUrl(file.files[0]); preview.replaceChildren(h('img', { class: 'ev', src: photo, alt: 'prévia da evidência' })); } catch (e) { toast(e.message, 'err'); }
      } });
      const send = h('button', { class: 'btn primary', onclick: () => busy(send, async () => {
        const r = await post(`/api/me/missions/${m.id}/complete`, { note: note.value, photo });
        closeSheet();
        toast(r.status === 'concluida' ? '✅ Desafio concluído!' : '🔎 Avise o organizador: ele confirma', 'ok');
        await select(st.tab);
      }) }, '☑ Marcar como concluída');
      const left = st.me.passes.left;
      const pass = h('button', { class: 'btn', disabled: left === 0, onclick: async () => {
        if (!(await confirmSheet(`Usar uma ficha de passe neste desafio? Você perde o desafio, mas não perde pontos. Restam ${left}.`, { ok: 'Usar passe' }))) return;
        busy(pass, async () => { await post(`/api/me/missions/${m.id}/pass`); toast('🎫 Passe usado', 'ok'); await select(st.tab); });
      } }, `🎫 Usar ficha de passe (${left} restante${left === 1 ? '' : 's'})`);
      parts.push(h('label', {}, 'Evidência (foto) — opcional'), file,
        h('button', { class: 'btn', onclick: () => file.click() }, '📸 Anexar foto'), preview,
        h('label', {}, 'Testemunha / observações'), note, send, pass);
    } else if (m.status === 'analise') {
      parts.push(h('div', { class: 'card' }, h('b', {}, '🔎 Aguardando o organizador confirmar'), h('div', { class: 'muted' }, `Enviado em ${fmtDate(m.submittedAt)}`)));
      if (m.hasEvidence) parts.push(h('img', { class: 'ev', src: `/api/me/missions/${m.id}/evidence?t=${Date.now()}`, alt: 'sua evidência' }));
      if (active) {
        const undo = h('button', { class: 'btn danger', onclick: () => busy(undo, async () => { await post(`/api/me/missions/${m.id}/undo`); closeSheet(); toast('Envio desfeito'); await select(st.tab); }) }, '↩ Desfazer envio');
        parts.push(undo);
      }
    } else if (m.status === 'concluida') {
      parts.push(h('div', { class: 'card' }, h('b', {}, `✅ CUMPRIDO · +${m.points} pt${m.points > 1 ? 's' : ''}`), h('div', { class: 'muted' }, `Confirmado em ${fmtDate(m.confirmedAt)}`)));
      if (m.hasEvidence) parts.push(h('img', { class: 'ev', src: `/api/me/missions/${m.id}/evidence`, alt: 'sua evidência' }));
    } else if (m.status === 'flagrante') {
      parts.push(h('div', { class: 'card red' }, h('b', {}, '🚨 FLAGRANTE!'), h('div', {}, 'Alguém descobriu este desafio. Você perdeu essa carta.')));
    } else if (m.status === 'passe') {
      parts.push(h('div', { class: 'card' }, h('b', {}, '🎫 Passe usado'), h('div', { class: 'muted' }, 'Desafio recusado, sem perda de pontos.')));
    }
    parts.push(h('button', { class: 'btn', onclick: closeSheet }, 'Fechar'));
    sheet(`${T.icon} ${m.title}`, ...parts);
  }

  // ---- Ranking -----------------------------------------------------------------------------------
  function rankingView() {
    const r = st.ranking;
    const final = finished() && r?.length;
    const last = final ? r[r.length - 1] : null;
    return h('div', {}, h('h2', {}, '🏆 Ranking Low Profile'),
      final && h('div', { class: 'card red', style: 'text-align:center' },
        h('div', { class: 'muted mono', style: 'font-size:11px;letter-spacing:.15em' }, 'O LOW PROFILE DO PERUIBIZA'),
        h('div', { class: 'mono', style: 'font-size:22px;font-weight:800;margin:6px 0' }, `${MEDAL[1]} ${r[0].name}`),
        r.length > 1 && h('div', { class: 'muted', style: 'font-size:14px' }, `🍻 ${last.name} paga a primeira rodada da próxima edição`)),
      r ? rankingList(r, st.me.id) : h('div', { class: 'empty' }, 'CARREGANDO…'),
      h('p', { class: 'muted mono', style: 'font-size:11px' }, 'SÓ DESAFIOS CONFIRMADOS PELO ORGANIZADOR CONTAM PONTOS.'));
  }

  // ---- Flagrante ----------------------------------------------------------------------------------
  function flagView() {
    if (!st.ranking) return h('div', { class: 'empty' }, 'CARREGANDO…');
    if (st.me.game.status !== 'active') return h('div', { class: 'empty' }, 'FLAGRANTE SÓ COM A OPERAÇÃO EM ANDAMENTO');
    const who = h('select', {}, h('option', { value: '' }, 'Quem você flagrou?'), st.ranking.filter((r) => r.id !== st.me.id).map((r) => h('option', { value: r.id }, r.name)));
    const guess = h('textarea', { placeholder: 'Qual é o desafio que você descobriu? Descreva.', maxlength: 300 });
    const send = h('button', { class: 'btn primary', onclick: () => busy(send, async () => {
      await post('/api/me/flagrantes', { accusedId: Number(who.value), guess: guess.value });
      guess.value = ''; who.value = '';
      toast('🚨 Flagrante enviado ao organizador', 'ok');
      await select('flag');
    }) }, '🚨 Denunciar flagrante');
    const LABEL = { pendente: '⏳ Aguardando', aceito: '✅ Aceito (+1 ponto)', recusado: '✖ Recusado' };
    return h('div', {},
      h('h2', {}, '🚨 Flagrante'),
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Descobriu o desafio de alguém? Se o organizador confirmar, você ganha 1 ponto e a pessoa perde aquele desafio. Acusação errada não custa nada, mas não banque o detetive chato.'),
        h('label', {}, 'Acusado'), who, h('label', {}, 'O que você descobriu'), guess, send),
      st.flags.length > 0 && h('h2', {}, 'Suas denúncias'),
      st.flags.map((f) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, f.accused), h('span', { class: 'chip' }, LABEL[f.status])), h('div', { class: 'muted', style: 'font-size:14px' }, f.guess))));
  }

  // ---- Revelação final ------------------------------------------------------------------------------
  function revealView() {
    if (!st.reveal) return h('div', { class: 'empty' }, 'CARREGANDO…');
    return h('div', {}, h('h2', {}, '🎭 Desafios revelados'), st.reveal.map((a) => {
      const body = h('div', { class: 'hidden' }, a.missions.map((m) => h('div', { class: 'mini' },
        h('div', { class: 'row between' }, h('span', { class: 't' }, `${tier(m.points).icon} ${m.title}`), statusChip(m.status)),
        h('div', { class: 'd' }, m.description))));
      return h('div', { class: 'card' }, h('div', { class: 'acc-head', onclick: () => body.classList.toggle('hidden') },
        h('div', {}, h('b', {}, a.name), h('div', { class: 'muted mono', style: 'font-size:12px' }, `${a.position}º · ${a.points} pts`)), h('span', { class: 'chip' }, 'ABRIR')), body);
    }));
  }

  function rulesView() {
    return h('div', {}, h('h2', {}, '📜 Regras do jogo'), RULES.map(([i, t, d]) => h('div', { class: 'card' }, h('b', {}, `${i} ${t}`), h('div', { class: 'muted' }, d))));
  }

  // ---- Cofre do Agente Duplo (opcional; o servidor só responde ao agente sorteado) ----------------------
  function centralView() {
    if (!st.central) return h('div', { class: 'empty' }, 'CARREGANDO…');
    return h('div', {},
      h('div', { class: 'card red' }, h('span', { class: 'stamp' }, 'Ultra secreto'), h('h1', { style: 'font-size:18px;margin-top:12px' }, '🕵️ Central do Agente Duplo'),
        h('div', { class: 'muted' }, 'Acompanhe os outros agentes e atrapalhe com classe. Nunca revele esta tela.')),
      st.central.map((a) => {
        const body = h('div', { class: 'hidden' }, a.missions.map((m) => h('div', { class: 'mini' },
          h('div', { class: 'row between' }, h('span', { class: 't' }, `${tier(m.points).icon} ${m.title}`), statusChip(m.status)),
          h('div', { class: 'd' }, m.description), h('span', { class: 'chip' }, `${m.points} pts`))));
        return h('div', { class: 'card' }, h('div', { class: 'acc-head', onclick: () => body.classList.toggle('hidden') },
          h('div', {}, h('b', {}, a.name), h('div', { class: 'muted mono', style: 'font-size:12px' }, `${a.position}º · ${a.points} pts · ${a.done}/${a.total} desafios`)), h('span', { class: 'chip' }, 'ABRIR')), body);
      }));
  }

  // ---- ciclo de vida ---------------------------------------------------------------------------------------
  const tick = async () => {
    if (document.hidden || sheetIsOpen() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    try { await load(); render(); } catch { /* sessão expirada tratada pelo handler global */ }
  };
  const timer = setInterval(tick, 15000);
  document.addEventListener('visibilitychange', tick);
  load().then(render).catch((e) => toast(e.message, 'err'));
  return () => { clearInterval(timer); clearTimeout(revealTimer); document.removeEventListener('visibilitychange', tick); closeSheet(); };
}
