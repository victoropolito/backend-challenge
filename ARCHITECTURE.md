# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas da solução. Como subir o ambiente, rodar e validar manualmente (inclusive o shutdown com `SIGTERM` real) está em [`docs/execucao-e-validacao.md`](docs/execucao-e-validacao.md). Ele é atualizado a cada etapa; seções marcadas como **planejado** descrevem o desenho adotado para partes ainda não implementadas.

## 1. Visão geral

```
src/
├── application/            casos de uso; portas Clock, IdGenerator, TransactionRunner; hash canônico
├── domain/                 regras de negócio puras (sem NestJS, sem ORM)
│   ├── shared/             Money, DomainError, backoff, deepFreeze
│   ├── wallet/             Wallet (aggregate root), WalletLedgerEntry, portas de repositório
│   ├── wagering/           WagerTransaction, FailureCode, porta de repositório
│   ├── events/             IntegrationEvent e os 5 eventos de integração
│   └── messaging/          InboxMessage, OutboxMessage, portas de repositório
├── infrastructure/
│   ├── database/           MikroORM: config, migrations, records (EntitySchema), repositórios
│   ├── messaging/          cliente SQS e publisher de eventos (SqsEventPublisher)
│   └── system/             relógio do sistema e gerador de UUIDv7
├── contracts/              schemas Zod de entrada compartilhados pela API e pelo consumidor
├── http/                   controllers, validação (Zod), correlation id, filtro de erros
├── consumer/               consumidor SQS: leitura das mensagens, classificação de falhas, loop, DLQ, shutdown
├── workers/                processos em segundo plano: publisher da outbox e worker de PENDING_REFERENCE
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
| Mensageria | AWS SQS via LocalStack 3.8: fila FIFO de transações + DLQ (`maxReceiveCount = 5`) e fila FIFO de eventos |
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
| `PROCESSING_ERROR` | FAILED | uma transação `PENDING_REFERENCE` falhou com erro inesperado em todas as verificações até o limite (seção 10.3) | auditar |

`INSUFFICIENT_BALANCE` e `REVERSAL_INSUFFICIENT_BALANCE` são distintos de propósito (regra 7.9): uma aposta sem saldo é rotina, uma reversão impossível indica inconsistência operacional entre provider e carteira.

### 3.5 Eventos, inbox e outbox

- `IntegrationEvent<T>` é a classe abstrata do envelope; cada evento concreto fixa `eventType` e `version` no tipo e só é criado por `from()`, que confere o estado da origem (ex.: `WagerTransactionRejected` exige uma transação `REJECTED`).
- `data` contém só JSON estável: `MoneyProps` (nunca a instância de `Money`), datas ISO-8601 e `null` para ausência. É clonado e congelado recursivamente.
- `WagerTransactionProcessed` inclui o saldo observado da transação, inclusive para `LOSS`. `WagerTransactionRejected` inclui o saldo observado quando houver (ou `null`). `WagerTransactionFailed` traz o `failureCode` (`PROCESSING_ERROR`) e é emitido só pelo worker de `PENDING_REFERENCE`.
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
- O processor é separado do caso de uso para ser reutilizado pelo worker de `PENDING_REFERENCE`: ele aceita uma transação nova (`PENDING`, inserida) ou já gravada (`PENDING_REFERENCE`, atualizada), e quem chama decide o que fazer quando a referência continua ausente (`onMissingReference`, que recebe a referência encontrada, se ela existe mas ainda espera, e o saldo do momento). Na submissão, a primeira verificação fica agendada para `agora + 1 s`; as seguintes, e o limite, são do worker (seção 10).
- Quando uma transação termina (`PROCESSED`, `REJECTED` ou `FAILED`), o processor antecipa para agora a próxima verificação das transações `PENDING_REFERENCE` da mesma wallet que esperam por ela (`scheduleReferenceChecksFor`), na mesma transação SQL. Assim, quem chegou antes da referência é aplicado no próximo ciclo do worker, e não só no fim do backoff.

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
| Rejeição por regra de negócio (transação gravada como `REJECTED`), ou transação que terminou `FAILED` | 422 | corpo traz o `failureCode` | não; ver ação na seção 3.4 |
| Falha transitória de infraestrutura (conexão, deadlock, lock timeout) | 503 + `Retry-After` | `SERVICE_UNAVAILABLE`, `WALLET_CONCURRENT_MODIFICATION` | **sim**, com a mesma chave |
| Erro inesperado (bug) | 500 | `INTERNAL_ERROR` | sim; a submissão é atômica e idempotente |

- **O replay devolve o mesmo status e o mesmo corpo da primeira resposta**, mudando só `idempotentReplay` para `true`: 200 para aplicada, 422 para rejeitada, 202 para pendente (com o estado atual dela). Uma transação que estava `PENDING_REFERENCE` e já terminou responde pelo estado atual (200, ou 422 para `REJECTED` e `FAILED`).
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

**`FAILED`/`PROCESSING_ERROR` não é produzido pelo consumidor.** Uma falha que esgota as tentativas não tem estado confirmado para anotar, porque a transação SQL foi desfeita por inteiro. Gravar `FAILED` ainda exigiria o banco, que pode ser justamente o que está fora. O registro da falha é a mensagem na DLQ, e reprocessá-la (redrive) é seguro pela idempotência. O status é produzido só pelo worker de `PENDING_REFERENCE`, para transações já gravadas (seção 10.3).

### 8.4 Loop de consumo

`SqsWagerTransactionConsumer`, ligado ao ciclo de vida do NestJS por `ConsumerModule`:

- **Recebimento:** long polling (`WaitTimeSeconds`, padrão 10 s), lotes de até 10 mensagens, `VisibilityTimeout` de 30 s, pedindo `ApproximateReceiveCount` e `MessageGroupId`. Uma falha ao receber (SQS fora) é registrada, e o loop tenta de novo após 1 s, sem derrubar a aplicação.
- **Ordem:** as mensagens do lote são agrupadas por `MessageGroupId`. Grupos diferentes rodam em paralelo; dentro de um grupo, as mensagens são processadas uma a uma, na ordem da fila. O produtor deve usar o `walletId` como grupo, o que dá ordem por wallet e paralelismo entre wallets. A correção não depende dessa ordem, porque o lock da wallet e o `PENDING_REFERENCE` cobrem chegadas fora de ordem.
- **Ack:** `DeleteMessage` só depois que o caso de uso retornou, ou seja, depois do commit. Se o processo morrer entre o commit e o ack, a mensagem volta e é confirmada como duplicata pela inbox, sem efeito.
- **Nova tentativa:** a falha transitória não confirma a mensagem. A visibilidade é trocada para o backoff da tentativa (`ApproximateReceiveCount`): 1 s, 2 s, 4 s… até 60 s. As mensagens seguintes do mesmo grupo no lote são devolvidas sem processar, para não passarem na frente.
- **DLQ:** em falha permanente, ou transitória na última tentativa (`SQS_CONSUMER_MAX_ATTEMPTS`, padrão 5), a mensagem é **enviada explicitamente** à DLQ e então apagada da fila principal. Ela leva o corpo original, o mesmo `MessageGroupId`, `MessageDeduplicationId` = `MessageId` de origem e atributos `failureKind`, `failureCode`, `failureMessage`, `sourceMessageId` e `receiveCount`. O envio explícito registra o motivo; a `RedrivePolicy` da fila (`maxReceiveCount = 5`) continua como rede de segurança para mensagens que derrubam o processo antes de qualquer decisão. O limite da aplicação não deve passar do `maxReceiveCount`.
- **Falha do próprio SQS ao confirmar, repetir ou mandar à DLQ:** é registrada e ignorada. A mensagem volta quando a visibilidade expira e é reprocessada com segurança, pela inbox e pela idempotência.
- **Shutdown gracioso** (`beforeApplicationShutdown`, antes de o banco e o cliente SQS fecharem):
  1. o consumidor para de pedir mensagens; o long polling em curso termina normalmente, porque abortá-lo poderia deixar mensagens recebidas, e não entregues, invisíveis até o timeout;
  2. as mensagens já recebidas que ainda não começaram são devolvidas com visibilidade 0;
  3. as que estão em processamento são concluídas e confirmadas;
  4. se passar de `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` (padrão 20 s), as que restarem são devolvidas, e o resultado delas não é mais confirmado pela instância que está saindo. Se o commit acontecer mesmo assim, a próxima entrega vira duplicata.
- **Em container**, a aplicação precisa de um init como PID 1 (`docker run --init`, tini). Ao fim dos hooks, o NestJS re-emite o sinal recebido para encerrar o processo, e o PID 1 ignora sinais sem handler: sem init, o processo só termina quando o event loop esvazia.
- **Configuração:** `SQS_CONSUMER_ENABLED`, `SQS_CONSUMER_WAIT_TIME_SECONDS`, `SQS_CONSUMER_BATCH_SIZE`, `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS`, `SQS_CONSUMER_MAX_ATTEMPTS`, `SQS_CONSUMER_RETRY_BASE_DELAY_MS`, `SQS_CONSUMER_RETRY_MAX_DELAY_MS`, `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS`.
- No boot, as URLs das filas são resolvidas pelo nome. Se o SQS ainda não estiver acessível, o módulo tenta de novo a cada 2 s, sem impedir a API de subir.

## 9. Publicação de eventos (outbox)

### 9.1 Destino

O enunciado não define para onde os eventos vão. Eles são publicados na fila **FIFO `wagering-events.fifo`**, criada pelo script de init do LocalStack junto com as outras, para não acrescentar outro serviço (SNS, Kafka) à stack:

- corpo = envelope do evento (`toJSON()` gravado no `payload` da outbox), sem transformação;
- `MessageGroupId` = `aggregateId` (transação ou wallet);
- `MessageDeduplicationId` = `eventId`: o SQS descarta uma republicação do mesmo evento dentro de 5 min;
- atributos `eventType` e `eventId`, para filtrar sem abrir o corpo.

Ninguém consome essa fila neste projeto; ela representa o destino dos sistemas downstream. Trocar o destino é implementar outra `EventPublisher` (porta da aplicação).

### 9.2 Algoritmo

Cada lote é **uma transação SQL** (`PublishOutboxUseCase`):

1. `claimDue`: `SELECT ... FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now) ORDER BY next_attempt_at NULLS FIRST, sequence LIMIT n FOR UPDATE SKIP LOCKED`, usando o índice parcial de pendentes. Mensagens travadas por outro publisher são **puladas**, e não esperadas: publishers concorrentes dividem a outbox sem disputa.
2. Publica as mensagens travadas (`SendMessageBatch`, até 10 por chamada, com timeout de 5 s).
3. Na mesma transação, marca as aceitas como publicadas (`markPublished`) e agenda nova tentativa para as recusadas (`scheduleRetry`: 1 s, 2 s, 4 s… até 5 min, **sem limite**, porque um evento confirmado não pode ser descartado).
4. Commit, que libera as travas.

**Por que manter a trava durante a publicação**, em vez de marcar um "lease" e soltar a transação: se o processo morrer, o PostgreSQL desfaz a transação e libera as linhas na hora, e outro publisher as pega no lote seguinte. Não há prazo de lease a calibrar nem coluna extra. O custo é uma conexão e uma transação abertas durante a chamada ao SQS, limitada pelo timeout.

### 9.3 Garantias

- **Nada é publicado antes do commit:** o publisher só lê linhas confirmadas da outbox, e a outbox é gravada na mesma transação da mudança de estado.
- **Nada confirmado se perde:** uma linha só sai de pendente quando o SQS aceitou a mensagem e a marcação foi confirmada.
- **Entrega pelo menos uma vez, com duplicata possível e segura:** se o processo morrer (ou a chamada estourar o timeout) depois de o SQS aceitar e antes do commit, o lote volta a pendente e é republicado **com o mesmo `eventId`**. Dentro de 5 min o próprio SQS FIFO descarta a cópia; depois disso o consumidor deduplica pelo `eventId`.
- Cenário do enunciado: (1) o PostgreSQL confirma; (2) o processo morre antes de publicar; (3) qualquer outra instância, no próximo lote, encontra as linhas pendentes, que não estão travadas por ninguém; (4) publica; (5) a republicação eventual tem o mesmo `eventId`.

### 9.4 Worker

`OutboxPublisherWorker`, ligado ao NestJS por `OutboxPublisherModule`, roda em todas as instâncias:

- repete lotes sem pausa enquanto eles vêm cheios; quando a outbox esvazia, ou houve falha, espera `OUTBOX_IDLE_DELAY_MS` (500 ms);
- erro inesperado no lote (banco fora, por exemplo) é registrado, e o loop continua depois da espera;
- no shutdown, interrompe a espera e conclui o lote em andamento, que dura no máximo o timeout da publicação.

Configuração: `SQS_EVENTS_QUEUE_NAME`, `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_BATCH_SIZE` (10), `OUTBOX_IDLE_DELAY_MS` (500), `OUTBOX_PUBLISH_TIMEOUT_MS` (5000). O readiness também confere a fila de eventos.

## 10. Referências fora de ordem (`PENDING_REFERENCE`)

### 10.1 Algoritmo

`RecheckPendingReferencesUseCase` processa um lote de transações vencidas (`status = 'PENDING_REFERENCE' AND next_reference_check_at <= agora`, pelo índice parcial `wager_transactions_pending_reference_due_idx`, das mais atrasadas para as mais recentes). Cada uma é reverificada na **própria transação SQL**:

1. trava a wallet (`SELECT ... FOR UPDATE`), o mesmo lock da submissão;
2. relê a transação; se ela já não está `PENDING_REFERENCE` ou não está mais vencida, outra instância chegou antes, e ela é pulada;
3. chama o mesmo `WagerTransactionProcessor` da submissão, com as mesmas regras e na mesma ordem: referência encontrada → aplica ou rejeita (`checkReference`, reversão única, saldo); ainda ausente → próxima verificação com backoff, ou rejeição no limite;
4. commit.

A busca dos vencidos não trava nada: travar a linha da transação antes da wallet inverteria a ordem de locks da submissão (wallet → linhas) e abriria espaço para deadlock. Duas instâncias podem pegar o mesmo candidato. Elas se serializam no lock da wallet, e a segunda o encontra já tratado no passo 2, então nunca há aplicação dupla.

### 10.2 Backoff e limite

- **Backoff exponencial** de 1 s a 60 s (`DEFAULT_REFERENCE_CHECK_POLICY`): 1 s, 2 s, 4 s… até 60 s entre verificações.
- **Limite:** `REFERENCE_CHECK_MAX_ATTEMPTS` verificações (padrão **15**, contando a da submissão), ou cerca de **9 minutos** entre a chegada e a desistência. O prazo cobre o atraso normal de uma referência que chegou fora de ordem, inclusive se a mensagem dela precisou de todas as novas tentativas do consumidor (5 tentativas com backoff de até 60 s, cerca de 3 min). Ele também evita que uma transação fique "em aberto" indefinidamente para o provider.
- **Esgotado o limite:** `REJECTED` com `REFERENCE_NOT_FOUND`, guardando o saldo do momento, e `WagerTransactionRejected` publicado. Se a referência existe mas ainda está esperando a própria referência, o código é `REFERENCE_NOT_PROCESSED`, com o id dela.
- **Antecipação:** quando a referência chega e termina, as transações que esperavam por ela são reagendadas para agora (seção 3.6). Na prática, uma transação fora de ordem é aplicada em até `REFERENCE_WORKER_IDLE_DELAY_MS` (1 s) depois da chegada da referência. O backoff só determina quanto tempo ela espera **enquanto** a referência não chega.
- `WagerTransactionPendingReference` é publicado só na entrada em `PENDING_REFERENCE`; as novas verificações não repetem o evento.

### 10.3 Falhas

- **Erro transitório do banco** (conexão, deadlock, lock timeout): não conta como tentativa. A transação continua vencida e é reverificada no próximo ciclo.
- **Erro inesperado** (bug, dado que o processor não consegue tratar): conta como tentativa. A transação é reagendada com o backoff, numa transação SQL separada, para não ficar presa no topo da fila. No limite, termina `FAILED` com `PROCESSING_ERROR`, e `WagerTransactionFailed` é publicado. É o único caminho que produz `FAILED`: a transação já estava gravada, então há um estado a registrar (diferente do consumidor; ver seção 8.3).
- Os eventos das verificações têm `correlationId` novo e `causationId` = id da transação, porque o correlation id da requisição original não é guardado.

### 10.4 Worker

`PendingReferenceWorker`, ligado ao NestJS por `PendingReferenceModule`, roda em todas as instâncias. O loop é o mesmo do publisher da outbox (`PollingLoop`): sem pausa enquanto os lotes vêm cheios; espera `REFERENCE_WORKER_IDLE_DELAY_MS` (1 s) quando não há mais vencidas ou houve erro; no shutdown, interrompe a espera e conclui o lote em andamento. Erros por transação são registrados e não interrompem o lote.

Configuração: `REFERENCE_WORKER_ENABLED`, `REFERENCE_WORKER_BATCH_SIZE` (20), `REFERENCE_WORKER_IDLE_DELAY_MS` (1000), `REFERENCE_CHECK_MAX_ATTEMPTS` (15).

## 11. Interpretações adotadas

| Tema | Interpretação | Motivo |
|---|---|---|
| Reversão única (regra 7.4) | Uma transação é revertida **no máximo uma vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`), e não "uma vez por tipo" | Com "uma vez por tipo", uma `BET` poderia receber `REFUND` **e** `ROLLBACK`, devolvendo o valor duas vezes, o que violaria o invariante "não duplicar créditos" |
| Arredondamento | Valores com mais de 2 casas são rejeitados, não arredondados | Arredondar mudaria em silêncio o valor de uma operação financeira |
| Eventos da abertura de wallet | A `OPENING` gera `WagerTransactionProcessed` **e** `WalletBalanceChanged`; wallet com saldo zero não gera evento | "Qualquer transação aplicada" inclui a transação interna de abertura, e o saldo mudou de 0 para o inicial |
| `LOSS` | Aceita valor zero; não gera lançamento nem `WalletBalanceChanged`, mas gera `WagerTransactionProcessed` | `LOSS` apenas registra o resultado da rodada |
| `WIN`/`LOSS` com referência | Opcional; quando presente, deve apontar para uma `BET` da mesma rodada; o valor de `WIN` pode diferir do da `BET` | Um prêmio não tem o valor da aposta |
| Referência ainda pendente | Se a referência existe mas está `PENDING_REFERENCE` (esperando a própria referência), a transação também fica `PENDING_REFERENCE`, em vez de ser rejeitada com `REFERENCE_NOT_PROCESSED` | A referência ainda pode ser processada; rejeitar agora dependeria da ordem de chegada |
| Referência ausente em `WIN`/`LOSS` | Quando informada e ainda não recebida, também gera `PENDING_REFERENCE` | A regra 8 do enunciado vale para qualquer referência ausente |
| Limite de `PENDING_REFERENCE` | 15 verificações com backoff de 1 s a 60 s (cerca de 9 min) | Cobre o atraso normal de uma referência fora de ordem, inclusive com as novas tentativas do consumidor, e dá ao provider uma resposta definitiva em minutos (seção 10.2) |
| Referência ainda pendente no limite | `REFERENCE_NOT_PROCESSED` (com o id da referência), e não `REFERENCE_NOT_FOUND` | A referência existe; o problema é que ela não foi aplicada |
| Saldo em rejeições | Rejeições depois da validação da wallet guardam e devolvem o saldo do momento; `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` não devolvem saldo | Não expor o saldo da wallet de outro jogador; na moeda errada, não há saldo comparável |
| Mesmo `externalTransactionId` com outra idempotency key | Conflito, não replay | O header é a fonte da verdade da idempotência |
| Moeda | Escala 2 para qualquer moeda; o desafio usa `BRL`, mas o modelo é multi-moeda | Simplificação permitida pelo enunciado |

