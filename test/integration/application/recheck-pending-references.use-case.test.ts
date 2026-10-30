import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import {
  RecheckPendingReferencesUseCase,
  type RecheckPendingReferencesDependencies,
  type RecheckPendingReferencesResult,
} from '../../../src/application/wagering/recheck-pending-references.use-case';
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { WageringMonitor, type WagerTransactionOrigin } from '../../../src/application/wagering/wagering-monitor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
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
import { PendingReferenceWorker } from '../../../src/workers/pending-reference.worker';
import { silentLogger } from '../../support/loggers';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { itKeepsEveryBalanceEqualToItsLedger } from '../support/ledger-invariant';

const MAX_ATTEMPTS = 3;

let db: TestDatabase;
let deps: Omit<RecheckPendingReferencesDependencies, 'clock' | 'maxAttempts'>;
let processor: WagerTransactionProcessor;
let submitUseCase: SubmitWagerTransactionUseCase;
let createWalletUseCase: CreateWalletUseCase;
let recheckUseCase: RecheckPendingReferencesUseCase;

const clock = new (class extends Clock {
  current = new Date('2026-10-30T12:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
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
  processor = new WagerTransactionProcessor({ wallets, ledger, wagerTransactions, outbox, ids });
  deps = { transactions, wallets, wagerTransactions, processor, ids };
  submitUseCase = new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids });
  createWalletUseCase = new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids });
  recheckUseCase = recheckWith({});
}, 30_000);

afterEach(async () => {
  await db.execute(`update wager_transactions set next_reference_check_at = '2100-01-01' where status = 'PENDING_REFERENCE'`);
});

afterAll(async () => {
  await db?.drop();
});

const recheckWith = (overrides: Partial<RecheckPendingReferencesDependencies>) =>
  new RecheckPendingReferencesUseCase({ ...deps, clock, maxAttempts: MAX_ATTEMPTS, ...overrides });

/** Reverifica lotes até não haver mais transações vencidas. */
const drain = async (useCase = recheckUseCase) => {
  const total: RecheckPendingReferencesResult = { due: 0, completed: 0, rescheduled: 0, skipped: 0, errors: new Map() };
  for (;;) {
    const result = await useCase.execute(5);
    total.due += result.due;
    total.completed += result.completed;
    total.rescheduled += result.rescheduled;
    total.skipped += result.skipped;
    for (const [id, error] of result.errors) {
      total.errors.set(id, error);
    }
    if (result.due === 0 || result.errors.size > 0) {
      return total;
    }
  }
};

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const openWallet = (amount = '100.00') =>
  createWalletUseCase.execute({ playerId: randomUUID(), initialBalance: brl(amount), correlationId: randomUUID() });

const submit = async (wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}) => {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  const command: SubmitWagerTransactionCommand = {
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
    correlationId: 'corr-submit',
    ...overrides,
  };
  return (await submitUseCase.execute(command)).transaction;
};

/** Transação que referencia `reference` (um externalTransactionId ainda não recebido ou já recebido). */
const referencing = (wallet: Wallet, kind: Kind, reference: string, amount = '25.00') =>
  submit(wallet, { kind, money: brl(amount), referenceExternalTransactionId: reference });

const stored = async (transaction: WagerTransaction) =>
  (await new MikroOrmWagerTransactionRepository(db.orm.em.fork()).findById(transaction.id))!;

const balanceOf = async (wallet: Wallet) =>
  (await new MikroOrmWalletRepository(db.orm.em.fork()).findById(wallet.id))!.balance;

const eventsOf = (aggregateId: string) =>
  db.execute<{ event_type: string; payload: Record<string, any> }>(
    'select event_type, payload from outbox_messages where aggregate_id = ? order by sequence',
    [aggregateId],
  );

const ledgerCount = async (wallet: Wallet) =>
  (await db.execute<{ count: number }>('select count(*)::int as count from wallet_ledger_entries where wallet_id = ?', [wallet.id]))[0]!
    .count;

/** Avança o relógio para depois da próxima verificação de qualquer transação. */
const later = () => clock.advance(10 * 60_000);

