import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import { payloadHash } from '../../../src/application/shared/payload-hash';
import { CreateWalletUseCase, type CreateWalletDependencies } from '../../../src/application/wallet/create-wallet.use-case';
import { OutboxRepository } from '../../../src/domain/messaging/messaging-repositories';
import type { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/shared/money';
import { InvalidWalletOperationError } from '../../../src/domain/wallet/wallet';
import { WalletAlreadyExistsError } from '../../../src/domain/wallet/wallet-repository';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import {
  MikroOrmOutboxRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-wallet.repository';
import { UuidV7Generator } from '../../../src/infrastructure/system/uuid-v7-generator';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const now = new Date('2026-10-30T12:00:00.123Z');
const fixedClock = new (class extends Clock {
  now(): Date {
    return new Date(now);
  }
})();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/** Monta o caso de uso como a aplicação: repositórios sobre o EntityManager global, roteado para a transação aberta. */
const dependencies = (overrides: Partial<CreateWalletDependencies> = {}): CreateWalletDependencies => {
  const em = db.orm.em;
  return {
    transactions: new MikroOrmTransactionRunner(em),
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    wagerTransactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    clock: fixedClock,
    ids: new UuidV7Generator(),
    ...overrides,
  };
};
const useCase = (overrides?: Partial<CreateWalletDependencies>) => new CreateWalletUseCase(dependencies(overrides));

const countRows = async (sql: string, params: unknown[]) => {
  const [row] = await db.execute<{ count: number }>(`select count(*)::int as count from (${sql}) rows`, params);
  return row!.count;
};

const persistedFor = async (playerId: string) => ({
  wallets: await countRows('select 1 from wallets where player_id = ?', [playerId]),
  transactions: await countRows('select 1 from wager_transactions where player_id = ?', [playerId]),
  ledgerEntries: await countRows(
    'select 1 from wallet_ledger_entries l join wallets w on w.id = l.wallet_id where w.player_id = ?',
    [playerId],
  ),
  outboxMessages: await countRows(
    `select 1 from outbox_messages o
      where o.aggregate_id in (select id from wallets where player_id = ?
                               union all select id from wager_transactions where player_id = ?)`,
    [playerId, playerId],
  ),
});

describe('CreateWalletUseCase', () => {
  it('creates the wallet, OPENING transaction, opening entry and events atomically', async () => {
    const playerId = randomUUID();
    const correlationId = randomUUID();

    const wallet = await useCase().execute({ playerId, initialBalance: brl('1000.00'), correlationId });

    expect(wallet.playerId).toBe(playerId);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(now);

    const stored = await new MikroOrmWalletRepository(db.orm.em.fork()).findById(wallet.id);
    expect(stored).toEqual(wallet);

    const [opening] = await db.execute<Record<string, unknown>>(
      `select id, provider_id, external_transaction_id, idempotency_key, kind, status, amount, currency, payload_hash, processed_at
         from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );
    expect(opening).toMatchObject({
      provider_id: 'internal',
      external_transaction_id: `wallet-opening:${wallet.id}`,
      idempotency_key: `internal:wallet-opening:${wallet.id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      currency: 'BRL',
      payload_hash: payloadHash({
        kind: 'OPENING',
        walletId: wallet.id,
        playerId,
        money: { amount: '1000.00', currency: 'BRL' },
      }),
    });
    expect(new Date(opening!.processed_at as string)).toEqual(now);

    const entries = await db.execute<Record<string, unknown>>(
      'select transaction_id, direction, amount, balance_before, balance_after from wallet_ledger_entries where wallet_id = ?',
      [wallet.id],
    );
    expect(entries).toEqual([
      { transaction_id: opening!.id, direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' },
    ]);

    const messages = await db.execute<{ id: string; aggregate_id: string; event_type: string; payload: Record<string, any> }>(
      `select id, aggregate_id, event_type, payload from outbox_messages
        where aggregate_id in (?, ?) order by sequence`,
      [wallet.id, opening!.id],
    );
    expect(messages.map((m): [string, string] => [m.event_type, m.aggregate_id])).toEqual([
      ['WagerTransactionProcessed', opening!.id as string],
      ['WalletBalanceChanged', wallet.id],
    ]);
    for (const message of messages) {
      expect(message.payload.eventId).toBe(message.id);
      expect(message.payload.correlationId).toBe(correlationId);
      expect(message.payload.occurredAt).toBe(now.toISOString());
    }
    expect(messages[0]!.payload.data).toMatchObject({
      transactionId: opening!.id,
      providerId: 'internal',
      kind: 'OPENING',
      balance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(messages[1]!.payload.data).toEqual({
      walletId: wallet.id,
      transactionId: opening!.id,
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('creates a zero-balance wallet with no transaction, ledger entry or event', async () => {
    const playerId = randomUUID();

    const wallet = await useCase().execute({ playerId, initialBalance: brl('0'), correlationId: randomUUID() });

    expect(wallet.balance.equals(brl('0.00'))).toBe(true);
    expect(await persistedFor(playerId)).toEqual({ wallets: 1, transactions: 0, ledgerEntries: 0, outboxMessages: 0 });
  });

  it('rejects a second wallet for the same player and currency, leaving nothing behind', async () => {
    const playerId = randomUUID();
    await useCase().execute({ playerId, initialBalance: brl('10.00'), correlationId: randomUUID() });

    const duplicate = useCase().execute({ playerId, initialBalance: brl('20.00'), correlationId: randomUUID() });

    await expect(duplicate).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(await persistedFor(playerId)).toEqual({ wallets: 1, transactions: 1, ledgerEntries: 1, outboxMessages: 2 });
  });

  it('allows wallets of the same player in different currencies', async () => {
    const playerId = randomUUID();

    const brlWallet = await useCase().execute({ playerId, initialBalance: brl('10.00'), correlationId: randomUUID() });
    const usdWallet = await useCase().execute({
      playerId,
      initialBalance: Money.from({ amount: '5.00', currency: 'USD' }),
      correlationId: randomUUID(),
    });

    expect(usdWallet.id).not.toBe(brlWallet.id);
    expect(await persistedFor(playerId)).toEqual({ wallets: 2, transactions: 2, ledgerEntries: 2, outboxMessages: 4 });
  });

  it('creates exactly one wallet when the same player is created concurrently', async () => {
    const playerId = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        useCase().execute({ playerId, initialBalance: brl('50.00'), correlationId: randomUUID() }),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
    expect(await persistedFor(playerId)).toEqual({ wallets: 1, transactions: 1, ledgerEntries: 1, outboxMessages: 2 });
  });

  it('rolls everything back when a later write in the transaction fails', async () => {
    const playerId = randomUUID();
    const realOutbox = new MikroOrmOutboxRepository(db.orm.em);
    let inserted = 0;
    const failingOutbox = new (class extends OutboxRepository {
      findById(id: string) {
        return realOutbox.findById(id);
      }
      claimDue(now: Date, limit: number) {
        return realOutbox.claimDue(now, limit);
      }
      async insert(message: OutboxMessage) {
        await realOutbox.insert(message);
        inserted += 1;
        if (inserted === 2) {
          throw new Error('outbox unavailable');
        }
      }
      update(message: OutboxMessage) {
        return realOutbox.update(message);
      }
    })();

    const attempt = useCase({ outbox: failingOutbox }).execute({
      playerId,
      initialBalance: brl('10.00'),
      correlationId: randomUUID(),
    });

    await expect(attempt).rejects.toThrow('outbox unavailable');
    expect(inserted).toBe(2);
    expect(await persistedFor(playerId)).toEqual({ wallets: 0, transactions: 0, ledgerEntries: 0, outboxMessages: 0 });
  });

  it('rejects a negative initial balance without writing anything', async () => {
    const playerId = randomUUID();

    const attempt = useCase().execute({
      playerId,
      initialBalance: Money.rehydrate({ amount: '-1.00', currency: 'BRL' }),
      correlationId: randomUUID(),
    });

    await expect(attempt).rejects.toBeInstanceOf(InvalidWalletOperationError);
    expect(await persistedFor(playerId)).toEqual({ wallets: 0, transactions: 0, ledgerEntries: 0, outboxMessages: 0 });
  });
});
