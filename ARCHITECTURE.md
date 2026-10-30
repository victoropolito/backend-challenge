# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas da solução. Ele é atualizado a cada etapa; seções marcadas como **planejado** descrevem o desenho adotado para partes ainda não implementadas.

## 1. Visão geral

```
src/
├── application/            casos de uso; portas Clock, IdGenerator, TransactionRunner; hash canônico
├── domain/                 regras de negócio puras (sem NestJS, sem ORM)
│   ├── shared/             Money, DomainError, backoff, deepFreeze
│   ├── wallet/             Wallet (aggregate root), WalletLedgerEntry, portas de repositório
│   ├── wagering/           WagerTransaction, FailureCode, porta de repositório
│   ├── events/             IntegrationEvent e os 4 eventos de integração
│   └── messaging/          InboxMessage, OutboxMessage, portas de repositório
├── infrastructure/
│   ├── database/           MikroORM: config, migrations, records (EntitySchema), repositórios
│   ├── messaging/          cliente SQS
│   └── system/             relógio do sistema e gerador de UUIDv7
├── contracts/              schemas Zod de entrada compartilhados pela API e pelo consumidor
├── http/                   controllers, validação (Zod), correlation id, filtro de erros
├── consumer/               leitura das mensagens da fila e classificação de falhas
├── health/                 /health/live e /health/ready
└── config/                 variáveis de ambiente validadas com Zod
```

Regra de dependência: `domain` não importa nada de `application`, `infrastructure`, NestJS ou MikroORM; `application` depende só do domínio e das próprias portas (a ligação com o NestJS fica em `ApplicationModule`). A infraestrutura implementa as **portas** declaradas no domínio (`WalletRepository`, `LedgerRepository`, `WagerTransactionRepository`, `InboxRepository`, `OutboxRepository`). As portas são `abstract class`, e não `interface`, porque assim servem ao mesmo tempo de contrato e de token de injeção do NestJS, sem acoplar o domínio ao framework.

Princípio geral: **o banco é a última linha de defesa.** Toda invariante financeira é aplicada no domínio (erro claro e cedo) **e** no schema do PostgreSQL (garantia mesmo diante de bug, concorrência ou acesso direto ao banco).

## 2. Stack

| Item | Escolha |
|---|---|
| Runtime / testes | Bun 1.x (`bun test`) |
| Linguagem | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Framework | NestJS |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 7 (preferencial no enunciado) |
| Mensageria | AWS SQS via LocalStack 3.8 (filas FIFO + DLQ com `maxReceiveCount = 5`) |
| Config | Zod: falha rápida no boot se o ambiente for inválido |

## 3. Domínio

Todas as classes de domínio têm construtor privado e factories estáticas (`create`/`open`/`from`/`receive`/`enqueue` para estado novo, que **validam**; `rehydrate` para estado persistido, que **não** revalida transições). IDs e instantes (`at`) são passados por quem chama: o domínio não gera UUID nem lê o relógio, o que deixa os testes determinísticos.

### 3.1 Money

- Valor interno em **`bigint` de centavos** (escala fixa 2). Nenhum `number` toca dinheiro; não há dependência de biblioteca de decimal.
- `Money.from()` é o contrato de **entrada** (HTTP/SQS): exige string decimal não negativa com até 2 casas (`^(0|[1-9]\d*)(\.\d{1,2})?$`) e normaliza (`"25"` → `"25.00"`). **Mais de 2 casas é rejeitado, nunca arredondado**: arredondar dinheiro recebido de um provider mudaria silenciosamente o valor da operação. Também rejeita `NaN`, `Infinity`, notação científica, string vazia, sinal `+`, zeros à esquerda, vírgula, espaços e valores não-string.
- `Money.rehydrate()` aceita valores negativos (diferenças de reconciliação, deltas) e é usado na leitura do banco.
- Limite de 18 dígitos inteiros, o que cabe em `numeric(20,2)`; operações que estouram lançam erro.
- Moeda: formato ISO-4217 (`^[A-Z]{3}$`). Operações entre moedas diferentes lançam `CurrencyMismatchError`; `equals` entre moedas diferentes retorna `false`.
- Imutável: toda operação retorna uma nova instância.

### 3.2 Wallet e ledger

- `Wallet.open()` cria a wallet com `version = 1`. Um saldo inicial positivo gera o lançamento de abertura (`CREDIT` de `0.00` até o saldo inicial), ligado à transação interna `OPENING`. Com saldo inicial zero não há lançamento.
- `debit()`/`credit()` **retornam o `WalletLedgerEntry`** que criaram: saldo e lançamento nascem juntos, então não há API para mudar um sem o outro. `version` e `updatedAt` só mudam quando o saldo muda; uma operação que falha não altera o estado.
- `WalletLedgerEntry` é estruturalmente imutável (`readonly` + `Object.freeze`, sem métodos de transição). `create()` valida a aritmética (`balanceBefore ± money === balanceAfter`), valor positivo, saldos não negativos e moeda única.
- Ledger de partidas simples: uma transação gera no máximo um lançamento, na wallet do jogador. Partidas dobradas ficaram fora do escopo (diferencial opcional).