describe('RecheckPendingReferencesUseCase', () => {
  it('applies a WIN as soon as its BET arrives: the BET brings the WIN check forward', async () => {
    const wallet = await openWallet('100.00');
    const betId = randomUUID();
    const win = await referencing(wallet, Kind.Win, betId, '40.00');
    expect(win.status).toBe(Status.PendingReference);

    await submit(wallet, { externalTransactionId: betId });
    expect((await stored(win)).nextReferenceCheckAt).toEqual(clock.now());

    const result = await drain();

    expect(result.completed).toBe(1);
    const applied = await stored(win);
    expect(applied.status).toBe(Status.Processed);
    expect(applied.observedBalance).toEqual(brl('115.00'));
    expect(await balanceOf(wallet)).toEqual(brl('115.00'));
    const events = await eventsOf(win.id);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
    expect(events[1]!.payload.causationId).toBe(win.id);
  });

  it('does not check a transaction before it is due', async () => {
    const wallet = await openWallet();
    const win = await referencing(wallet, Kind.Win, randomUUID());

    const result = await drain();

    expect(result.due).toBe(0);
    expect((await stored(win)).referenceCheckAttempts).toBe(1);
  });

  it('reschedules with backoff while the reference is missing, without repeating the pending event', async () => {
    const wallet = await openWallet();
    const win = await referencing(wallet, Kind.Win, randomUUID());

    later();
    const result = await drain();

    expect(result.rescheduled).toBe(1);
    const pending = await stored(win);
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.referenceCheckAttempts).toBe(2);
    expect(pending.nextReferenceCheckAt).toEqual(new Date(clock.now().getTime() + 2_000));
    expect((await eventsOf(win.id)).map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference']);
  });

  it('rejects with REFERENCE_NOT_FOUND once the attempts run out, keeping the balance', async () => {
    const wallet = await openWallet('100.00');
    const win = await referencing(wallet, Kind.Win, randomUUID());

    for (let check = 2; check <= MAX_ATTEMPTS; check++) {
      later();
      await drain();
      expect((await stored(win)).status).toBe(Status.PendingReference);
    }
    later();
    await drain();

    const rejected = await stored(win);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rejected.referenceCheckAttempts).toBe(MAX_ATTEMPTS);
    expect(rejected.observedBalance).toEqual(brl('100.00'));
    expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    const events = await eventsOf(win.id);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(events[1]!.payload.data.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('rejects with REFERENCE_NOT_PROCESSED when the reference exists but is still waiting at the limit', async () => {
    const wallet = await openWallet();
    const win = await referencing(wallet, Kind.Win, randomUUID());
    const rollback = await referencing(wallet, Kind.Rollback, win.externalTransactionId);
    expect(rollback.status).toBe(Status.PendingReference);
    await db.execute(`update wager_transactions set next_reference_check_at = '2100-01-01' where id = ?`, [win.id]);

    later();
    await drain(recheckWith({ maxAttempts: 1 }));

    const rejected = await stored(rollback);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(rejected.referenceTransactionId).toBe(win.id);
    expect((await stored(win)).status).toBe(Status.PendingReference);
  });

  it('a dependent waiting on a rejected transaction is checked right away and rejected', async () => {
    const wallet = await openWallet();
    const win = await referencing(wallet, Kind.Win, randomUUID());
    const rollback = await referencing(wallet, Kind.Rollback, win.externalTransactionId);
    await db.execute(`update wager_transactions set next_reference_check_at = '2100-01-01' where id = ?`, [rollback.id]);

    later();
    await drain(recheckWith({ maxAttempts: 1 }));

    expect((await stored(win)).failureCode).toBe(FailureCode.ReferenceNotFound);
    const rejected = await stored(rollback);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(rejected.referenceCheckAttempts).toBe(1);
  });

  it('resolves a chain received backwards (ROLLBACK, WIN, BET) as soon as the BET arrives', async () => {
    const wallet = await openWallet('100.00');
    const betId = randomUUID();
    const winId = randomUUID();
    const rollback = await referencing(wallet, Kind.Rollback, winId, '40.00');
    const win = await submit(wallet, {
      externalTransactionId: winId,
      kind: Kind.Win,
      money: brl('40.00'),
      referenceExternalTransactionId: betId,
    });
    await submit(wallet, { externalTransactionId: betId, money: brl('25.00') });

    await drain();

    expect((await stored(win)).status).toBe(Status.Processed);
    expect((await stored(rollback)).status).toBe(Status.Processed);
    expect((await stored(rollback)).observedBalance).toEqual(brl('75.00'));
    expect(await balanceOf(wallet)).toEqual(brl('75.00'));
    expect(await ledgerCount(wallet)).toBe(4);
  });

  it('two REFUNDs waiting for the same BET: only one is applied', async () => {
    const wallet = await openWallet('100.00');
    const betId = randomUUID();
    const first = await referencing(wallet, Kind.Refund, betId);
    const second = await referencing(wallet, Kind.Refund, betId);
    await submit(wallet, { externalTransactionId: betId });

    await drain();

    const outcomes = [await stored(first), await stored(second)].map((tx) => [tx.status, tx.failureCode]);
    expect(outcomes).toContainEqual([Status.Processed, undefined]);
    expect(outcomes).toContainEqual([Status.Rejected, FailureCode.ReferenceAlreadyReversed]);
    expect(await balanceOf(wallet)).toEqual(brl('100.00'));
  });

  it('an unexpected error counts as an attempt and, at the limit, ends FAILED with PROCESSING_ERROR', async () => {
    const wallet = await openWallet('100.00');
    const win = await referencing(wallet, Kind.Win, randomUUID());
    const broken = recheckWith({
      processor: {
        process: () => Promise.reject(new Error('bug while processing')),
        fail: (transaction, origin) => processor.fail(transaction, origin),
      },
    });

    later();
    const first = await drain(broken);
    expect(first.errors.get(win.id)).toEqual(new Error('bug while processing'));
    expect((await stored(win)).referenceCheckAttempts).toBe(2);

    later();
    await drain(broken);
    later();
    await drain(broken);

    const failed = await stored(win);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.ProcessingError);
    expect(failed.observedBalance).toBeUndefined();
    expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    expect((await eventsOf(win.id)).map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionFailed',
    ]);
  });

  it('a transient error does not count as an attempt: the transaction stays due', async () => {
    const wallet = await openWallet();
    const win = await referencing(wallet, Kind.Win, randomUUID());
    const flaky = recheckWith({
      processor: { process: () => Promise.reject(new Error('deadlock detected')), fail: () => Promise.resolve() },
      isTransientError: () => true,
    });

    later();
    const result = await drain(flaky);

    expect(result.errors.has(win.id)).toBe(true);
    const pending = await stored(win);
    expect(pending.referenceCheckAttempts).toBe(1);
    expect(pending.nextReferenceCheckAt!.getTime()).toBeLessThanOrEqual(clock.now().getTime());
  });

  it('concurrent rechecks apply each transaction exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet('100.00')));
    const wins: WagerTransaction[] = [];
    for (const wallet of wallets) {
      const betId = randomUUID();
      for (let i = 0; i < 3; i++) {
        wins.push(await referencing(wallet, Kind.Win, betId, '10.00'));
      }
      await submit(wallet, { externalTransactionId: betId, money: brl('25.00') });
    }

    const results = await Promise.all(Array.from({ length: 4 }, () => drain(recheckWith({}))));

    expect(results.flatMap((result) => [...result.errors.values()])).toEqual([]);
    expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(wins.length);
    for (const win of wins) {
      expect((await stored(win)).status).toBe(Status.Processed);
      expect((await eventsOf(win.id)).filter((event) => event.event_type === 'WagerTransactionProcessed')).toHaveLength(1);
    }
    for (const wallet of wallets) {
      expect(await balanceOf(wallet)).toEqual(brl('105.00'));
      expect(await ledgerCount(wallet)).toBe(5);
    }
  });
});

