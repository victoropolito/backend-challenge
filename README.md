# Distributed Wagering Processor

Serviço de carteira para apostas de cassino online. Ele recebe dos provedores de jogos as operações de uma rodada (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), por HTTP ou por uma fila SQS FIFO, e as aplica ao saldo de cada jogador com garantias de sistema financeiro:

- **Dinheiro exato:** valores em centavos (`bigint`), nunca `number`. Mais de 2 casas decimais é rejeitado, nunca arredondado.
- **Ledger imutável e auditável:** todo movimento gera um lançamento. O PostgreSQL impede alterar ou apagar lançamentos e confere, no commit, que o saldo da wallet é igual ao do ledger.
- **Exatamente uma vez:** idempotência persistida no banco por `(providerId, idempotencyKey)`. Uma repetição devolve o resultado original, inclusive o saldo daquele momento; a mesma chave com outro conteúdo é recusada.
- **Correção com concorrência:** lock por wallet no banco, sem lock global. A solução é correta com várias instâncias rodando ao mesmo tempo, o que é testado com 3 processos reais e uma instância morta no meio da carga.
- **Mensageria confiável:** inbox gravada na mesma transação do resultado, eventos publicados pela *transactional outbox* só depois do commit, retry com backoff, DLQ e shutdown gracioso.
- **Referências fora de ordem:** um `WIN`, `REFUND` ou `ROLLBACK` que chega antes da transação que ele referencia fica em `PENDING_REFERENCE` e é aplicado assim que a referência chega.

