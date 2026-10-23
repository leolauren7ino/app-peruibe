import fs from 'node:fs';
import path from 'node:path';

/** Retornado pelo handler quando ele mesmo já escreveu a resposta (ex.: arquivo). */
export const HANDLED = Symbol('handled');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
      routes.push({ method, re, keys, handler });
    },
    match(method, pathname) {
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (m && r.method === method) {
          return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        }
      }
      return null;
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Requisição grande demais.');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Use application/json.');
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendFile(res, file, { cache = 'no-cache', type } = {}) {
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.once('open', () => {
    res.writeHead(200, { 'Content-Type': type || MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    stream.pipe(res);
  });
}

/** Serve arquivos estáticos de `root` sem permitir sair do diretório. */
export function serveStatic(req, res, root) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendFile(res, path.join(root, 'index.html'));
  sendFile(res, file);
}

export const int = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} inválido.`);
  return n;
};

export const str = (v, name, { max = 500, required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${name} é obrigatório.`);
  if (s.length > max) throw new HttpError(400, `${name} muito longo.`);
  return s;
};
