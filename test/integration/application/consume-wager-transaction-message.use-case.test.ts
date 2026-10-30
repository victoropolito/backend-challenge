import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import {
  ConsumeWagerTransactionMessageUseCase,
  InboxPayloadConflictError,
  type WagerTransactionMessage,
} from '../../../src/application/wagering/consume-wager-transaction-message.use-case';
import {
  IdempotencyConflictError,
  SubmitWagerTransactionUseCase,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import { OutboxRepository } from '../../../src/domain/messaging/messaging-repositories';
import type { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-wallet.repository';
import { UuidV7Generator } from '../../../src/infrastructure/system/uuid-v7-generator';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const CONSUMER = 'wager-transactions-consumer';

let db: TestDatabase;
let consume: ConsumeWagerTransactionMessageUseCase;
let consumeWithFailingOutbox: ConsumeWagerTransactionMessageUseCase;
let createWallet: CreateWalletUseCase;

const clock = new (class extends Clock {
  now(): Date {
    return new Date('2026-10-30T12:00:00.000Z');
  }
})();

beforeAll(async () => {
  db = await createTestDatabase();
  const em = db.orm.em;
  const ids = new UuidV7Generator();
  const transactions = new MikroOrmTransactionRunner(em);
  const wallets = new MikroOrmWalletRepository(em);
  const ledger = new MikroOrmLedgerRepository(em);
  const wagerTransactions = new MikroOrmWagerTransactionRepository(em);
  const outbox = new MikroOrmOutboxRepository(em);
  const inbox = new MikroOrmInboxRepository(em);

  const consumerWith = (outboxRepository: OutboxRepository) => {
    const processor = new WagerTransactionProcessor({ wallets, ledger, wagerTransactions, outbox: outboxRepository, ids });
    const submit = new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids });
    return new ConsumeWagerTransactionMessageUseCase({ consumerName: CONSUMER, inbox, submit });
  };

  const failingOutbox = new (class extends OutboxRepository {
    findById = outbox.findById.bind(outbox);
    claimDue = outbox.claimDue.bind(outbox);
    update = outbox.update.bind(outbox);
    async insert(message: OutboxMessage): Promise<void> {
      if (message.eventType === 'WalletBalanceChanged') {
        throw new Error('outbox write failed');
      }
      await outbox.insert(message);
    }
  })();

  consume = consumerWith(outbox);
  consumeWithFailingOutbox = consumerWith(failingOutbox);
  createWallet = new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids });
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const openWallet = (amount = '100.00') =>
  createWallet.execute({ playerId: randomUUID(), initialBalance: brl(amount), correlationId: randomUUID() });

const messageFor = (
  wallet: Wallet,
  overrides: Partial<WagerTransactionMessage['command']> = {},
  messageId = randomUUID(),
  payloadHash = 'a'.repeat(64),
): WagerTransactionMessage => {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return {
    messageId,
    payloadHash,
    receivedAt: clock.now(),
    command: {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: Kind.Bet,
      money: brl('25.00'),
      referenceExternalTransactionId: undefined,
      correlationId: messageId,
      causationId: messageId,
      ...overrides,
    },
  };
};

const inboxRows = (messageId: string) =>
  db.execute<{ payload_hash: string; processed_at: string | null }>(
    `select payload_hash, to_char(processed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as processed_at from inbox_messages where consumer_name = ? and message_id = ?`,
    [CONSUMER, messageId],
  );

const countWhere = async (sql: string, params: unknown[]) =>
  (await db.execute<{ count: number }>(`select count(*)::int as count from ${sql}`, params))[0]!.count;