### 3.3 WagerTransaction

Máquina de estados (qualquer outra transição lança `InvalidTransactionStateError`, tratada como erro de programação):

```
PENDING ──markProcessed──────────► PROCESSED
   │  ├──reject(code)────────────► REJECTED
   │  └──fail(code)──────────────► FAILED
   └──markPendingReference(next)─► PENDING_REFERENCE ─┐ (repetível: tentativas++)
                                       │  ◄───────────┘
                                       ├─markProcessed─► PROCESSED
                                       ├─reject────────► REJECTED (ex.: REFERENCE_NOT_FOUND)
                                       └─fail──────────► FAILED
```

- `OPENING` só é criada por `createOpening()` (já nasce `PROCESSED`) com o provider reservado `internal`; `create()` recusa tanto o kind `OPENING` quanto esse provider, então nenhuma entrada externa consegue criá-la.
- Referência obrigatória em `REFUND`/`ROLLBACK`, proibida em `BET`, opcional em `WIN`/`LOSS`. Tipos de referência aceitos: `WIN`/`LOSS`/`REFUND` → `BET`; `ROLLBACK` → `BET`/`WIN`/`REFUND`.
- `checkReference(ref)` aplica as regras 7.2, 7.3 e 7.5 (mesmo provider/player/wallet/moeda/rodada, tipo permitido, referência `PROCESSED`, valor igual para reversões) e devolve o `FailureCode` ou nada.
- **Saldo observado:** `markProcessed(referência, saldo, instante)` guarda o saldo da wallet logo após aplicar a transação (para `LOSS`, o saldo atual); `reject(código, { referenceTransactionId, observedBalance })` pode guardar o saldo do momento da rejeição. É esse valor que o replay devolve (regra 7.7), sem recalcular nada.
- `ledgerDirectionFor()`: `BET` → `DEBIT`; `OPENING`/`WIN`/`REFUND` → `CREDIT`; `ROLLBACK` → inverso da referência; `LOSS` não gera lançamento.
- Problemas de formato do pedido (campo vazio, valor inválido) lançam `InvalidWagerTransactionError`, que vira resposta de validação. Eles **não** viram `FailureCode`: não há transação de negócio a registrar.

### 3.4 Códigos de falha

Todo `REJECTED`/`FAILED` carrega um código estável:

| Código | Status | Situação | O que o provider deve fazer |
|---|---|---|---|
| `INSUFFICIENT_BALANCE` | REJECTED | BET maior que o saldo | desistir |
| `REVERSAL_INSUFFICIENT_BALANCE` | REJECTED | ROLLBACK de WIN/REFUND deixaria o saldo negativo | desistir / tratar manualmente |
| `CURRENCY_MISMATCH` | REJECTED | moeda diferente da wallet | corrigir o payload |
| `WALLET_NOT_FOUND` | REJECTED | wallet inexistente | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | REJECTED | wallet não pertence ao `playerId` | corrigir o payload |
| `REFERENCE_NOT_FOUND` | REJECTED | referência não chegou dentro do limite de tentativas | desistir |
| `REFERENCE_MISMATCH` | REJECTED | referência de outro provider/player/wallet/moeda/rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | REJECTED | tipo de referência inválido para a operação | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência existe mas não está `PROCESSED` | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | REJECTED | valor da reversão diferente do valor da referência | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | a referência já foi revertida | desistir (já aplicado) |
| `PROCESSING_ERROR` | FAILED | erro permanente de infraestrutura | auditar |

`INSUFFICIENT_BALANCE` e `REVERSAL_INSUFFICIENT_BALANCE` são distintos de propósito (regra 7.9): uma aposta sem saldo é rotina, uma reversão impossível indica inconsistência operacional entre provider e carteira.

### 3.5 Eventos, inbox e outbox

- `IntegrationEvent<T>` é a classe abstrata do envelope; cada evento concreto fixa `eventType` e `version` no tipo e só é criado por `from()`, que confere o estado da origem (ex.: `WagerTransactionRejected` exige uma transação `REJECTED`).
- `data` contém só JSON estável: `MoneyProps` (nunca a instância de `Money`), datas ISO-8601 e `null` para ausência. É clonado e congelado recursivamente.
- `WagerTransactionProcessed` inclui o saldo observado da transação, inclusive para `LOSS`. `WagerTransactionRejected` inclui o saldo observado quando houver (ou `null`).
- `OutboxMessage.enqueue(event)` usa o próprio `eventId` como id da mensagem: republicações carregam o mesmo id e o consumidor deduplica por ele. Retry com backoff exponencial (1 s até o teto de 5 min) e **sem limite de tentativas**: um evento confirmado não pode ser descartado, e uma falha persistente deve aparecer na métrica de atraso da outbox.
- `InboxMessage` é identificada por `(consumerName, messageId)` e só pode ser marcada como processada uma vez.

