import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import { SubmitWagerTransactionUseCase } from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { WalletConcurrentModificationError } from '../../../src/domain/wallet/wallet-repository';
import { readBacklog } from '../../../src/infrastructure/database/backlog-query';
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
import type { LockConflictReason } from '../../../src/infrastructure/database/transient-error';
import { UuidV7Generator } from '../../../src/infrastructure/system/uuid-v7-generator';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let createWallet: CreateWalletUseCase;
let submit: SubmitWagerTransactionUseCase;

const clock = new (class extends Clock {
  now(): Date {
    return new Date(Date.now() - 30_000);
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
  const processor = new WagerTransactionProcessor({ wallets, ledger, wagerTransactions, outbox, ids });
  createWallet = new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids });
  submit = new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids });
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const openWallet = () =>
  createWallet.execute({
    playerId: randomUUID(),
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: randomUUID(),
  });

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

/** Trava a wallet numa transação separada até `release()`; quem chama fica fora do contexto dessa transação. */
const holdWalletLock = async (walletId: string) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (execute) => {
    await execute('select id from wallets where id = ? for update', [walletId]);
    locked();
    await released;
  });
  await isLocked;
  return async () => {
    release();
    await holder;
  };
};

describe('readBacklog', () => {
  it('counts unpublished events, the age of the oldest one and the transactions waiting for a reference', async () => {
    const wallet = await openWallet();
    await submit.execute({
      idempotencyKey: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Win,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: randomUUID(),
      correlationId: randomUUID(),
    });

    const backlog = await readBacklog(db.orm.em);

    expect(backlog.outboxPending).toBe(3);
    expect(backlog.outboxOldestPendingAgeSeconds).toBeGreaterThanOrEqual(29);
    expect(backlog.outboxOldestPendingAgeSeconds).toBeLessThan(60);
    expect(backlog.pendingReferenceTransactions).toBe(1);

    await db.execute('update outbox_messages set published_at = now(), next_attempt_at = null');
    expect(await readBacklog(db.orm.em)).toEqual({
      outboxPending: 0,
      outboxOldestPendingAgeSeconds: 0,
      pendingReferenceTransactions: 1,
    });
  });
});

describe('wallet lock instrumentation', () => {
  it('reports how long findByIdForUpdate waited for the wallet lock', async () => {
    const wallet = await openWallet();
    const waits: number[] = [];
    const runner = new MikroOrmTransactionRunner(db.orm.em);
    const wallets = new MikroOrmWalletRepository(db.orm.em, (seconds) => waits.push(seconds));

    const release = await holdWalletLock(wallet.id);
    const waiting = runner.run(() => wallets.findByIdForUpdate(wallet.id));
    await waitUntil(async () => (await backendsWaitingForLock()) > 0);
    await Bun.sleep(150);
    await release();
    await waiting;

    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThanOrEqual(0.14);
  });

  it('the runner reports transactions aborted by lock conflicts, and only those', async () => {
    const wallet = await openWallet();
    const conflicts: LockConflictReason[] = [];
    const em = db.orm.em;
    const runner = new MikroOrmTransactionRunner(em, (reason) => conflicts.push(reason));
    const wallets = new MikroOrmWalletRepository(em);

    const release = await holdWalletLock(wallet.id);
    await expect(
      runner.run(async () => {
        await em.execute(`set local lock_timeout = '50ms'`);
        return wallets.findByIdForUpdate(wallet.id);
      }),
    ).rejects.toThrow();
    await release();
    await expect(
      runner.run(async () => {
        throw new WalletConcurrentModificationError(wallet.id, 1);
      }),
    ).rejects.toBeInstanceOf(WalletConcurrentModificationError);
    await expect(
      runner.run(async () => {
        throw new Error('not a conflict');
      }),
    ).rejects.toThrow('not a conflict');

    expect(conflicts).toEqual(['lock_timeout', 'wallet_version']);
  });
});
