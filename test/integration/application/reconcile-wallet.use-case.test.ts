import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import {
  ReconcileWalletUseCase,
  type WalletReconciliation,
} from '../../../src/application/wallet/reconcile-wallet.use-case';
import { ReconciliationMonitor } from '../../../src/application/wallet/reconciliation-monitor';
import { WalletNotFoundError } from '../../../src/application/wallet/wallet-queries';
import { Money } from '../../../src/domain/shared/money';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
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

let db: TestDatabase;
let submitUseCase: SubmitWagerTransactionUseCase;
let createWalletUseCase: CreateWalletUseCase;
let reconcile: ReconcileWalletUseCase;

const clock = new (class extends Clock {
  now(): Date {
    return new Date('2026-10-30T12:00:00.000Z');
  }
})();

const monitor = new (class extends ReconciliationMonitor {
  readonly received: WalletReconciliation[] = [];
  reconciled(reconciliation: WalletReconciliation): void {
    this.received.push(reconciliation);
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
  const processor = new WagerTransactionProcessor({ wallets, ledger, wagerTransactions, outbox, ids });
  const inbox = new MikroOrmInboxRepository(em);
  submitUseCase = new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids });
  createWalletUseCase = new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids });
  reconcile = new ReconcileWalletUseCase({ ledger, monitor, clock });
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const openWallet = (amount: string) =>
  createWalletUseCase.execute({ playerId: randomUUID(), initialBalance: brl(amount), correlationId: randomUUID() });

const submit = async (wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}) => {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return (
    await submitUseCase.execute({
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
      correlationId: 'corr-1',
      ...overrides,
    })
  ).transaction;
};

/** Altera o saldo materializado sem lançamento, desligando a verificação do banco só para esta escrita. */
const corruptBalance = (wallet: Wallet, delta: string) =>
  db.transaction(async (execute) => {
    await execute('alter table wallets disable trigger wallets_balance_matches_ledger');
    await execute('update wallets set balance = balance + ? where id = ?', [delta, wallet.id]);
    await execute('alter table wallets enable trigger wallets_balance_matches_ledger');
  });

describe('ReconcileWalletUseCase', () => {
  it('a wallet with movements matches its ledger', async () => {
    const wallet = await openWallet('100.00');
    const bet = await submit(wallet, { money: brl('25.00') });
    const win = await submit(wallet, {
      kind: Kind.Win,
      money: brl('40.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submit(wallet, { kind: Kind.Loss, money: brl('0.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await submit(wallet, { kind: Kind.Rollback, money: brl('40.00'), referenceExternalTransactionId: win.externalTransactionId });
    await submit(wallet, { money: brl('500.00') });

    const result = await reconcile.execute(wallet.id);

    expect(result).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: Money.zero('BRL'),
      consistent: true,
      checkedEntries: 4,
      checkedAt: clock.now(),
    });
    expect(monitor.received.at(-1)).toBe(result);
  });

  it('a wallet opened with zero balance has no entries and is consistent', async () => {
    const wallet = await openWallet('0.00');

    const result = await reconcile.execute(wallet.id);

    expect(result.storedBalance).toEqual(Money.zero('BRL'));
    expect(result.calculatedBalance).toEqual(Money.zero('BRL'));
    expect(result.checkedEntries).toBe(0);
    expect(result.consistent).toBe(true);
  });

  it('reports a divergence without correcting it', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, { money: brl('30.00') });
    await corruptBalance(wallet, '1.50');

    const result = await reconcile.execute(wallet.id);

    expect(result.consistent).toBe(false);
    expect(result.storedBalance).toEqual(brl('71.50'));
    expect(result.calculatedBalance).toEqual(brl('70.00'));
    expect(result.difference).toEqual(brl('1.50'));
    expect(result.checkedEntries).toBe(2);
    expect(monitor.received.at(-1)).toBe(result);
    expect((await new MikroOrmWalletRepository(db.orm.em.fork()).findById(wallet.id))!.balance).toEqual(brl('71.50'));
  });

  it('a stored balance below the ledger gives a negative difference', async () => {
    const wallet = await openWallet('100.00');
    await corruptBalance(wallet, '-0.01');

    const result = await reconcile.execute(wallet.id);

    expect(result.difference).toEqual(Money.rehydrate({ amount: '-0.01', currency: 'BRL' }));
    expect(result.consistent).toBe(false);
  });

  it('an unknown or malformed wallet id is not found', async () => {
    await expect(reconcile.execute(randomUUID())).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(reconcile.execute('not-a-uuid')).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  it('never reports a false divergence while the wallet is being moved concurrently', async () => {
    const wallet = await openWallet('1000.00');

    let moving = true;
    const moves = (async () => {
      for (let i = 0; i < 60; i++) {
        await submit(wallet, { money: brl('1.00') });
      }
      moving = false;
    })();
    const checks = (async () => {
      const results: WalletReconciliation[] = [];
      while (moving) {
        results.push(...(await Promise.all([reconcile.execute(wallet.id), reconcile.execute(wallet.id)])));
      }
      return results;
    })();
    const [, results] = await Promise.all([moves, checks]);

    expect(results.length).toBeGreaterThan(20);
    expect(results.filter((result) => !result.consistent)).toEqual([]);
    const final = await reconcile.execute(wallet.id);
    expect(final.storedBalance).toEqual(brl('940.00'));
    expect(final.checkedEntries).toBe(61);
    expect(final.consistent).toBe(true);
  });
});
