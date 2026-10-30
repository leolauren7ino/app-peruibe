# 🕶️ PERUÍBE LOW PROFILE — Operação Agente Secreto

App mobile-first de missões secretas para a viagem. Node 22+, **sem dependências** (HTTP nativo, `node:sqlite`, scrypt).

## Rodar

```bash
npm start     # http://localhost:3000
npm test      # sorteio, autorização e fluxo completo
```

Na primeira execução o app cria o banco em `data/`, carrega os 27 desafios do Peruibiza, cria a partida com os 9 agentes e já faz o sorteio. A **senha do admin** é gerada e salva em `data/ADMIN_PASSWORD.txt` (ou defina `ADMIN_PASSWORD=...`).

Banco da versão anterior? Ao subir, ele é migrado sozinho (agentes e senhas preservados). Se a partida ainda estava em preparação, os desafios são sorteados de novo com as regras novas; se já tinha começado, crie uma **Nova partida** no painel mantendo agentes e senhas.

## Como o jogo funciona no app
- Cada agente tem 3 desafios, **um por dia** (sexta, sábado, domingo). O admin libera um dia por vez (**Operação → Liberar dia N**); dias trancados não enviam nenhum conteúdo ao celular.
- Pontos por desafio: 1 fácil, 2 médio, 3 difícil, 5 arriscado (5 só no último dia). Editáveis por desafio na aba Missões.
- Agente marca como concluído → fila do organizador → confirma (foto ou testemunha) → pontos.
- **Fichas de passe**: 2 por agente (recusa sem perder pontos). **Flagrante**: o agente denuncia, o admin julga: acusador +1 e o dono perde aquela carta. **Fuga**: admin aplica -1 em "± Ajustar pontos".
- **Encerrar e revelar** (segunda): todos os desafios ficam visíveis e o ranking final mostra o campeão e quem paga a rodada.
- **Agente Duplo**: sorteado entre os agentes e visível só para ele (aba Cofre); o admin o vê no painel. Dá para desligar em Configurações antes de iniciar.
- O sorteio garante: ninguém recebe desafio com o próprio nome, `[ALVO]` nunca é o dono, quem tem restrição não recebe desafio de flerte, e a soma de pontos fica equilibrada. O catálogo padrão tem exatamente 27 desafios (9 x 3): para trocar desafios ou entrar mais gente, cadastre extras.

## Variáveis
`PORT`, `DATA_DIR`, `ADMIN_PASSWORD`, `APP_SECRET` (cifra as senhas visíveis ao admin; se omitida, gera `data/secret.key`), `TRUST_PROXY=1` (atrás de proxy HTTPS).

## Arquitetura
- `server/draw.js` — sorteio puro (busca com troca de cartas): 1 desafio por dia, regras duras garantidas, pontuação e alvos equilibrados.
- `server/game.js` — regras da partida (sorteio travado após iniciar, ranking, troca, entrada/saída de agente).
- `server/routes/` — `auth`, `player` (só o próprio pacote; Central do Duplo checada no servidor), `admin`.
- `server/seed/*.json` — missões e participantes iniciais. `public/` — frontend em JS puro.

## Segurança
- Autorização só no backend: missão alheia responde 404; `/api/double/*` responde 403 a quem não é o Duplo; o papel só aparece no `/api/me` do próprio agente, nunca no ranking.
- Senhas: hash scrypt + cópia AES-256-GCM só para o admin exibir. Cookie HttpOnly/SameSite=Strict, bloqueio após 10 erros/10 min, checagem de Origin, fotos validadas por tipo real.

## Novas missões/agentes (sem rebuild)
Painel admin → **Missões** (criar/editar/importar JSON) e **Agentes**. `[ALVO]` na descrição vira o nome do alvo; `target` pode ser vazio, `*` (sorteado) ou nome de um agente. "Flerte" marca missões que não vão para quem tem restrição.

## Hospedagem (servidor fixo)
Precisa de **disco persistente** montado em `/data` (o banco é SQLite). Com o Dockerfile do repositório:

| Variável | Para quê |
|---|---|
| `ADMIN_PASSWORD` | senha do admin |
| `APP_SECRET` | qualquer texto longo; mantém as senhas visíveis ao admin entre deploys |
| `CREDENTIALS_JSON` | `{"Nome do agente":"SENHA", ...}` — senhas fixas, sem precisar de arquivo |
| `DATA_DIR` | `/data` (já é o padrão do Dockerfile) |
| `TRUST_PROXY` | `1` (já é o padrão do Dockerfile) |

Checagem de saúde: `GET /api/health`. Planos grátis sem disco persistente perdem o banco a cada reinício.

### Hospedagem grátis (sem disco persistente): Render + backup em Gist
Defina também `GIST_ID` e `GIST_TOKEN` (token clássico do GitHub só com o escopo `gist`). O app grava o banco no Gist pouco depois de cada alteração e o restaura sozinho quando o servidor reinicia com disco vazio. Se o GitHub não responder no boot, o app **não sobe** (para não criar um jogo novo por cima do salvo). Fotos de evidência não entram no backup. Use um monitor de uptime (ex.: UptimeRobot) em `/api/health` a cada 5 min para o serviço não dormir.