describe('RecheckPendingReferencesUseCase monitor', () => {
  it('reports each new state after the commit, and nothing for a skipped transaction', async () => {
    const calls: [string, Status, WagerTransactionOrigin][] = [];
    const monitored = recheckWith({
      monitor: new (class extends WageringMonitor {
        recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void {
          calls.push([transaction.id, transaction.status, origin]);
        }
        replayed(): void {}
        conflicted(): void {}
      })(),
    });
    const wallet = await openWallet('100.00');
    const betId = randomUUID();
    const waiting = await referencing(wallet, Kind.Win, randomUUID());
    const resolved = await referencing(wallet, Kind.Win, betId);
    await submit(wallet, { externalTransactionId: betId });

    later();
    await drain(monitored);
    await drain(monitored);

    expect(calls).toContainEqual([waiting.id, Status.PendingReference, 'RECHECK']);
    expect(calls).toContainEqual([resolved.id, Status.Processed, 'RECHECK']);
    expect(calls).toHaveLength(2);
  });
});

describe('PendingReferenceWorker', () => {
  it('applies a waiting transaction shortly after its reference arrives, and stops promptly', async () => {
    const wallet = await openWallet('100.00');
    const betId = randomUUID();
    const win = await referencing(wallet, Kind.Win, betId, '40.00');
    const worker = new PendingReferenceWorker({
      recheck: recheckUseCase,
      logger: silentLogger,
      options: { batchSize: 10, idleDelayMs: 20 },
    });
    worker.start();

    try {
      await submit(wallet, { externalTransactionId: betId });
      const deadline = Date.now() + 5_000;
      while ((await stored(win)).status !== Status.Processed && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect((await stored(win)).status).toBe(Status.Processed);
    } finally {
      const stopping = Date.now();
      await worker.stop();
      expect(Date.now() - stopping).toBeLessThan(1_000);
    }
  });
});

itKeepsEveryBalanceEqualToItsLedger(() => db);
