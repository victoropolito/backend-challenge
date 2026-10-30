import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { DuplicateInboxMessageError } from '../../../src/domain/messaging/messaging-repositories';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wagering/wager-transaction';
import { DuplicateWagerTransactionError } from '../../../src/domain/wagering/wager-transaction-repository';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WalletAlreadyExistsError, WalletConcurrentModificationError } from '../../../src/domain/wallet/wallet-repository';
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-wallet.repository';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let em: EntityManager;

beforeAll(async () => {
  db = await createTestDatabase();
  em = db.orm.em.fork();
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const HASH = 'b'.repeat(64);
const at = new Date('2026-10-30T12:00:00.123Z');
const later = new Date('2026-10-30T12:00:05.456Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const repositories = (manager: EntityManager = em) => ({
  wallets: new MikroOrmWalletRepository(manager),
  ledger: new MikroOrmLedgerRepository(manager),
  transactions: new MikroOrmWagerTransactionRepository(manager),
  inbox: new MikroOrmInboxRepository(manager),
  outbox: new MikroOrmOutboxRepository(manager),
});

const openWallet = (initialBalance = brl('100.00'), playerId = randomUUID()) =>
  Wallet.open({
    id: randomUUID(),
    playerId,
    initialBalance,
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
    at,
  });

const newTransaction = (walletId: string, overrides: Partial<CreateWagerTransactionProps> = {}) => {
  const externalTransactionId = randomUUID();
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId,
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: at,
    ...overrides,
  });
};

/** Persiste a wallet como a aplicação fará: wallet + OPENING + lançamento de abertura numa única transação. */
const persistOpenedWallet = async (initialBalance = brl('100.00'), playerId = randomUUID()) => {
  const { wallet, openingEntry } = openWallet(initialBalance, playerId);
  await db.orm.em.fork().transactional(async (tx) => {
    const { wallets, transactions, ledger } = repositories(tx);
    await wallets.insert(wallet);
    if (openingEntry) {
      await transactions.insert(
        WagerTransaction.createOpening({
          id: openingEntry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: HASH,
          at,
        }),
      );
      await ledger.insert(openingEntry);
    }
  });
  return { wallet, openingEntry };
};

/** Debita `wallet` gravando BET processada, lançamento e saldo; precisa rodar dentro de uma transação. */
const debitAndPersist = async (manager: EntityManager, wallet: Wallet, amount: Money, expectedVersion = wallet.version) => {
  const { wallets, transactions, ledger } = repositories(manager);
  const bet = newTransaction(wallet.id, { money: amount });
  bet.markProcessed(undefined, later);
  const entry = wallet.debit({ entryId: randomUUID(), transactionId: bet.id, money: amount, at: later });
  await transactions.insert(bet);
  await ledger.insert(entry);
  await wallets.update(wallet, expectedVersion);
  return { bet, entry };
};