### 3.6 Camada de aplicação

- Os casos de uso são classes simples (sem decorators), que recebem as portas no construtor e são registradas no NestJS por factory (`ApplicationModule`).
- **Portas da aplicação:** `Clock` (instante atual), `IdGenerator` (ids internos, **UUIDv7**: ordenados pelo instante de criação, o que mantém os índices B-tree compactos) e `TransactionRunner` (executa um bloco numa transação SQL; a implementação usa `em.transactional()`, e os repositórios chamados dentro do bloco participam da mesma transação via `AsyncLocalStorage`). Os testes usam relógio fixo.
- **Criação de wallet (`CreateWalletUseCase`):** numa única transação SQL grava a wallet e, se o saldo inicial for positivo, a transação `OPENING` (`PROCESSED`), o lançamento `CREDIT` de abertura e dois eventos na outbox: `WagerTransactionProcessed` (da `OPENING`) e `WalletBalanceChanged`. Com saldo zero, grava só a wallet. Se qualquer escrita falhar, nada fica gravado. Wallet duplicada para o mesmo `playerId` + moeda lança `WalletAlreadyExistsError` (conflito), inclusive sob criação concorrente: a unicidade é do banco, e o insert concorrente espera o commit do primeiro e então falha.

- **Submissão de transação (`SubmitWagerTransactionUseCase`):**
  1. Valida o payload (`walletId` UUID; regras de `WagerTransaction.create`) e calcula o `payloadHash`. Payload inválido lança erro e nada é gravado.
  2. **Caminho rápido de idempotência**, sem transação: procura por `(providerId, idempotencyKey)`. Achou com o mesmo hash → replay (`idempotentReplay = true`, transação gravada com o saldo observado original). Achou com outro hash → `IdempotencyConflictError`. Se a chave é nova mas o `externalTransactionId` já existe (sob outra chave) → `ExternalTransactionIdConflictError`.
  3. Abre a transação SQL e trava a wallet (`SELECT ... FOR UPDATE`). **Repete a verificação de idempotência já com o lock**: uma submissão idêntica concorrente na mesma wallet terá sido confirmada antes, e esta vira replay.
  4. `WagerTransactionProcessor` decide e grava tudo na mesma transação: transação, lançamento, saldo (`update` com verificação de versão) e eventos na outbox. Quando a submissão vem da fila, a mensagem de origem é gravada na inbox nessa mesma transação (seção 8.2).
  5. Se mesmo assim o insert colidir na unicidade (concorrência sem lock comum, por exemplo com uma wallet inexistente), a transação é desfeita e a submissão anterior é relida: vira replay ou conflito, nunca duplicação.
- **Ordem das regras no processor:** wallet inexistente (`WALLET_NOT_FOUND`) → wallet de outro jogador (`WALLET_PLAYER_MISMATCH`) → moeda (`CURRENCY_MISMATCH`) → referência (ausente ⇒ `PENDING_REFERENCE`; senão `checkReference`) → reversão única (`REFERENCE_ALREADY_REVERSED`) → saldo (`INSUFFICIENT_BALANCE` para `BET`, `REVERSAL_INSUFFICIENT_BALANCE` para `ROLLBACK` que debitaria) → aplica. Toda rejeição é gravada (auditável e idempotente) e gera `WagerTransactionRejected`.
- O processor é separado do caso de uso para ser reutilizado pelo worker de `PENDING_REFERENCE`: ele aceita uma transação nova (`PENDING`, inserida) ou já gravada (`PENDING_REFERENCE`, atualizada), e quem chama decide o que fazer quando a referência continua ausente (`onMissingReference`). Na submissão, a primeira verificação fica agendada para `agora + 1 s` (backoff exponencial até 60 s; o limite de tentativas entra com o worker).

## 4. Persistência

### 4.1 MikroORM e mapeamento

- **Records separados do domínio.** Cada tabela tem um *record* (interface simples) mapeado com `EntitySchema`. As classes de domínio não são mapeadas, porque têm construtor privado, campos privados e `Money`. Os repositórios convertem record ↔ domínio com `rehydrate`.
- **Mapeamento do `Money`:** duas colunas, `numeric(20,2)` (o MikroORM lê `decimal` como string exata, sem passar por `number`) e `currency char(3)`. A leitura usa `Money.rehydrate({ amount, currency })`.
- **Sem Unit of Work implícito.** Leituras usam `disableIdentityMap: true` (nenhum estado compartilhado ou desatualizado entre operações) e escritas usam `em.insert`/`em.nativeUpdate`. Cada repositório emite exatamente o SQL esperado, e a atomicidade vem de `em.transactional()`: os repositórios chamados dentro dele usam a mesma transação.
  - **Trade-off:** abre-se mão do change tracking do MikroORM em troca de previsibilidade. Num serviço financeiro, um `flush` implícito gravando algo inesperado é um risco maior que o pequeno custo de escrever os updates explicitamente.
