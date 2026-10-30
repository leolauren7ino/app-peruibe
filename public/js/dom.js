// Helpers de DOM. Nunca usamos innerHTML com dados: nomes e missões entram sempre como texto.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const TIERS = { 1: ['🟢', 'Fácil'], 2: ['🟡', 'Médio'], 3: ['🔴', 'Difícil'], 5: ['☠️', 'Arriscado'] };
/** Selo do desafio pela pontuação (1 fácil, 2 médio, 3 difícil, 5 arriscado). */
export const tier = (points) => { const [icon, label] = TIERS[points] || ['⚪', 'Especial']; return { icon, label }; };
export const STATUS = { pendente: '☐ Pendente', analise: '🔎 Em análise', concluida: '☑ Concluída', flagrante: '🚨 Flagrante', passe: '🎫 Passe' };

/** "sexta, 30/10" a partir da data de início da partida (AAAA-MM-DD) e do número do dia (1 = primeiro). */
export function dayLabel(startDate, day) {
  if (!startDate) return `Dia ${day}`;
  const d = new Date(`${startDate}T12:00:00`);
  d.setDate(d.getDate() + day - 1);
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
}
export const CATEGORY = {
  infiltracao: '🕵️ Infiltração', social: '💃 Social', foto: '📸 Fotográfica', humor: '😂 Humor',
  bebida: '🍻 Brinde', investigacao: '🧠 Investigação', atuacao: '🎭 Atuação', viagem: '🧭 Viagem',
};
export const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

export const statusChip = (s) => h('span', { class: `chip ${s}` }, STATUS[s]);

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

let openSheet = null;
export const sheetIsOpen = () => !!openSheet;

export function sheet(title, ...content) {
  closeSheet();
  const box = h('div', { class: 'sheet' }, h('div', { class: 'grip' }), title && h('h3', {}, title), ...content);
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && closeSheet() }, box);
  document.body.append(overlay);
  openSheet = overlay;
  return { close: closeSheet, box };
}

export function closeSheet() {
  openSheet?.remove();
  openSheet = null;
}

export function confirmSheet(message, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    const done = (v) => { closeSheet(); resolve(v); };
    const s = sheet('Confirmação', h('p', { class: 'desc' }, message),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancelar'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, ok)));
    s.box.parentElement.addEventListener('click', (e) => e.target.classList.contains('overlay') && resolve(false));
  });
}

/** Executa `fn` com o botão desabilitado e mostra erro como toast. */
export async function busy(btn, fn) {
  btn && (btn.disabled = true);
  try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { btn && (btn.disabled = false); }
}

/** Reduz a foto no celular antes de enviar (câmeras modernas geram arquivos enormes). */
export function imageToDataUrl(file, maxDim = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui ler essa imagem.')); };
    img.src = url;
  });
}

export function rankingList(ranking, meId = null) {
  if (!ranking.length) return h('div', { class: 'empty' }, 'NENHUM AGENTE NA OPERAÇÃO');
  return h('div', {}, ranking.map((r) => h('div', { class: `rank ${r.id === meId ? 'me' : ''}` },
    h('div', { class: 'pos' }, MEDAL[r.position] || `${r.position}º`),
    h('div', { class: 'nm' }, r.name, r.id === meId && h('span', { class: 'muted' }, ' (você)')),
    h('div', { class: 'pts' }, `${r.points} pts`),
    h('div', { class: 'bar' }, h('i', { style: `width:${r.percent}%` })),
    h('div', { class: 'sub' }, `${r.done} concluídas · ${r.remaining} restantes${r.lost ? ` · ${r.lost} perdidas/passe` : ''} · ${r.percent}%`),
  )));
}

/** Cartão de confronto ("O Clássico"): duas fotos frente a frente e, se já houver, o resultado. */
export function versusCard(a) {
  const side = (s, which) => h('div', { class: `vs-side ${a.winner === which ? 'win' : a.winner ? 'lose' : ''}` },
    s.image && h('img', { class: 'vs-photo', src: s.image, alt: s.name }),
    h('div', { class: 'vs-name' }, s.name),
    a.winner === which && h('div', { class: 'vs-crown' }, '🏆 VENCEDOR'));
  const win = a.winner && a[a.winner];
  const lose = a.winner && a[a.winner === 'left' ? 'right' : 'left'];
  return h('div', { class: 'card red vs' },
    h('div', { class: 'row between' }, h('span', { class: 'stamp' }, 'Anúncio'), a.subtitle && h('span', { class: 'chip red' }, `🎮 ${a.subtitle}`)),
    h('h1', { class: 'vs-title' }, a.title),
    h('div', { class: 'vs-grid' }, side(a.left, 'left'), h('div', { class: 'vs-x' }, 'X'), side(a.right, 'right')),
    h('p', { class: 'vs-body' }, a.winner ? `🏆 ${win.name} venceu e controla ${lose.name} por todo o dia.` : a.body));
}