const backendsWaitingForLock = async () => {
  const [row] = await db.execute<{ waiting: number }>(
    `select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row!.waiting;
};

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Condition not reached in time');
    }
    await Bun.sleep(10);
  }
};

describe('MikroOrmWalletRepository', () => {
  it('round-trips a wallet exactly', async () => {
    const { wallet } = await persistOpenedWallet(brl('999999999999999999.99'));
    expect(await repositories().wallets.findById(wallet.id)).toEqual(wallet);
  });

  it('returns undefined for an unknown wallet', async () => {
    expect(await repositories().wallets.findById(randomUUID())).toBeUndefined();
  });

  it('translates a duplicate player/currency into WalletAlreadyExistsError', async () => {
    const { wallets } = repositories();
    const playerId = randomUUID();
    await wallets.insert(openWallet(Money.zero('BRL'), playerId).wallet);
    await wallets.insert(openWallet(Money.zero('USD'), playerId).wallet);
    await expect(wallets.insert(openWallet(Money.zero('BRL'), playerId).wallet)).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
  });

  it('updates balance and version together with the ledger entry', async () => {
    const { wallet } = await persistOpenedWallet(brl('100.00'));
    await db.orm.em.fork().transactional((tx) => debitAndPersist(tx, wallet, brl('30.00')));

    const stored = await repositories().wallets.findById(wallet.id);
    expect(stored?.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(stored?.version).toBe(2);
    expect(stored?.updatedAt).toEqual(later);
  });

  it('refuses a stale update and rolls back the whole movement', async () => {
    const { wallet } = await persistOpenedWallet(brl('100.00'));
    const stale = Wallet.rehydrate({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    await db.orm.em.fork().transactional((tx) => debitAndPersist(tx, wallet, brl('80.00')));

    let staleBetId: string | undefined;
    await expect(
      db.orm.em.fork().transactional(async (tx) => {
        const { bet } = await debitAndPersist(tx, stale, brl('80.00'), 1);
        staleBetId = bet.id;
      }),
    ).rejects.toBeInstanceOf(WalletConcurrentModificationError);

    const stored = await repositories().wallets.findById(wallet.id);
    expect(stored?.balance.toJSON().amount).toBe('20.00');
    expect(stored?.version).toBe(2);
    expect(staleBetId).toBeUndefined();
    const debits = await db.execute<{ count: number }>(
      `select count(*)::int as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits[0]!.count).toBe(1);
  });

  it('findByIdForUpdate requires an open transaction', async () => {
    const { wallet } = await persistOpenedWallet();
    await expect(repositories().wallets.findByIdForUpdate(wallet.id)).rejects.toThrow();
  });

  it('findByIdForUpdate makes a concurrent transaction wait for the lock holder to commit', async () => {
    const { wallet } = await persistOpenedWallet(brl('100.00'));
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let signalLocked!: () => void;
    const firstLocked = new Promise<void>((resolve) => (signalLocked = resolve));

    const first = db.orm.em.fork().transactional(async (tx) => {
      const locked = (await repositories(tx).wallets.findByIdForUpdate(wallet.id))!;
      events.push('first:locked');
      signalLocked();
      await firstMayCommit;
      await debitAndPersist(tx, locked, brl('80.00'));
      events.push('first:commit');
    });

    await firstLocked;
    const second = db.orm.em.fork().transactional(async (tx) => {
      const locked = (await repositories(tx).wallets.findByIdForUpdate(wallet.id))!;
      events.push(`second:locked@v${locked.version}:${locked.balance.toJSON().amount}`);
    });

    await waitUntil(async () => (await backendsWaitingForLock()) >= 1);
    expect(events).toEqual(['first:locked']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:locked', 'first:commit', 'second:locked@v2:20.00']);
  });
});

describe('MikroOrmLedgerRepository', () => {
  it('round-trips the opening entry and subsequent movements', async () => {
    const { wallet, openingEntry } = await persistOpenedWallet(brl('100.00'));
    const { bet, entry } = await db.orm.em.fork().transactional((tx) => debitAndPersist(tx, wallet, brl('25.00')));

    const { ledger } = repositories();
    expect(await ledger.findByTransactionId(openingEntry!.transactionId)).toEqual([openingEntry!]);
    const [stored] = await ledger.findByTransactionId(bet.id);
    expect(stored).toEqual(entry);
    expect(stored!.isBalanced()).toBe(true);
  });

  it('returns no entries for a transaction without movement', async () => {
    expect(await repositories().ledger.findByTransactionId(randomUUID())).toEqual([]);
  });
});