- **Violações de unicidade viram erros de domínio**, identificados pelo nome da constraint (`WalletAlreadyExistsError`, `DuplicateWagerTransactionError` com `conflict = EXTERNAL_TRANSACTION_ID | IDEMPOTENCY_KEY | REVERSAL`, `DuplicateInboxMessageError`). Violações de check e de FK sobem como estão, porque indicam bug.
- **Migrations** em TypeScript com SQL escrito à mão, transacionais, versionadas e reversíveis (`down` testado). O schema generator do ORM não é usado, porque não gera checks compostos, índices parciais, FKs compostas nem triggers.

### 4.2 Garantias aplicadas pelo schema

| Tabela | Garantias |
|---|---|
| `wallets` | `unique (player_id, currency)`; `balance >= 0`; `version >= 1`; id, player, moeda e `created_at` imutáveis; sem `DELETE` |
| `wager_transactions` | `unique (provider_id, external_transaction_id)`; `unique (provider_id, idempotency_key)`; `payload_hash` SHA-256 hex; kind/status em lista fechada; `amount > 0` exceto `LOSS`; regras de referência por kind; `OPENING` ⇔ provider `internal`; campos coerentes com o status; **status terminal não muda**; colunas do pedido imutáveis; sem `DELETE` |
| `wager_transactions` (saldo observado) | `observed_balance >= 0`; obrigatório em `PROCESSED`, opcional em `REJECTED`, proibido nos demais status; o lançamento de uma transação termina exatamente no saldo observado dela (`wallet_ledger_entries_observed_balance_check`, verificado no COMMIT) |
| `wager_transactions` (índice) | **reversão única:** `unique (reference_transaction_id) where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')` |
| `wallet_ledger_entries` | `amount > 0`; saldos `>= 0`; aritmética `after = before ± amount`; um lançamento por `(wallet, transação)`; FK composta para `wallets (id, currency)` (moeda do lançamento = moeda da wallet); FK composta para `wager_transactions (id, wallet_id, currency, amount)` (lançamento bate com a transação em wallet, moeda **e valor**); **append-only** (triggers recusam `UPDATE`, `DELETE` e `TRUNCATE`); `sequence` identity para ordem estável |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | `payload` jsonb objeto; mensagem publicada não tem retry agendado; índice parcial das pendentes |

**Saldo materializado = ledger, verificado no COMMIT.** Constraint triggers `deferrable initially deferred` checam, ao fim de cada transação SQL que toca uma wallet ou o ledger:

- `wallet_balance_ledger_check`: `wallets.balance` é igual ao `balance_after` do último lançamento da wallet (ou 0 sem lançamentos);
- `wallet_ledger_entries_chain_check`: cada lançamento começa onde o anterior terminou;
- `wallet_ledger_entries_transaction_check`: só transações `PROCESSED` que não são `LOSS` têm lançamento.

As verificações são adiadas para o commit para permitir a ordem natural dentro da transação: grava a transação `PENDING`, grava o lançamento, atualiza o saldo e marca `PROCESSED`. Com isso, **mudar o saldo sem lançamento, ou o contrário, é impossível mesmo com acesso direto ao banco.**

### 4.3 Decisões de schema

- `wager_transactions.wallet_id` **não tem FK** para `wallets`: uma transação para uma wallet inexistente precisa ser gravada como `REJECTED`/`WALLET_NOT_FOUND`, para ficar auditável e para o replay devolver a mesma resposta. A integridade financeira está nas FKs do ledger. Consequência: `walletId` precisa ter formato UUID, validado na entrada.
- Idempotency key única **por provider**: dois providers podem escolher a mesma chave sem colidir.
- `timestamptz(3)`: precisão de milissegundos, igual ao `Date` do JS (ida e volta exata).
- Ids de provider, player, rodada e jogo são `text` (formato livre do provider); ids internos são `uuid`.

## 5. Concorrência

A unidade de concorrência é a wallet.