## 12. Limitações conhecidas

- **Ordem dos eventos entre publishers:** um lote é publicado na ordem de gravação, mas dois publishers podem pegar eventos consecutivos do mesmo agregado em lotes diferentes, e o segundo lote pode chegar antes. Os consumidores devem usar `walletVersion` (em `WalletBalanceChanged`) e `occurredAt` para ordenar, e não a ordem de chegada.
- Linhas publicadas da outbox não são apagadas: a tabela cresce sem limite. Uma rotina de limpeza (apagar publicadas com mais de N dias) fica para depois.
- Um evento que o SQS recusa sempre (por exemplo, corpo acima de 256 KB) fica sendo tentado para sempre, a cada 5 min. É o comportamento desejado para não perder evento; o sinal para agir é a métrica de atraso da outbox (planejada).
- O consumidor não estende a visibilidade durante o processamento (sem *heartbeat*): uma mensagem que demore mais que o `VisibilityTimeout` (30 s) pode ser entregue a outra instância ao mesmo tempo. Isso é seguro (inbox, lock e idempotência), mas gasta trabalho; o processamento normal leva milissegundos.
- Cada instância tem um único loop de recebimento: o próximo lote só é pedido depois que o anterior termina. O paralelismo vem dos grupos dentro do lote e do número de instâncias.
- Devolver a visibilidade no shutdown conta como uma entrega a mais (`ApproximateReceiveCount`), e reinícios seguidos podem aproximar uma mensagem do limite da DLQ.
- Depois de `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a `BET` não pode ser revertida de novo (o índice de reversão única continua vendo o `REFUND` processado). É um caso raro e o comportamento é conservador.
- `WalletBalanceChanged.from` identifica o lançamento mais recente comparando o saldo final com o saldo atual; um lançamento antigo com o mesmo saldo final passaria. O risco é baixo, porque o evento é criado logo após o movimento.
- A imutabilidade do ledger é garantida por trigger, que vale para qualquer role. Restringir permissões por role no banco (aplicação sem `UPDATE`/`DELETE`) ficou de fora, porque o ambiente local usa um único usuário.
- Ledger de partidas simples (sem conta de contrapartida da casa).
- Um `WIN` que referencia uma `BET` já reembolsada ainda é aceito: a regra de reversão única cobre só `REFUND`/`ROLLBACK`.
- `FAILED`/`PROCESSING_ERROR` só é produzido pelo worker de `PENDING_REFERENCE`. Na submissão, erros de infraestrutura desfazem a transação SQL inteira e são repetidos (HTTP 503 ou nova entrega da fila); ver a seção 8.3.
- Uma transação rejeitada com `REFERENCE_NOT_FOUND` não é revivida se a referência chegar depois: o provider precisa reenviá-la com outra idempotency key (a mesma chave devolve a rejeição original).
- Instâncias diferentes do worker de `PENDING_REFERENCE` podem buscar os mesmos candidatos e se serializar no lock da wallet: a segunda só descobre que a transação já foi tratada. É trabalho repetido, sem efeito na correção; com muitas pendentes, o ganho de mais instâncias é menor que no publisher da outbox, que divide o trabalho com `SKIP LOCKED`.
- A antecipação da verificação vale só para transações da mesma wallet da referência; as de outra wallet seriam rejeitadas por `REFERENCE_MISMATCH` de qualquer forma, e isso acontece na próxima verificação agendada delas.

## 13. Testes

- **Unitários** (`test/unit`): JSON canônico e hash do payload, `Money` (escala, entradas inválidas, conflito de moeda, ausência de arredondamento), invariantes da `Wallet`, máquina de estados e regras de referência da `WagerTransaction`, eventos, inbox, outbox e backoff.
- **Unitários da API e do consumidor:** mapeamento de exceções para status, classificação de erros transitórios do banco, leitura e validação das mensagens da fila (hash independente da ordem das chaves, corpo inválido) e classificação de falhas (permanente, transitória, inesperada).
- **Integração** (`test/integration`): PostgreSQL real; cada arquivo cria um banco descartável `wagering_test_<aleatório>`, aplica as migrations e o remove ao final. Cada constraint é testada pelo SQLSTATE **e** pelo nome, garantindo que a recusa veio da regra certa. Repositórios testados com ida e volta exata, tradução de conflitos e lock concorrente. Casos de uso testados de ponta a ponta no banco (todas as regras de negócio, idempotência e concorrência real; ver seção 5), montados como na aplicação (EntityManager global roteado para a transação): atomicidade (falha no meio desfaz tudo), conflito e criação concorrente da mesma wallet (10 em paralelo → exatamente uma). A API é testada com a aplicação Nest real (HTTP de verdade, `fetch`) sobre um banco descartável: status e corpo de cada situação da seção 7.1, replay com o mesmo status, paginação completa do ledger, cursor inválido, JSON malformado, correlation id chegando aos eventos e o cenário 100/80/80 por HTTP. O consumo de mensagens é testado no banco real: inbox gravada com o desfecho, redelivery como duplicata, mesmo `messageId` com outro conteúdo, reenvio com outro `messageId` como replay, rejeição e `PENDING_REFERENCE` registrados, conflito sem inbox, rollback da inbox junto com transação, ledger e eventos (falha injetada na outbox), a mesma mensagem 20 vezes em paralelo e 50 mensagens diferentes para a mesma transação em paralelo (um único débito).
- **Consumidor SQS no LocalStack real** (filas FIFO e DLQ descartáveis por teste, com a mesma `RedrivePolicy`): aplicação e confirmação após o commit, rejeição de negócio confirmada sem retry, redelivery e reenvio aplicados uma vez, mensagem já commitada antes de um "crash" confirmada sem reaplicar, mensagem malformada e conflito de idempotência direto para a DLQ com os atributos de falha, falha transitória repetida com backoff até dar certo, tentativas esgotadas indo para a DLQ, ordem dentro do grupo com grupos em paralelo, shutdown que espera a mensagem em andamento e para de receber, e timeout de shutdown que devolve a visibilidade (outra instância processa logo, sem esperar os 30 s). Mais um teste sobe a aplicação Nest real com o consumidor ligado pela config e o para no `close()`. Mutações conferidas: sem devolver a visibilidade e sem ordem por grupo, os testes falham.
- **Shutdown com `SIGTERM` real** (`scripts/sigterm-check.sh`, manual): a aplicação num container Linux recebe `docker stop` no meio de uma rajada de mensagens; o script confere transações = ledger = inbox e saldos corretos logo depois do sinal e, após o restart, que tudo foi aplicado exatamente uma vez. Ver `docs/execucao-e-validacao.md` §7.
- **Outbox:** o caso de uso de publicação é testado no banco real com um publisher em memória: ordem de gravação, tamanho do lote, mensagens ainda não vencidas puladas, recusa parcial com backoff, destino fora do ar com nova tentativa depois, um segundo publisher pulando as linhas travadas pelo primeiro, 5 publishers concorrentes sobre 200 mensagens (cada uma publicada exatamente uma vez) e morte depois de publicar e antes do commit (republicação com o mesmo id). O `SqsEventPublisher` e o worker são testados no LocalStack real: formato da mensagem, deduplicação pelo `eventId`, fila inexistente, eventos gravados com nenhum publisher no ar sendo publicados depois, 3 workers simultâneos (cada evento recebido uma vez) e parada rápida. Mutações conferidas: sem a trava, há publicação duplicada; com `FOR UPDATE` sem `SKIP LOCKED`, os publishers ficam esperando uns pelos outros.
- **`PENDING_REFERENCE`:** o caso de uso de reverificação é testado no banco real, com relógio controlado: `WIN` aplicado logo que a `BET` chega (verificação antecipada pela chegada), transação não verificada antes do vencimento, novo agendamento com backoff sem repetir o evento, `REFERENCE_NOT_FOUND` no limite com o saldo do momento, `REFERENCE_NOT_PROCESSED` quando a referência ainda espera no limite, dependente de uma transação rejeitada verificado e rejeitado na hora, cadeia recebida de trás para frente (`ROLLBACK`, `WIN`, `BET`) resolvida inteira, dois `REFUND`s esperando a mesma `BET` (só um aplicado), erro inesperado contando tentativa até `FAILED`/`PROCESSING_ERROR`, erro transitório sem contar tentativa e 4 reverificações concorrentes sobre 24 transações em 8 wallets (cada uma aplicada exatamente uma vez). O worker é testado com o loop real, e a aplicação Nest real aplica pela fila um `WIN` recebido antes da `BET`. Mutações conferidas: sem o lock da wallet, ou sem reler a transação depois do lock, o teste concorrente falha.
- Nenhum mock de banco nem de fila. **Planejado:** testes de concorrência com paralelismo real e múltiplos processos, crash e restart.

## 14. Pendências

Reconciliação; logs estruturados e métricas; autenticação (decisão a documentar); testes de concorrência e de falha; README de setup.
