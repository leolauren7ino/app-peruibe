import { createApp } from './app.js';

const app = await createApp();
const port = await app.listen();
for (const n of app.notes) console.log(`\n🕶️  ${n}`);
console.log(`\n🕶️  PERUÍBE LOW PROFILE rodando em http://localhost:${port}\n`);

// plataformas de hospedagem avisam com SIGTERM antes de reiniciar: salva o banco antes de sair
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await app.flush().catch((e) => console.error(e.message));
    process.exit(0);
  });
}