- **Lock pessimista por linha:** `WalletRepository.findByIdForUpdate` executa `SELECT ... FOR UPDATE` na wallet. Operações na mesma wallet são serializadas pelo PostgreSQL, valendo para qualquer número de instâncias, já que o lock está no banco e não em memória. Wallets diferentes não se bloqueiam (não há lock global).
- **Verificação de versão como defesa extra:** `update(wallet, expectedVersion)` grava com `WHERE id = ? AND version = ?`. Se nenhuma linha for afetada, lança `WalletConcurrentModificationError` e a transação inteira é desfeita.
- **Por que pessimista e não otimista puro:** numa *hot wallet* (muitas apostas simultâneas no mesmo jogador), o lock otimista gera tempestades de retry e latência imprevisível. O lock pessimista enfileira as operações e cada uma executa uma vez. O custo é manter a transação curta: dentro dela não há chamada de rede (a publicação de eventos sai pela outbox, depois do commit).
- Testado: duas transações disputando a mesma wallet; a segunda fica comprovadamente bloqueada (`pg_stat_activity`, `wait_event_type = 'Lock'`) e, ao entrar, enxerga o saldo já atualizado.
- **Implementado no caso de uso de submissão:** o lock é adquirido antes de qualquer decisão (idempotência, referência, reversão única, saldo), então a decisão sempre vê o estado mais recente da wallet (`READ COMMITTED`: cada comando lê o que já foi confirmado). A referência de uma reversão precisa ser da mesma wallet, então a regra "reverter uma vez" também fica serializada pelo mesmo lock. O índice único de reversão continua como garantia final.
- **Testado com paralelismo real** (conexões concorrentes ao PostgreSQL): o cenário obrigatório (100,00 e duas apostas de 80,00) repetido em 10 wallets ao mesmo tempo; 50 submissões idênticas (1 aplicada, 49 replays, 1 lançamento); 50 apostas numa *hot wallet* (nunca fica negativa; 20 aplicadas, 30 rejeitadas); `REFUND` e `ROLLBACK` simultâneos da mesma aposta (só uma reversão); wallets diferentes em paralelo. Retirando o lock (`findById` no lugar de `findByIdForUpdate`), esses testes falham, o que confirma que eles detectam a corrida.
- **Planejado:** teste com ≥ 3 instâncias da aplicação.

## 6. Idempotência

- **Implementado:** unicidade persistente por `(provider_id, external_transaction_id)` e `(provider_id, idempotency_key)`; `payload_hash` SHA-256 hex obrigatório no schema; `WagerTransaction.matchesPayload(hash)`; conflitos de inserção concorrente traduzidos para `DuplicateWagerTransactionError`.
- **Algoritmo do hash (implementado em `application/shared/payload-hash.ts`):** `payloadHash = hex(SHA-256(UTF-8(canonicalJson(campos))))`, em hexadecimal minúsculo. O JSON canônico segue as regras do RFC 8785 (JCS) para o subconjunto usado: sem espaços; chaves de objeto ordenadas recursivamente por code unit UTF-16; ordem dos arrays preservada; strings e números serializados como no `JSON.stringify`. Valores que não são JSON puro (`undefined`, `NaN`, `Infinity`, `Date`, `bigint`, instâncias de classe) são **recusados**, nunca descartados em silêncio: um campo ausente precisa ser `null` explícito, para que "ausente" e "nulo" não gerem hashes diferentes por acaso. Strings não passam por normalização Unicode.
- **Hash da `OPENING`:** `{ kind: "OPENING", walletId, playerId, money: { amount, currency } }`.
- **Hash da submissão:** `{ providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: { amount, currency }, referenceExternalTransactionId }`, com a referência ausente como `null` e o valor já normalizado pelo `Money` (`"25"` e `"25.00"` são o mesmo pedido). O header `Idempotency-Key`, `correlationId` e metadados de transporte não entram.
- **Replay:** mesma `(providerId, idempotencyKey)` com o mesmo hash devolve a transação gravada (status, código de falha e saldo observado **daquele momento**), com `idempotentReplay = true`; nada é gravado nem publicado de novo. Vale também para rejeições e para `PENDING_REFERENCE` (devolve o estado atual dela).
- **Conflitos:** mesma chave com outro hash → `IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`). `externalTransactionId` já usado sob outra chave → `ExternalTransactionIdConflictError` (`EXTERNAL_TRANSACTION_ID_CONFLICT`): a chave é a fonte da verdade, então chave nova com id antigo não é tratada como replay.
- Nenhuma idempotência depende de memória: as consultas e a unicidade estão no PostgreSQL.

## 7. API HTTP

### 7.1 Status HTTP

O provider decide o que fazer **só pelo status**, sem interpretar mensagens. O mapeamento é o mesmo em todos os endpoints:

