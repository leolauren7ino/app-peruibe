import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Lido a cada chamada para que os testes possam sobrescrever via opções.
export function loadConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT || 3000),
    dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    publicDir: path.join(ROOT, 'public'),
    adminPassword: process.env.ADMIN_PASSWORD || null,
    appSecret: process.env.APP_SECRET || null,
    trustProxy: process.env.TRUST_PROXY === '1',
    // backup do banco em um Gist privado (hospedagem grátis sem disco persistente)
    backup: process.env.GIST_ID && process.env.GIST_TOKEN ? { gistId: process.env.GIST_ID, token: process.env.GIST_TOKEN } : null,
    backupDelayMs: 8000,
    seed: true,
    sessionDays: 14,
    maxImageBytes: 4 * 1024 * 1024,
    ...overrides,
  };
}