O enunciado original do desafio está em [`docs/enunciado.md`](docs/enunciado.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | decisões técnicas, trade-offs, interpretações das regras, limitações conhecidas e o que cada teste cobre |
| [`docs/execucao-e-validacao.md`](docs/execucao-e-validacao.md) | guia detalhado: todas as variáveis, roteiros de validação manual (API, fila, referência fora de ordem, reconciliação, `SIGTERM` real), problemas conhecidos e limpeza |
| [`docs/enunciado.md`](docs/enunciado.md) | enunciado do desafio |

## Stack

Bun 1.x · TypeScript (strict) · NestJS · MikroORM · PostgreSQL 16 · SQS FIFO (LocalStack 3.8 no ambiente local) · Zod.

## Pré-requisitos

- **Docker** (Docker Desktop no Windows/macOS), para PostgreSQL e LocalStack.
- **Bun 1.x.** Sem Bun instalado, troque `bun` por `npx -y bun@1` em todos os comandos.
- No Windows, use o **Git Bash** para os scripts `.sh`.

## Setup

```bash
cp .env.example .env          # valores padrão apontam para o docker compose local
bun install
bun run infra:up              # PostgreSQL + LocalStack (cria as filas) e espera os healthchecks
bun run migration:up          # aplica o schema
bun run start                 # API, consumidor da fila, publisher da outbox e worker de PENDING_REFERENCE
```

Conferir: `curl localhost:3000/health/ready` deve devolver `200`, com `postgres` e `sqs` em `up`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run dev` | sobe a aplicação (`dev` recarrega ao salvar) |
| `bun run typecheck` | checagem de tipos |
| `bun test` | todos os testes (precisa da infra no ar) |
| `bun run test:unit` | só os unitários (sem infra) |
| `bun run test:integration` | integração com PostgreSQL e LocalStack reais |
| `bun run test:multi-instance` | 3 processos da aplicação sobre o mesmo banco e as mesmas filas, com crash e reinício |
| `bash scripts/sigterm-check.sh` | shutdown com `SIGTERM` real em container Linux, no meio de uma rajada de mensagens |
| `bun run infra:up` / `infra:down` / `infra:reset` | sobe, para ou recria a infraestrutura (`reset` apaga os dados) |
| `bun run migration:up` / `migration:down` / `migration:pending` | migrations |

Os testes de integração não tocam nos dados de desenvolvimento: cada arquivo cria um banco `wagering_test_*` e filas `wager-test-*` próprios e os remove no fim.

## API

| Método e rota | Descrição | Respostas principais |
|---|---|---|
| `POST /wallets` | cria uma wallet (`playerId`, `initialBalance`) | 201, 409 (já existe para o player e a moeda) |
| `GET /wallets/:walletId` | saldo e versão | 200, 404 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | lançamentos, em ordem, paginados por cursor | 200, 404 |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com o ledger (só verifica, nunca corrige) | 200 |
| `POST /wagering/transactions` | submete uma transação; header `Idempotency-Key` obrigatório | 200 aplicada · 202 `PENDING_REFERENCE` · 422 rejeitada (com `failureCode`) · 409 conflito de idempotência · 503 transitório |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno | 200, 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provider | 200, 404 |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (PostgreSQL e filas) | 200, 503 |
| `GET /metrics` | métricas no formato Prometheus | 200 |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<id da wallet>",
       "roundId":"r-1","gameId":"g-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

A tabela completa de status e códigos de falha, com a ação esperada do provider em cada caso, está no `ARCHITECTURE.md` (seções 3.4 e 7.1). Erros seguem o formato `{ code, message, retryable, details?, correlationId }`. O header `X-Correlation-Id` é aceito e devolvido.

A autenticação não está ligada: há um ponto de extensão (`RequestAuthenticator` e um guard) e o desenho com provedor de identidade OIDC está documentado no `ARCHITECTURE.md`, seção 7.6.

## Fila

A fila `wager-transactions.fifo` recebe as mesmas transações da API, com `MessageGroupId` = `walletId`:

```json
{
  "messageId": "msg-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-30T12:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "tx-2", "idempotencyKey": "provider-a:tx-2",
    "playerId": "player-1", "walletId": "<id da wallet>", "roundId": "r-1", "gameId": "g-1",
    "kind": "BET", "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

Mensagens inválidas ou em conflito vão direto para `wager-transactions-dlq.fifo`, com o motivo nos atributos. Falhas transitórias são repetidas com backoff, e as que esgotam as tentativas também vão para a DLQ. Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionFailed`, `WalletBalanceChanged`) são publicados em `wagering-events.fifo`.

## Observabilidade

- **Logs:** JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` propagados. Valores e saldos não vão para o log. O nível é definido por `LOG_LEVEL`.
- **Métricas:** `GET /metrics` mostra transações por status, replays, conflitos, mensagens processadas, repetidas e enviadas para a DLQ, conflitos e espera de lock, atraso da outbox, latência HTTP e divergências de reconciliação.
- **Health:** `/health/live` e `/health/ready`.

## Configuração

Todas as variáveis estão em [`.env.example`](.env.example) e são validadas no boot (falha rápida). As principais:

| Variável | Padrão | Efeito |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | compose local | PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `SQS_CONSUMER_ENABLED` / `OUTBOX_PUBLISHER_ENABLED` / `REFERENCE_WORKER_ENABLED` | `true` | ligam o consumidor, o publisher da outbox e o worker de `PENDING_REFERENCE` |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | entregas antes de mandar uma falha transitória para a DLQ |
| `REFERENCE_CHECK_MAX_ATTEMPTS` | `15` | verificações de uma referência ausente antes de rejeitar com `REFERENCE_NOT_FOUND` (cerca de 9 min) |

A lista completa, com o efeito de cada uma, está no guia de execução, seção 3.

## Estrutura

```
src/
├── domain/          entidades e regras (Money, Wallet, ledger, WagerTransaction, eventos, inbox/outbox), sem framework
├── application/     casos de uso e portas (repositórios, relógio, monitores)
├── infrastructure/  PostgreSQL/MikroORM (schema, migrations, repositórios), SQS, logs e métricas
├── contracts/       schemas de entrada compartilhados pela API e pela fila
├── http/            controllers, validação (Zod), autenticação (ponto de extensão), mapeamento de erros
├── consumer/        consumidor da fila de transações
├── workers/         publisher da outbox e worker de PENDING_REFERENCE
├── health/          health checks
└── config/          variáveis de ambiente validadas no boot
test/
├── unit/            domínio, aplicação e adaptadores, sem infraestrutura
└── integration/     PostgreSQL e LocalStack reais, app Nest real e várias instâncias
```