| Situação | Status | `code` | O provider pode reenviar? |
|---|---|---|---|
| Transação aplicada | 200 | — | já aplicada (reenvio = replay) |
| Wallet criada | 201 | — | — |
| Referência ausente, processamento adiado (`PENDING_REFERENCE`) | 202 | — | não precisa; acompanhar pelo GET ou pelos eventos |
| Payload inválido (formato, tipo, campo ausente, valor com mais de 2 casas, regra de formato do domínio) | 400 | `VALIDATION_ERROR`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`, `INVALID_WALLET_OPERATION`, `INVALID_CURSOR`, `MALFORMED_REQUEST` | só depois de corrigir |
| Recurso inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | — |
| Conflito: wallet duplicada, idempotency key com outro payload, `externalTransactionId` sob outra chave | 409 | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT` | não com a mesma chave |
| Rejeição por regra de negócio (transação gravada como `REJECTED`) | 422 | corpo traz o `failureCode` | não; ver ação na seção 3.4 |
| Falha transitória de infraestrutura (conexão, deadlock, lock timeout) | 503 + `Retry-After` | `SERVICE_UNAVAILABLE`, `WALLET_CONCURRENT_MODIFICATION` | **sim**, com a mesma chave |
| Erro inesperado (bug) | 500 | `INTERNAL_ERROR` | sim; a submissão é atômica e idempotente |

- **O replay devolve o mesmo status e o mesmo corpo da primeira resposta**, mudando só `idempotentReplay` para `true`: 200 para aplicada, 422 para rejeitada, 202 para pendente (com o estado atual dela).
- Uma rejeição de negócio é **resposta**, não erro: a transação existe, tem id e é consultável. Por isso o corpo do 422 é o mesmo formato da submissão (`transactionId`, `status`, `failureCode`, `balance`, `idempotentReplay`), e não o formato de erro.
- 503 só é usado quando é seguro repetir: a transação SQL foi desfeita por inteiro, e a idempotência garante que um reenvio que encontre a operação já aplicada vira replay.
- Códigos de domínio que não estão na tabela (ex.: `INVALID_TRANSACTION_STATE`) indicam bug e viram 500 sem expor a mensagem interna.

### 7.2 Formato

- **Erro:** `{ code, message, retryable, details?, correlationId }`. Em `VALIDATION_ERROR`, `details` lista `{ path, message }` com o caminho do campo (`body.money.amount`, `headers.idempotency-key`, `query.limit`). Rotas inexistentes e JSON malformado usam o mesmo formato.
- **Submissão:** `{ transactionId, status, failureCode, balance, idempotentReplay }`. `balance` é o saldo observado da transação (`null` quando não há).
- **Consultas** devolvem a transação completa (incluindo referência resolvida, tentativas de referência, `processedAt`) e a wallet com `id`, `playerId`, `balance`, `version`, `createdAt`, `updatedAt`. Valores monetários sempre como `{ amount: "0.00", currency }`.
- `GET /health/ready` mantém o próprio corpo (`{ status, checks }`), com 503 quando alguma dependência está fora.

### 7.3 Validação

