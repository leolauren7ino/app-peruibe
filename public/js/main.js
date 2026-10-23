import { h, busy } from './dom.js';
import { get, post, setUnauthorizedHandler } from './api.js';
import { startPlayer } from './player.js';
import { startAdmin } from './admin.js';

const root = document.getElementById('app');
let stop = () => {};

function login() {
  stop();
  const name = h('input', { type: 'text', placeholder: 'Seu nome', autocomplete: 'username', autocapitalize: 'words', enterkeyhint: 'next' });
  const pass = h('input', { type: 'password', placeholder: 'Senha do pacote', autocomplete: 'current-password', enterkeyhint: 'go' });
  const err = h('div', { class: 'error' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, '🔐 Acessar operação');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.textContent = '';
      busy(go, async () => {
        try { await post('/api/login', { name: name.value, password: pass.value }); boot(); } catch (x) { err.textContent = x.message.toUpperCase(); }
      });
    },
  },
    h('label', {}, 'Nome'), name, h('label', {}, 'Senha'), pass, go, err);

  root.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'glasses' }, '🕶️'),
    h('h1', {}, 'Peruíbe', h('em', {}, 'Low Profile')),
    h('div', { class: 'op' }, 'OPERAÇÃO AGENTE SECRETO'),
    h('div', { class: 'stampwrap' }, h('span', { class: 'stamp' }, 'Confidencial')),
    h('div', { class: 'quote' }, '"NINGUÉM CONFIA EM NINGUÉM."'),
    form,
    h('p', { class: 'muted mono', style: 'text-align:center;font-size:11px;margin-top:22px' }, 'ACESSO RESTRITO · SEU PACOTE É SÓ SEU'),
  ));
}

async function boot() {
  stop();
  try {
    const { kind } = await get('/api/session');
    const logout = async () => { await post('/api/logout').catch(() => {}); login(); };
    stop = (kind === 'admin' ? startAdmin : startPlayer)(root, logout) || (() => {});
  } catch {
    login();
  }
}

setUnauthorizedHandler(login);
boot();