describe('MikroOrmWagerTransactionRepository', () => {
  it('round-trips a pending transaction and finds it by every key', async () => {
    const { transactions } = repositories();
    const { wallet } = await persistOpenedWallet(Money.zero('BRL'));
    const transaction = newTransaction(wallet.id);
    await transactions.insert(transaction);

    expect(await transactions.findById(transaction.id)).toEqual(transaction);
    expect(await transactions.findByExternalId('provider-a', transaction.externalTransactionId)).toEqual(transaction);
    expect(await transactions.findByIdempotencyKey('provider-a', transaction.idempotencyKey)).toEqual(transaction);
    expect(await transactions.findByExternalId('provider-b', transaction.externalTransactionId)).toBeUndefined();
  });

  it('persists every transition', async () => {
    const { transactions } = repositories();
    const { wallet } = await persistOpenedWallet(Money.zero('BRL'));
    const bet = newTransaction(wallet.id);
    bet.markProcessed(undefined, later);
    await transactions.insert(bet);

    const refund = newTransaction(wallet.id, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    await transactions.insert(refund);

    refund.markPendingReference(later);
    await transactions.update(refund);
    expect(await transactions.findById(refund.id)).toEqual(refund);

    refund.markProcessed(bet.id, later);
    await transactions.update(refund);
    const stored = await transactions.findById(refund.id);
    expect(stored).toEqual(refund);
    expect(stored?.referenceTransactionId).toBe(bet.id);
    expect(stored?.referenceCheckAttempts).toBe(1);
  });

  it('persists rejections with their failure code', async () => {
    const { transactions } = repositories();
    const transaction = newTransaction(randomUUID());
    transaction.reject(FailureCode.WalletNotFound);
    await transactions.insert(transaction);
    expect((await transactions.findById(transaction.id))?.failureCode).toBe(FailureCode.WalletNotFound);
  });

  it('translates a duplicate external id', async () => {
    const { transactions } = repositories();
    const first = newTransaction(randomUUID());
    await transactions.insert(first);
    const duplicate = newTransaction(randomUUID(), { externalTransactionId: first.externalTransactionId });

    const error = await transactions.insert(duplicate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateWagerTransactionError);
    expect((error as DuplicateWagerTransactionError).conflict).toBe('EXTERNAL_TRANSACTION_ID');
  });

  it('translates a duplicate idempotency key', async () => {
    const { transactions } = repositories();
    const first = newTransaction(randomUUID());
    await transactions.insert(first);
    const duplicate = newTransaction(randomUUID(), { idempotencyKey: first.idempotencyKey });

    const error = await transactions.insert(duplicate).catch((e: unknown) => e);
    expect((error as DuplicateWagerTransactionError).conflict).toBe('IDEMPOTENCY_KEY');
  });

  it('translates a second processed reversal of the same reference, whatever its kind', async () => {
    const { transactions } = repositories();
    const walletId = randomUUID();
    const bet = newTransaction(walletId);
    bet.markProcessed(undefined, at);
    await transactions.insert(bet);

    const reversal = (kind: Kind.Refund | Kind.Rollback) => {
      const t = newTransaction(walletId, { kind, referenceExternalTransactionId: bet.externalTransactionId });
      t.markProcessed(bet.id, at);
      return t;
    };
    await transactions.insert(reversal(Kind.Refund));

    for (const kind of [Kind.Refund, Kind.Rollback] as const) {
      const error = await transactions.insert(reversal(kind)).catch((e: unknown) => e);
      expect((error as DuplicateWagerTransactionError).conflict).toBe('REVERSAL');
    }

    const pending = newTransaction(walletId, { kind: Kind.Rollback, referenceExternalTransactionId: bet.externalTransactionId });
    await transactions.insert(pending);
    pending.markProcessed(bet.id, at);
    const updateError = await transactions.update(pending).catch((e: unknown) => e);
    expect((updateError as DuplicateWagerTransactionError).conflict).toBe('REVERSAL');
  });
});

describe('MikroOrmInboxRepository', () => {
  it('round-trips and marks processed', async () => {
    const { inbox } = repositories();
    const message = InboxMessage.receive({ messageId: randomUUID(), consumerName: 'wager', payloadHash: HASH, receivedAt: at });
    await inbox.insert(message);
    expect(await inbox.find('wager', message.messageId)).toEqual(message);

    message.markProcessed(later);
    await inbox.update(message);
    expect((await inbox.find('wager', message.messageId))?.processedAt).toEqual(later);
  });

  it('translates a duplicate message', async () => {
    const { inbox } = repositories();
    const props = { messageId: randomUUID(), consumerName: 'wager', payloadHash: HASH, receivedAt: at };
    await inbox.insert(InboxMessage.receive(props));
    await expect(inbox.insert(InboxMessage.receive(props))).rejects.toBeInstanceOf(DuplicateInboxMessageError);
  });
});

describe('MikroOrmOutboxRepository', () => {
  const enqueue = () => {
    const { wallet } = openWallet();
    const entry = wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('5.00'), at });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: randomUUID(), correlationId: 'corr-1', occurredAt: at });
    return OutboxMessage.enqueue(event);
  };

  it('round-trips the event envelope as jsonb', async () => {
    const { outbox } = repositories();
    const message = enqueue();
    await outbox.insert(message);

    const stored = await outbox.findById(message.id);
    expect(stored?.payload).toEqual(message.payload);
    expect(stored?.eventType).toBe('WalletBalanceChanged');
    expect(stored?.isDue(at)).toBe(true);
  });

  it('persists retries and publication', async () => {
    const { outbox } = repositories();
    const message = enqueue();
    await outbox.insert(message);

    message.scheduleRetry(at);
    await outbox.update(message);
    let stored = await outbox.findById(message.id);
    expect(stored?.attempts).toBe(1);
    expect(stored?.nextAttemptAt).toEqual(message.nextAttemptAt!);

    message.markPublished(later);
    await outbox.update(message);
    stored = await outbox.findById(message.id);
    expect(stored?.publishedAt).toEqual(later);
    expect(stored?.isPending()).toBe(false);
  });
});