- Toda entrada (body, params, query, headers) passa por um schema **Zod** antes de chegar ao caso de uso. Os schemas dos campos da transação ficam em `src/contracts` e são os mesmos do consumidor SQS. Todos os ids (provider, external id, player, rodada, jogo, referência, `Idempotency-Key`, `walletId`, `transactionId`) passam por `trim` antes de qualquer outra regra: o valor aparado é o que entra no hash, é gravado e é usado nas consultas, então `" abc "` e `"abc"` são o mesmo id (e o reenvio de um vira replay do outro). Depois do `trim`, ids de texto têm de 1 a 255 caracteres; `walletId` e `transactionId` precisam ser UUID. `kind` aceita só `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (`OPENING` é interno). `amount` precisa ser string: número JSON é recusado, porque já chegaria arredondado por ponto flutuante.
- Campos desconhecidos no body são ignorados: não entram no hash nem são persistidos.
- `Idempotency-Key` é obrigatório (1 a 255 caracteres). O formato recomendado `{providerId}:{externalTransactionId}` não é imposto.

### 7.4 Correlation id

`X-Correlation-Id` recebido é adotado se tiver até 128 caracteres de `[A-Za-z0-9._:-]`; senão um UUIDv7 é gerado. Ele volta no header da resposta, no corpo de erro e vai para o `correlationId` de todos os eventos gerados pela requisição.

### 7.5 Paginação do ledger

`GET /wallets/:walletId/ledger?cursor=&limit=` devolve `{ items, nextCursor }` em ordem de gravação (`sequence`), `limit` padrão 50 e máximo 200. O cursor é opaco (base64url de `{ wallet, posição }`) e **estável**: o ledger é append-only, então páginas já lidas nunca mudam e lançamentos novos aparecem no fim. Um cursor de outra wallet ou adulterado é recusado (`INVALID_CURSOR`). `nextCursor = null` indica a última página.

## 8. Consumidor SQS

### 8.1 Mensagem

- O corpo é o `WagerTransactionRequested` do enunciado, validado com os **mesmos schemas da API** (mesmos limites, `trim`, UUID, `kind` sem `OPENING`, `amount` como string) e mais: `messageId` (1 a 255 caracteres), `type` fixo, `occurredAt` em ISO-8601 e `data.idempotencyKey` obrigatório.
- A chave da inbox é o **`messageId` do corpo**, e não o `MessageId` do SQS: o do SQS muda a cada envio, enquanto o do corpo continua o mesmo quando o produtor reenvia a mesma mensagem lógica.
- O `messageId` vira o `correlationId` e o `causationId` dos eventos gerados.
- O hash da inbox é o SHA-256 do JSON canônico do **corpo inteiro como recebido** (antes do `trim`). Ele serve só para detectar o mesmo `messageId` com outro conteúdo; a idempotência da transação continua sendo a da seção 6.

### 8.2 Inbox e atomicidade

- `ConsumeWagerTransactionMessageUseCase` consulta a inbox por `(consumerName, messageId)`. Já processada com o mesmo hash → **duplicata** (confirmar sem efeito). Com outro hash → `InboxPayloadConflictError` (`INBOX_PAYLOAD_CONFLICT`).
- Se a mensagem é nova, chama **o mesmo `SubmitWagerTransactionUseCase` da API**, passando a mensagem de origem. A submissão grava a inbox como processada **na mesma transação SQL** do desfecho: transação, lançamento, saldo, outbox e inbox são confirmados juntos ou desfeitos juntos.
- `REJECTED` e `PENDING_REFERENCE` também são desfechos: a inbox é gravada e a mensagem pode ser confirmada.
- Outra mensagem para uma transação já aplicada (reenvio com outro `messageId`) vira replay e também é gravada na inbox, numa transação curta, já que nada financeiro muda.
- Entregas concorrentes da mesma mensagem: a segunda espera o lock da wallet, enxerga a transação como replay e colide na chave primária da inbox. O caso de uso relê a inbox e devolve duplicata.
- A inbox só contém mensagens processadas, porque o registro nasce no commit do desfecho. Um processamento que falha não deixa rastro (rollback), e a próxima entrega recomeça do zero.

### 8.3 Classificação de falhas

| Desfecho | Exemplos | Ação |
|---|---|---|
| Processada | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, duplicata | confirmar (`DeleteMessage`) **depois do commit** |
| Falha permanente | `MALFORMED_MESSAGE`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `INBOX_PAYLOAD_CONFLICT` | DLQ imediatamente: repetir não muda o resultado, e a DLQ preserva a mensagem para análise (pela API seriam 400/409) |
| Falha transitória | erros transitórios do banco (conexão, deadlock, lock timeout), `WALLET_CONCURRENT_MODIFICATION`, `DUPLICATE_INBOX_MESSAGE` sem registro visível | nova tentativa com backoff; esgotado o limite, DLQ |
| Falha inesperada (bug) | qualquer outro erro | tratada como transitória até o limite (pode ser passageira), registrada como erro |

**`FAILED`/`PROCESSING_ERROR` não é produzido pelo consumidor.** Uma falha que esgota as tentativas não tem estado confirmado para anotar, porque a transação SQL foi desfeita por inteiro. Gravar `FAILED` ainda exigiria o banco, que pode ser justamente o que está fora. O registro da falha é a mensagem na DLQ, e reprocessá-la (redrive) é seguro pela idempotência. O status continua no modelo, reservado para falhas permanentes de transações já gravadas (worker de `PENDING_REFERENCE`).

### 8.4 Loop de consumo (**planejado**)

Long polling na fila FIFO; mensagens do mesmo `MessageGroupId` processadas em ordem e grupos diferentes em paralelo; `DeleteMessage` só depois do commit; nova tentativa via `ChangeMessageVisibility` com backoff calculado pelo `ApproximateReceiveCount`; envio explícito à DLQ (falha permanente ou limite esgotado), com o motivo em atributos da mensagem; `RedrivePolicy` com `maxReceiveCount = 5` como rede de segurança; shutdown gracioso (para de receber, conclui as mensagens em andamento e devolve a visibilidade das que não começaram).

## 9. Interpretações adotadas

| Tema | Interpretação | Motivo |
|---|---|---|
| Reversão única (regra 7.4) | Uma transação é revertida **no máximo uma vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`), e não "uma vez por tipo" | Com "uma vez por tipo", uma `BET` poderia receber `REFUND` **e** `ROLLBACK`, devolvendo o valor duas vezes, o que violaria o invariante "não duplicar créditos" |
| Arredondamento | Valores com mais de 2 casas são rejeitados, não arredondados | Arredondar mudaria em silêncio o valor de uma operação financeira |
| Eventos da abertura de wallet | A `OPENING` gera `WagerTransactionProcessed` **e** `WalletBalanceChanged`; wallet com saldo zero não gera evento | "Qualquer transação aplicada" inclui a transação interna de abertura, e o saldo mudou de 0 para o inicial |
| `LOSS` | Aceita valor zero; não gera lançamento nem `WalletBalanceChanged`, mas gera `WagerTransactionProcessed` | `LOSS` apenas registra o resultado da rodada |
| `WIN`/`LOSS` com referência | Opcional; quando presente, deve apontar para uma `BET` da mesma rodada; o valor de `WIN` pode diferir do da `BET` | Um prêmio não tem o valor da aposta |
| Referência ainda pendente | Se a referência existe mas está `PENDING_REFERENCE` (esperando a própria referência), a transação também fica `PENDING_REFERENCE`, em vez de ser rejeitada com `REFERENCE_NOT_PROCESSED` | A referência ainda pode ser processada; rejeitar agora dependeria da ordem de chegada |
| Referência ausente em `WIN`/`LOSS` | Quando informada e ainda não recebida, também gera `PENDING_REFERENCE` | A regra 8 do enunciado vale para qualquer referência ausente |
| Saldo em rejeições | Rejeições depois da validação da wallet guardam e devolvem o saldo do momento; `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` não devolvem saldo | Não expor o saldo da wallet de outro jogador; na moeda errada, não há saldo comparável |
| Mesmo `externalTransactionId` com outra idempotency key | Conflito, não replay | O header é a fonte da verdade da idempotência |
| Moeda | Escala 2 para qualquer moeda; o desafio usa `BRL`, mas o modelo é multi-moeda | Simplificação permitida pelo enunciado |

