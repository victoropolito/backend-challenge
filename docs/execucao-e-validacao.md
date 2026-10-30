# Execução e validação

Como subir o ambiente, rodar a aplicação e os testes, validar manualmente a API, a fila e o shutdown com `SIGTERM` real, e o que fazer quando algo dá errado. As decisões técnicas estão em [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## 1. Pré-requisitos

| Ferramenta | Uso |
|---|---|
| Docker (Docker Desktop no Windows/macOS) | PostgreSQL 16 e LocalStack 3.8 via `docker compose`; container Linux do teste de `SIGTERM` |
| Bun 1.x | runtime, testes e scripts. Sem Bun instalado, use `npx -y bun@1` no lugar de `bun` em todos os comandos (ex.: `npx -y bun@1 run infra:up`) |
| `curl` | validação manual da API |
| Bash | `scripts/sigterm-check.sh`. No Windows, use o **Git Bash** |

## 2. Infraestrutura

```bash
cp .env.example .env          # uma vez; os valores padrão apontam para o compose local
bun install
bun run infra:up              # sobe PostgreSQL e LocalStack e espera os healthchecks
bun run migration:up          # aplica as migrations no banco de dev
```

- `infra:up` = `docker compose up -d --wait`. O LocalStack só fica *healthy* depois que o script `docker/localstack/init/ready.d/01-create-queues.sh` cria as filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (`RedrivePolicy` com `maxReceiveCount = 5`, `VisibilityTimeout` de 30 s) e a fila de eventos `wagering-events.fifo`, para onde a outbox publica.
- `infra:down` para os containers e mantém os dados; `infra:reset` apaga o volume do PostgreSQL e sobe tudo de novo (depois, rode `migration:up` outra vez). As filas do LocalStack não são persistidas: são recriadas a cada subida.

Conferir:

```bash
docker compose ps                                              # os dois serviços "healthy"
docker compose exec -T localstack awslocal sqs list-queues     # as três filas
bun run migration:pending                                      # "No pending migrations"
```

## 3. Aplicação

```bash
bun run start                 # ou: bun run dev (recarrega ao salvar)
curl localhost:3000/health/live     # 200 {"status":"ok"}
curl localhost:3000/health/ready    # 200 com postgres e sqs "up"; 503 se algum estiver fora
```

A aplicação sobe a API HTTP, o consumidor da fila e o publisher da outbox no mesmo processo. Variáveis principais (todas em `.env.example`):

| Variável | Padrão | Efeito |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | compose local | PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor (`false` deixa só a API) |
| `SQS_CONSUMER_WAIT_TIME_SECONDS` | `10` | long polling; também é quanto o shutdown pode esperar pelo receive em curso |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | entregas antes de mandar uma falha transitória para a DLQ (não deve passar do `maxReceiveCount` da fila) |
| `SQS_CONSUMER_RETRY_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `1000` / `60000` | backoff entre tentativas |
| `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` | `20000` | quanto o shutdown espera as mensagens em andamento antes de devolvê-las à fila |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | fila onde os eventos da outbox são publicados |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_IDLE_DELAY_MS` | `10` / `500` | mensagens por lote; espera quando a outbox está vazia |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | `5000` | limite de cada chamada ao SQS (a transação do lote fica aberta durante a publicação) |

## 4. Testes automatizados

```bash
bun run typecheck
bun test                      # tudo; precisa da infra no ar
bun run test:unit             # só unitários (sem infra)
bun run test:integration      # PostgreSQL e LocalStack reais
```

Os testes de integração não tocam no banco nem nas filas de dev: cada arquivo cria um banco `wagering_test_<aleatório>` (removido no fim), e os testes de mensageria criam filas `wager-test-<aleatório>.fifo` + DLQ + eventos (removidas no fim). Os testes HTTP desligam o consumidor e o publisher da outbox.

## 5. Validação manual da API

Com a aplicação rodando (seção 3):

```bash
# cria a wallet (201) e guarda o id
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
WALLET=<id devolvido>

# BET de 25.00 (200, saldo 75.00)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"player-1\",\"walletId\":\"$WALLET\",\"roundId\":\"r-1\",\"gameId\":\"g-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

| Repetir o comando acima… | Resultado esperado |
|---|---|
| igual | 200, mesmo corpo, `"idempotentReplay": true`, saldo continua 75.00 |
| com a mesma `Idempotency-Key` e outro `amount` | 409 `IDEMPOTENCY_CONFLICT` |
| com outra chave e o mesmo `externalTransactionId` | 409 `EXTERNAL_TRANSACTION_ID_CONFLICT` |
| com novo id/chave e `amount` maior que o saldo | 422, `failureCode: INSUFFICIENT_BALANCE` |
| `REFUND` referenciando um `externalTransactionId` que não existe | 202, `status: PENDING_REFERENCE` |

Consultas: `GET /wallets/$WALLET`, `GET /wallets/$WALLET/ledger?limit=2` (siga o `nextCursor`), `GET /wagering/transactions/<transactionId>`, `GET /providers/provider-a/wagering/transactions/tx-1`. A tabela completa de status está no `ARCHITECTURE.md` §7.1.

## 6. Validação manual da fila

Com a aplicação rodando e uma wallet criada (seção 5):

```bash
QUEUE=http://localhost:4566/000000000000/wager-transactions.fifo
DLQ=http://localhost:4566/000000000000/wager-transactions-dlq.fifo
BODY="{\"messageId\":\"msg-tx-2\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-30T12:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-2\",\"idempotencyKey\":\"provider-a:tx-2\",\"playerId\":\"player-1\",\"walletId\":\"$WALLET\",\"roundId\":\"r-1\",\"gameId\":\"g-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

# a mesma mensagem duas vezes (deduplication ids diferentes, para o SQS entregar as duas)
docker compose exec -T localstack awslocal sqs send-message --queue-url $QUEUE \
  --message-body "$BODY" --message-group-id $WALLET --message-deduplication-id d1
docker compose exec -T localstack awslocal sqs send-message --queue-url $QUEUE \
  --message-body "$BODY" --message-group-id $WALLET --message-deduplication-id d2

# uma mensagem malformada
docker compose exec -T localstack awslocal sqs send-message --queue-url $QUEUE \
  --message-body 'not json' --message-group-id g-1 --message-deduplication-id d3
```

Esperado: o saldo cai **uma** vez (`GET /wallets/$WALLET`), `GET /providers/provider-a/wagering/transactions/tx-2` mostra `PROCESSED`, a fila principal fica vazia e a mensagem malformada está na DLQ com o motivo:

```bash
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $QUEUE \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
docker compose exec -T localstack awslocal sqs receive-message --queue-url $DLQ \
  --max-number-of-messages 10 --visibility-timeout 0 --message-attribute-names All
```

O log da aplicação mostra `Message ... sent to the DLQ (PERMANENT): MALFORMED_MESSAGE: ...`.

### Eventos publicados

Cada transação aplicada, rejeitada ou pendente gera eventos na outbox, que o publisher envia à fila `wagering-events.fifo` em até ~0,5 s. Para ver os eventos e conferir que a outbox esvaziou:

```bash
EVENTS=http://localhost:4566/000000000000/wagering-events.fifo
docker compose exec -T localstack awslocal sqs receive-message --queue-url $EVENTS \
  --max-number-of-messages 10 --visibility-timeout 0 --message-attribute-names All \
  --query 'Messages[].[MessageAttributes.eventType.StringValue, Body]' --output text
docker compose exec -T postgres psql -U wagering -d wagering -tAc \
  "select count(*) filter (where published_at is null) as pendentes, count(*) as total from outbox_messages"
```

Esperado: `pendentes = 0` com a aplicação no ar. Ninguém consome a fila de eventos neste projeto, então ela acumula mensagens (o LocalStack não persiste nada entre reinícios). Com a aplicação parada, os eventos de transações novas ficam pendentes na outbox e são publicados assim que alguma instância sobe.

## 7. Shutdown com `SIGTERM` real

O processamento de uma mensagem leva milissegundos, então matar a aplicação à mão quase nunca pega uma mensagem em andamento. O script `scripts/sigterm-check.sh` provoca a situação e confere o resultado:

```bash
bun run infra:up && bun run migration:up    # se ainda não estiverem no ar
bash scripts/sigterm-check.sh
```

O que ele faz:

1. Sobe a aplicação num container Linux (`oven/bun:1`, com `--init`), com o código montado e `bun install` dentro do container, conectada ao PostgreSQL e ao LocalStack do compose via `host.docker.internal`. Usa a porta 3001 e o banco e as filas de dev.
2. Cria `WALLETS` wallets com 1000.00 e publica `PER_WALLET` BETs de 1.00 por wallet (`scripts/send-wager-burst.ts`; uma wallet por `MessageGroupId`).
3. `STOP_AFTER` segundos depois, roda `docker stop`, que entrega `SIGTERM` ao processo.
4. Confere, logo depois do sinal: transações = lançamentos no ledger = registros na inbox, e saldo de cada wallet = 1000 − nº de BETs aplicadas.
5. Reinicia o container, espera a fila esvaziar e confere de novo: tudo aplicado **exatamente uma vez**.

Parâmetros por variável de ambiente: `WALLETS` (5), `PER_WALLET` (100), `STOP_AFTER` (1), `PORT` (3001), `BUN` (`npx -y bun@1`; use `BUN=bun` se o Bun estiver instalado). Exemplo: `STOP_AFTER=0 PER_WALLET=300 bash scripts/sigterm-check.sh`.

Saída esperada (os números variam a cada execução):

```
== docker stop (SIGTERM) com 65/500 processadas
   o container parou em 882 ms com exit code 143
   ... LOG [WagerTransactionConsumer] Stopping: 1 message(s) in progress
   ... LOG [WagerTransactionConsumer] Stopped: messages in progress were finished
== estado logo depois do SIGTERM
   transações=74 ledger=74 inbox=74 wallets_com_saldo_errado=0
== estado depois do restart
   transações=500 ledger=500 inbox=500 wallets_com_saldo_errado=0
   fila principal (visíveis, em processamento): 0 0
== OK: nenhuma mensagem perdida ou aplicada duas vezes
```

Como ler:

- **Exit code 143** = o processo terminou pelo `SIGTERM` depois dos hooks de shutdown. **137** = foi morto pelo `SIGKILL` do `docker stop` depois de 30 s, ou seja, o shutdown travou.
- O tempo de parada fica abaixo de 1 s com mensagens curtas. O limite é o long polling em curso (`SQS_CONSUMER_WAIT_TIME_SECONDS`, 2 s no script) mais o `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS`.
- `Stopping: N message(s) in progress` mostra quantas estavam sendo processadas no momento do sinal; `Stopped: ...` confirma que foram concluídas. Se aparecer `Shutdown timeout reached; releasing ...`, elas foram devolvidas à fila e serão reprocessadas com segurança.
- A diferença entre "processadas" no momento do `docker stop` e "logo depois do SIGTERM" são as mensagens concluídas durante o shutdown.
- O script sai com código 1 e `FALHOU` se alguma verificação falhar.

Cada execução deixa no banco de dev as wallets e transações marcadas com `sigterm-<timestamp>` (o ledger é imutável e não pode ser apagado; para limpar tudo, `bun run infra:reset`).

## 8. Problemas conhecidos

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `bun: command not found` | Bun não instalado | usar `npx -y bun@1 <comando>` ou instalar o Bun |
| `infra:up` falha com `Cannot connect to the Docker daemon` / `error during connect` | Docker parado | abrir o Docker Desktop e esperar ele terminar de iniciar |
| `infra:up` falha com `port is already allocated` (5432 ou 4566) | outro PostgreSQL/LocalStack na máquina | parar o outro serviço, ou mudar a porta no `docker-compose.yml` e no `.env` |
| LocalStack nunca fica *healthy* | o script de criação das filas não rodou (sem permissão de execução ou com fim de linha CRLF) | `git ls-files -s docker/localstack/init/ready.d/01-create-queues.sh` deve mostrar `100755`; o `.gitattributes` força LF. Depois, `bun run infra:reset` |
| `/health/ready` → 503 | PostgreSQL ou LocalStack fora (o corpo diz qual) | `bun run infra:up`; volta sozinho a 200 quando a dependência volta |
| `/health/ready` → 503 com `sqs` fora, logo depois de atualizar o código, e log `Event ... not published, will retry: The specified queue does not exist` | o LocalStack em execução foi criado antes da fila de eventos existir no script de init | `docker compose up -d --force-recreate --wait localstack` (ou `bun run infra:reset`) |
| erro `relation "wallets" does not exist` | migrations não aplicadas no banco de dev | `bun run migration:up` |
| testes falham com `ECONNREFUSED` | infra fora do ar | `bun run infra:up` (os unitários rodam sem infra: `bun run test:unit`) |
| sobraram bancos `wagering_test_*` ou filas `wager-test-*` (testes interrompidos no meio) | a limpeza do fim do teste não rodou | ver os comandos logo abaixo |
| log `Queues not available yet: ...` repetido | filas ainda não criadas ou LocalStack fora | a aplicação continua tentando a cada 2 s; conferir `docker compose ps` |
| mensagem demora ~30 s para ser reprocessada depois de um crash | a visibilidade (30 s) só expira depois do timeout; enquanto isso, o grupo FIFO (a wallet) fica bloqueado | esperado; no shutdown gracioso a visibilidade é devolvida na hora |
| no Windows, `kill`/`taskkill` não faz o shutdown gracioso | o Git Bash não entrega `SIGTERM` a um processo nativo do Windows | testar com `scripts/sigterm-check.sh`, que usa um container Linux |
| no container, `docker stop` demora e sai com exit code 0 em vez de 143 | sem init, o Bun é o PID 1 e ignora o sinal que o NestJS re-emite no fim do shutdown | rodar com `docker run --init` (o script já usa) |
| `sigterm-check.sh`: `!! o container parou ao subir` | `bun install --frozen-lockfile` falhou (lockfile desatualizado) ou erro de config | ver as últimas linhas do log que o script imprime; rodar `bun install` no host e repetir |
| `sigterm-check.sh`: app no container não alcança o banco | `host.docker.internal` indisponível | o script passa `--add-host host.docker.internal:host-gateway` (Docker 20.10+); conferir se a infra está no ar no host |
| `npx -y bun@1 -e '<várias linhas>'` imprime a ajuda do Bun e não executa nada (Windows) | o `npx` corta o argumento com quebras de linha | colocar o código num arquivo e rodar `npx -y bun@1 run arquivo.ts` |

Limpar sobras de testes interrompidos:

```bash
docker compose exec -T postgres psql -U wagering -d wagering -tAc \
  "select 'drop database \"' || datname || '\" with (force);' from pg_database where datname like 'wagering_test_%'" \
  | docker compose exec -T postgres psql -U wagering -d wagering
docker compose exec -T localstack sh -c \
  'for q in $(awslocal sqs list-queues --query "QueueUrls[]" --output text | tr "\t" "\n" | grep wager-test-); do awslocal sqs delete-queue --queue-url "$q"; done'
```
