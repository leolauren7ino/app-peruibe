import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** minúsculas, sem acento, espaços colapsados — usado para comparar nomes. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Senhas de pacote: ignora caixa, hífens e espaços ("corvo-lobo-47" == "CORVOLOBO47"). */
export const normalizePassword = (s) => String(s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(plain, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---- criptografia reversível (só para o admin poder ver as senhas) -------------
export function loadSecretKey(dataDir, appSecret) {
  if (appSecret) return crypto.createHash('sha256').update(appSecret).digest();
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

export function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('hex')).join('.');
}

export function decrypt(key, payload) {
  try {
    const [iv, tag, enc] = payload.split('.').map((h) => Buffer.from(h, 'hex'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---- geração de senhas legíveis -------------------------------------------------
const WORDS = ['CORVO', 'LOBO', 'FALCAO', 'COBRA', 'SOMBRA', 'RADAR', 'CODIGO', 'NEBLINA', 'AGULHA', 'MIRAGEM',
  'TUCANO', 'ONCA', 'PANTERA', 'ESCUDO', 'CHAVE', 'CIFRA', 'FANTASMA', 'LENTE', 'NORTE', 'TRIDENTE',
  'VULCAO', 'CORAL', 'MARE', 'FAROL', 'PIRATA', 'TUBARAO', 'ARRAIA', 'JAGUAR', 'ECLIPSE', 'RELAMPAGO',
  'SIRIUS', 'COMETA', 'ORQUIDEA', 'BUSSOLA', 'MALETA', 'ENIGMA', 'PHOENIX', 'DRAGAO', 'CACTO', 'ALVORADA'];

export function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  let a = pick(), b = pick();
  while (b === a) b = pick();
  return `${a}-${b}-${crypto.randomInt(10, 100)}`;
}

// ---- sessões --------------------------------------------------------------------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db, { kind, participantId = null, days = 14 }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + days * 86400000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, kind, participant_id, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), kind, participantId, exp);
  return { token, maxAge: days * 86400 };
}

export function readSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT kind, participant_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { kind: row.kind, participantId: row.participant_id };
}

export const destroySession = (db, token) => token && db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));

// ---- limitador de tentativas de login ------------------------------------------
export class LoginLimiter {
  constructor({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  #fresh(key) {
    const t = Date.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    this.hits.set(key, list);
    return list;
  }
  blocked(key) { return this.#fresh(key).length >= this.max; }
  fail(key) { this.#fresh(key).push(Date.now()); }
  reset(key) { this.hits.delete(key); }
}