## 10. Limitações conhecidas

- Depois de `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a `BET` não pode ser revertida de novo (o índice de reversão única continua vendo o `REFUND` processado). É um caso raro e o comportamento é conservador.
- `WalletBalanceChanged.from` identifica o lançamento mais recente comparando o saldo final com o saldo atual; um lançamento antigo com o mesmo saldo final passaria. O risco é baixo, porque o evento é criado logo após o movimento.
- A imutabilidade do ledger é garantida por trigger, que vale para qualquer role. Restringir permissões por role no banco (aplicação sem `UPDATE`/`DELETE`) ficou de fora, porque o ambiente local usa um único usuário.
- Ledger de partidas simples (sem conta de contrapartida da casa).
- Um `WIN` que referencia uma `BET` já reembolsada ainda é aceito: a regra de reversão única cobre só `REFUND`/`ROLLBACK`.
- O status `FAILED`/`PROCESSING_ERROR` ainda não é produzido: erros de infraestrutura desfazem a transação SQL inteira e são repetidos (HTTP 503 ou nova entrega da fila). Ver a seção 8.3.

## 11. Testes

- **Unitários** (`test/unit`): JSON canônico e hash do payload, `Money` (escala, entradas inválidas, conflito de moeda, ausência de arredondamento), invariantes da `Wallet`, máquina de estados e regras de referência da `WagerTransaction`, eventos, inbox, outbox e backoff.
- **Unitários da API e do consumidor:** mapeamento de exceções para status, classificação de erros transitórios do banco, leitura e validação das mensagens da fila (hash independente da ordem das chaves, corpo inválido) e classificação de falhas (permanente, transitória, inesperada).
- **Integração** (`test/integration`): PostgreSQL real; cada arquivo cria um banco descartável `wagering_test_<aleatório>`, aplica as migrations e o remove ao final. Cada constraint é testada pelo SQLSTATE **e** pelo nome, garantindo que a recusa veio da regra certa. Repositórios testados com ida e volta exata, tradução de conflitos e lock concorrente. Casos de uso testados de ponta a ponta no banco (todas as regras de negócio, idempotência e concorrência real; ver seção 5), montados como na aplicação (EntityManager global roteado para a transação): atomicidade (falha no meio desfaz tudo), conflito e criação concorrente da mesma wallet (10 em paralelo → exatamente uma). A API é testada com a aplicação Nest real (HTTP de verdade, `fetch`) sobre um banco descartável: status e corpo de cada situação da seção 7.1, replay com o mesmo status, paginação completa do ledger, cursor inválido, JSON malformado, correlation id chegando aos eventos e o cenário 100/80/80 por HTTP. O consumo de mensagens é testado no banco real: inbox gravada com o desfecho, redelivery como duplicata, mesmo `messageId` com outro conteúdo, reenvio com outro `messageId` como replay, rejeição e `PENDING_REFERENCE` registrados, conflito sem inbox, rollback da inbox junto com transação, ledger e eventos (falha injetada na outbox), a mesma mensagem 20 vezes em paralelo e 50 mensagens diferentes para a mesma transação em paralelo (um único débito).
- Nenhum mock de banco. **Planejado:** LocalStack nos testes de mensageria, testes de concorrência com paralelismo real e múltiplos processos, crash e restart.

## 12. Pendências

Loop do consumidor SQS (ack, retry, DLQ, shutdown gracioso; seção 8.4); publisher da outbox concorrente (`FOR UPDATE SKIP LOCKED`); worker de `PENDING_REFERENCE`; reconciliação; logs estruturados e métricas; autenticação (decisão a documentar); testes de concorrência e de falha; README de setup.
