import { createApp } from './app.js';

const app = await createApp();
const port = await app.listen();
for (const n of app.notes) console.log(`\n🕶️  ${n}`);
console.log(`\n🕶️  PERUÍBE LOW PROFILE rodando em http://localhost:${port}\n`);