const balanceOf = async (walletId: string) =>
  (await db.execute<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;

describe('ConsumeWagerTransactionMessageUseCase', () => {
  it('applies the transaction and records the message in the inbox', async () => {
    const wallet = await openWallet();
    const message = messageFor(wallet);

    const result = await consume.execute(message);

    expect(result.duplicate).toBe(false);
    if (result.duplicate) throw new Error('unreachable');
    expect(result.submission.transaction.status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await inboxRows(message.messageId)).toEqual([
      { payload_hash: message.payloadHash, processed_at: clock.now().toISOString() },
    ]);
    const [event] = await db.execute<{ payload: Record<string, unknown> }>(
      `select payload from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'`,
      [result.submission.transaction.id],
    );
    expect(event!.payload).toMatchObject({ correlationId: message.messageId, causationId: message.messageId });
  });

  it('acknowledges a redelivery as a duplicate without touching the wallet again', async () => {
    const wallet = await openWallet();
    const message = messageFor(wallet);
    await consume.execute(message);
    const outboxBefore = await countWhere('outbox_messages', []);

    expect(await consume.execute(message)).toEqual({ duplicate: true });

    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await countWhere('outbox_messages', [])).toBe(outboxBefore);
  });

  it('refuses the same messageId with another content', async () => {
    const wallet = await openWallet();
    const message = messageFor(wallet);
    await consume.execute(message);

    await expect(consume.execute({ ...message, payloadHash: 'b'.repeat(64) })).rejects.toBeInstanceOf(
      InboxPayloadConflictError,
    );
  });

  it('treats a new message for an already applied transaction as a replay and records it', async () => {
    const wallet = await openWallet();
    const first = messageFor(wallet);
    await consume.execute(first);
    const resent = { ...first, messageId: randomUUID() };

    const result = await consume.execute(resent);

    expect(result).toMatchObject({ duplicate: false, submission: { idempotentReplay: true } });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await inboxRows(resent.messageId)).toHaveLength(1);
  });

  it('records business rejections and pending references, which are final answers for the message', async () => {
    const wallet = await openWallet('10.00');
    const rejected = messageFor(wallet);
    const pending = messageFor(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: randomUUID(),
    });

    const rejection = await consume.execute(rejected);
    const pendingReference = await consume.execute(pending);

    expect(rejection).toMatchObject({
      duplicate: false,
      submission: { transaction: { status: Status.Rejected, failureCode: FailureCode.InsufficientBalance } },
    });
    expect(pendingReference).toMatchObject({
      duplicate: false,
      submission: { transaction: { status: Status.PendingReference } },
    });
    expect(await inboxRows(rejected.messageId)).toHaveLength(1);
    expect(await inboxRows(pending.messageId)).toHaveLength(1);
  });

  it('does not record the message when the submission is refused', async () => {
    const wallet = await openWallet();
    const first = messageFor(wallet);
    await consume.execute(first);
    const conflicting = messageFor(wallet, { ...first.command, money: brl('30.00') });

    await expect(consume.execute(conflicting)).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await inboxRows(conflicting.messageId)).toEqual([]);
  });

  it('rolls back the inbox together with the transaction, ledger and events', async () => {
    const wallet = await openWallet();
    const message = messageFor(wallet);

    await expect(consumeWithFailingOutbox.execute(message)).rejects.toThrow('outbox write failed');

    expect(await inboxRows(message.messageId)).toEqual([]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(
      await countWhere('wager_transactions where provider_id = ? and external_transaction_id = ?', [
        'provider-a',
        message.command.externalTransactionId,
      ]),
    ).toBe(0);

    const retried = await consume.execute(message);
    expect(retried).toMatchObject({ duplicate: false, submission: { transaction: { status: Status.Processed } } });
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  it('the same message delivered 20 times in parallel debits once and is recorded once', async () => {
    const wallet = await openWallet();
    const message = messageFor(wallet);

    const results = await Promise.all(Array.from({ length: 20 }, () => consume.execute(message)));

    expect(results.filter((result) => !result.duplicate && !result.submission.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await inboxRows(message.messageId)).toHaveLength(1);
    expect(await countWhere('wallet_ledger_entries where wallet_id = ?', [wallet.id])).toBe(2);
  });

  it('50 different messages for the same transaction in parallel debit once and are all recorded', async () => {
    const wallet = await openWallet();
    const template = messageFor(wallet);
    const messages = Array.from({ length: 50 }, () => ({ ...template, messageId: randomUUID() }));

    const results = await Promise.all(messages.map((message) => consume.execute(message)));

    expect(results.every((result) => !result.duplicate)).toBe(true);
    expect(results.filter((result) => !result.duplicate && !result.submission.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(
      await countWhere('inbox_messages where consumer_name = ? and message_id in (?)', [
        CONSUMER,
        messages.map((message) => message.messageId),
      ]),
    ).toBe(50);
  });
});
