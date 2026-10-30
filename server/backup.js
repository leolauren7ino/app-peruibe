import fs from 'node:fs';

const FILE = 'peruibe.db.b64';
const SQLITE_MAGIC = 'SQLite format 3';

/**
 * Cópia do banco num Gist privado do GitHub, para hospedagens grátis cujo disco é apagado a cada reinício.
 * - restoreIfMissing(): no boot, se não há banco local, baixa a última cópia.
 * - save(db): grava um snapshot consistente (VACUUM INTO) no Gist.
 */
export function createBackup({ gistId, token, dbFile, fetchImpl = fetch }) {
  const url = `https://api.github.com/gists/${gistId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'peruibe-low-profile',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  return {
    /** @returns 'existing' | 'restored' | 'empty'. Lança erro se não conseguir falar com o GitHub (nunca começa um banco novo "por engano"). */
    async restoreIfMissing() {
      if (fs.existsSync(dbFile)) return 'existing';
      const res = await fetchImpl(url, { headers });
      if (!res.ok) throw new Error(`backup: GitHub respondeu ${res.status} ao ler o Gist`);
      const file = (await res.json()).files?.[FILE];
      if (!file) return 'empty';
      let content = file.content;
      if (file.truncated) {
        const raw = await fetchImpl(file.raw_url, { headers });
        if (!raw.ok) throw new Error(`backup: GitHub respondeu ${raw.status} ao baixar o arquivo`);
        content = await raw.text();
      }
      const bytes = Buffer.from(String(content || '').trim(), 'base64');
      if (bytes.subarray(0, SQLITE_MAGIC.length).toString() !== SQLITE_MAGIC) return 'empty'; // Gist recém-criado, só com o texto de partida
      fs.writeFileSync(dbFile, bytes);
      return 'restored';
    },

    async save(db) {
      const snap = `${dbFile}.snap`;
      fs.rmSync(snap, { force: true });
      db.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      const content = fs.readFileSync(snap).toString('base64');
      fs.rmSync(snap, { force: true });
      const res = await fetchImpl(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [FILE]: { content } } }),
      });
      if (!res.ok) throw new Error(`backup: GitHub respondeu ${res.status} ao gravar o Gist`);
    },
  };
}
