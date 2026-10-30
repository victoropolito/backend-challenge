# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas da solução. Ele é atualizado a cada etapa; seções marcadas como **planejado** descrevem o desenho adotado para partes ainda não implementadas.

## 1. Visão geral

```
src/
├── domain/                 regras de negócio puras (sem NestJS, sem ORM)
│   ├── shared/             Money, DomainError, backoff, deepFreeze
│   ├── wallet/             Wallet (aggregate root), WalletLedgerEntry, portas de repositório
│   ├── wagering/           WagerTransaction, FailureCode, porta de repositório
│   ├── events/             IntegrationEvent e os 4 eventos de integração
│   └── messaging/          InboxMessage, OutboxMessage, portas de repositório
├── infrastructure/
│   ├── database/           MikroORM: config, migrations, records (EntitySchema), repositórios
│   └── messaging/          cliente SQS
├── health/                 /health/live e /health/ready
└── config/                 variáveis de ambiente validadas com Zod
```

Regra de dependência: `domain` não importa nada de `infrastructure`, NestJS ou MikroORM. A infraestrutura implementa as **portas** declaradas no domínio (`WalletRepository`, `LedgerRepository`, `WagerTransactionRepository`, `InboxRepository`, `OutboxRepository`). As portas são `abstract class`, e não `interface`, porque assim servem ao mesmo tempo de contrato e de token de injeção do NestJS, sem acoplar o domínio ao framework.

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
- `WagerTransactionProcessed` inclui o saldo observado logo após a aplicação, inclusive para `LOSS`, para que um replay devolva o resultado original (regra 7.7).
- `OutboxMessage.enqueue(event)` usa o próprio `eventId` como id da mensagem: republicações carregam o mesmo id e o consumidor deduplica por ele. Retry com backoff exponencial (1 s até o teto de 5 min) e **sem limite de tentativas**: um evento confirmado não pode ser descartado, e uma falha persistente deve aparecer na métrica de atraso da outbox.
- `InboxMessage` é identificada por `(consumerName, messageId)` e só pode ser marcada como processada uma vez.

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
- **Planejado:** o caso de uso de submissão adquire o lock antes de verificar o saldo e aplicar a operação; testes com 50 envios paralelos, *hot wallet* e ≥ 3 instâncias.

## 6. Idempotência (planejado, com base já implementada)

- **Implementado:** unicidade persistente por `(provider_id, external_transaction_id)` e `(provider_id, idempotency_key)`; `payload_hash` SHA-256 hex obrigatório no schema; `WagerTransaction.matchesPayload(hash)`; conflitos de inserção concorrente traduzidos para `DuplicateWagerTransactionError`.
- **Planejado:** o hash é o SHA-256 de um JSON canônico (chaves ordenadas) do subconjunto de campos de negócio. A mesma chave com o mesmo hash é um replay e devolve o resultado original; com outro hash é um conflito, não um replay. Nenhuma idempotência depende de memória.

## 7. Interpretações adotadas

| Tema | Interpretação | Motivo |
|---|---|---|
| Reversão única (regra 7.4) | Uma transação é revertida **no máximo uma vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`), e não "uma vez por tipo" | Com "uma vez por tipo", uma `BET` poderia receber `REFUND` **e** `ROLLBACK`, devolvendo o valor duas vezes, o que violaria o invariante "não duplicar créditos" |
| Arredondamento | Valores com mais de 2 casas são rejeitados, não arredondados | Arredondar mudaria em silêncio o valor de uma operação financeira |
| `LOSS` | Aceita valor zero; não gera lançamento nem `WalletBalanceChanged`, mas gera `WagerTransactionProcessed` | `LOSS` apenas registra o resultado da rodada |
| `WIN`/`LOSS` com referência | Opcional; quando presente, deve apontar para uma `BET` da mesma rodada; o valor de `WIN` pode diferir do da `BET` | Um prêmio não tem o valor da aposta |
| Moeda | Escala 2 para qualquer moeda; o desafio usa `BRL`, mas o modelo é multi-moeda | Simplificação permitida pelo enunciado |

## 8. Limitações conhecidas

- Depois de `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a `BET` não pode ser revertida de novo (o índice de reversão única continua vendo o `REFUND` processado). É um caso raro e o comportamento é conservador.
- `WalletBalanceChanged.from` identifica o lançamento mais recente comparando o saldo final com o saldo atual; um lançamento antigo com o mesmo saldo final passaria. O risco é baixo, porque o evento é criado logo após o movimento.
- A imutabilidade do ledger é garantida por trigger, que vale para qualquer role. Restringir permissões por role no banco (aplicação sem `UPDATE`/`DELETE`) ficou de fora, porque o ambiente local usa um único usuário.
- Ledger de partidas simples (sem conta de contrapartida da casa).

## 9. Testes

- **Unitários** (`test/unit`): `Money` (escala, entradas inválidas, conflito de moeda, ausência de arredondamento), invariantes da `Wallet`, máquina de estados e regras de referência da `WagerTransaction`, eventos, inbox, outbox e backoff.
- **Integração** (`test/integration`): PostgreSQL real; cada arquivo cria um banco descartável `wagering_test_<aleatório>`, aplica as migrations e o remove ao final. Cada constraint é testada pelo SQLSTATE **e** pelo nome, garantindo que a recusa veio da regra certa. Repositórios testados com ida e volta exata, tradução de conflitos e lock concorrente.
- Nenhum mock de banco. **Planejado:** LocalStack nos testes de mensageria, testes de concorrência com paralelismo real e múltiplos processos, crash e restart.

## 10. Pendências

Caso de uso de submissão e endpoints HTTP; consumer SQS (inbox, retry, DLQ, shutdown gracioso); publisher da outbox concorrente (`FOR UPDATE SKIP LOCKED`); worker de `PENDING_REFERENCE`; reconciliação; logs estruturados e métricas; autenticação (decisão a documentar); testes de concorrência e de falha; README de setup.
