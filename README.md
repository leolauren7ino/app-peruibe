# 🕶️ PERUÍBE LOW PROFILE — Operação Agente Secreto

App mobile-first de missões secretas para a viagem. Node 22+, **sem dependências** (HTTP nativo, `node:sqlite`, scrypt).

## Rodar

```bash
npm start     # http://localhost:3000
npm test      # sorteio, autorização e fluxo completo
```

Na primeira execução o app cria o banco em `data/`, carrega o catálogo (44 missões), cria a partida com os 9 agentes e já faz o sorteio (Agente Duplo + missões). A **senha do admin** é gerada e salva em `data/ADMIN_PASSWORD.txt` (ou defina `ADMIN_PASSWORD=...`).

Login do admin: nome `admin` + senha. Lá você vê as senhas de cada agente (botão WhatsApp monta a mensagem), o Agente Duplo e clica **Iniciar operação**, que trava o sorteio.

Para os celulares acessarem, o app precisa de URL pública com HTTPS (Render/Railway/Fly com disco persistente em `/data`, via Dockerfile; ou Cloudflare Tunnel a partir do seu PC).

## Variáveis
`PORT`, `DATA_DIR`, `ADMIN_PASSWORD`, `APP_SECRET` (cifra as senhas visíveis ao admin; se omitida, gera `data/secret.key`), `TRUST_PROXY=1` (atrás de proxy HTTPS).

## Arquitetura
- `server/draw.js` — sorteio puro: 1 difícil + 2 médias, sem missão repetida, ninguém é alvo de si, restritos sem flerte, equilibra esforço e alvos.
- `server/game.js` — regras da partida (sorteio travado após iniciar, ranking, troca, entrada/saída de agente).
- `server/routes/` — `auth`, `player` (só o próprio pacote; Central do Duplo checada no servidor), `admin`.
- `server/seed/*.json` — missões e participantes iniciais. `public/` — frontend em JS puro.

## Segurança
- Autorização só no backend: missão alheia responde 404; `/api/double/*` responde 403 a quem não é o Duplo; o papel só aparece no `/api/me` do próprio agente, nunca no ranking.
- Senhas: hash scrypt + cópia AES-256-GCM só para o admin exibir. Cookie HttpOnly/SameSite=Strict, bloqueio após 10 erros/10 min, checagem de Origin, fotos validadas por tipo real.

## Novas missões/agentes (sem rebuild)
Painel admin → **Missões** (criar/editar/importar JSON) e **Agentes**. `{alvo}` na descrição vira o nome do alvo; `target` pode ser vazio, `*` (sorteado) ou nome de um agente. "Flerte" marca missões que não vão para quem tem restrição.
