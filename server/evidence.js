import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

const KINDS = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};
const TYPE_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function saveEvidence(cfg, assignmentId, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, 'Foto inválida (use JPEG, PNG ou WebP).');
  const buf = Buffer.from(String(dataUrl).slice(m[0].length), 'base64');
  const kind = KINDS[m[1]];
  if (!buf.length || buf.length > cfg.maxImageBytes) throw new HttpError(413, 'Foto grande demais.');
  if (!kind.magic(buf)) throw new HttpError(400, 'Arquivo não parece uma imagem válida.');
  const file = `${assignmentId}-${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
  fs.writeFileSync(path.join(cfg.dataDir, 'evidence', file), buf);
  return file;
}

export const removeEvidence = (cfg, file) => file && fs.rmSync(path.join(cfg.dataDir, 'evidence', path.basename(file)), { force: true });

export function sendEvidence(cfg, res, file) {
  const full = path.join(cfg.dataDir, 'evidence', path.basename(file));
  if (!fs.existsSync(full)) throw new HttpError(404, 'Foto não encontrada.');
  res.writeHead(200, {
    'Content-Type': TYPE_BY_EXT[path.extname(file).slice(1)] || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
}
