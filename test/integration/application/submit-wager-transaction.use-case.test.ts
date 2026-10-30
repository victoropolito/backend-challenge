import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../src/application/shared/clock';
import {
  ExternalTransactionIdConflictError,
  IdempotencyConflictError,
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
  type SubmitWagerTransactionResult,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  InvalidWagerTransactionError,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
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
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let submitUseCase: SubmitWagerTransactionUseCase;
let createWalletUseCase: CreateWalletUseCase;

const clock = new (class extends Clock {
  current = new Date('2026-10-30T12:00:00.000Z');
  now(): Date {
    return new Date(this.current);
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
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const openWallet = (amount = '1000.00', currency = 'BRL') =>
  createWalletUseCase.execute({
    playerId: randomUUID(),
    initialBalance: Money.from({ amount, currency }),
    correlationId: randomUUID(),
  });

const command = (
  wallet: Wallet,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand => {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-1',
    causationId: 'cause-1',
    ...overrides,
  };
};

const submit = (wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}) =>
  submitUseCase.execute(command(wallet, overrides));

const reversalOf = (
  wallet: Wallet,
  reference: SubmitWagerTransactionResult,
  kind: Kind,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
) =>
  submit(wallet, {
    kind,
    money: reference.transaction.money,
    referenceExternalTransactionId: reference.transaction.externalTransactionId,
    ...overrides,
  });

const storedWallet = async (walletId: string) => (await new MikroOrmWalletRepository(db.orm.em.fork()).findById(walletId))!;

const ledgerOf = (walletId: string) =>
  db.execute<{ transaction_id: string; direction: string; amount: string; balance_after: string }>(
    'select transaction_id, direction, amount, balance_after from wallet_ledger_entries where wallet_id = ? order by sequence',
    [walletId],
  );

const eventsOf = (aggregateId: string) =>
  db.execute<{ event_type: string; payload: Record<string, any> }>(
    'select event_type, payload from outbox_messages where aggregate_id = ? order by sequence',
    [aggregateId],
  );

const expectStatus = (result: SubmitWagerTransactionResult, status: Status, failureCode?: FailureCode) => {
  expect(result.transaction.status).toBe(status);
  expect(result.transaction.failureCode).toBe(failureCode);
};

describe('SubmitWagerTransactionUseCase', () => {
  describe('BET', () => {
    it('debits the wallet, writes one ledger entry and the events atomically', async () => {
      const wallet = await openWallet('1000.00');

      const result = await submit(wallet);

      expectStatus(result, Status.Processed);
      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.observedBalance).toEqual(brl('975.00'));
      expect(result.transaction.processedAt).toEqual(clock.now());

      const stored = await storedWallet(wallet.id);
      expect(stored.balance).toEqual(brl('975.00'));
      expect(stored.version).toBe(2);

      const ledger = await ledgerOf(wallet.id);
      expect(ledger.at(-1)).toEqual({
        transaction_id: result.transaction.id,
        direction: 'DEBIT',
        amount: '25.00',
        balance_after: '975.00',
      });

      const transactionEvents = await eventsOf(result.transaction.id);
      expect(transactionEvents.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
      expect(transactionEvents[0]!.payload).toMatchObject({
        correlationId: 'corr-1',
        causationId: 'cause-1',
        data: { balance: { amount: '975.00', currency: 'BRL' } },
      });
      const walletEvents = await eventsOf(wallet.id);
      expect(walletEvents.at(-1)).toMatchObject({
        event_type: 'WalletBalanceChanged',
        payload: { data: { transactionId: result.transaction.id, direction: 'DEBIT', walletVersion: 2 } },
      });
    });

    it('is rejected without touching the balance when the balance is insufficient', async () => {
      const wallet = await openWallet('10.00');

      const result = await submit(wallet, { money: brl('10.01') });

      expectStatus(result, Status.Rejected, FailureCode.InsufficientBalance);
      expect(result.transaction.observedBalance).toEqual(brl('10.00'));
      expect((await storedWallet(wallet.id)).version).toBe(1);
      expect(await ledgerOf(wallet.id)).toHaveLength(1);
      expect((await eventsOf(result.transaction.id)).map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
      expect(await eventsOf(wallet.id)).toHaveLength(1);
    });

    it('may use the whole balance', async () => {
      const wallet = await openWallet('25.00');
      expectStatus(await submit(wallet), Status.Processed);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('0.00'));
    });
  });

  describe('WIN and LOSS', () => {
    it('WIN credits the wallet, with or without a BET reference', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('10.00') });

      const linked = await submit(wallet, {
        kind: Kind.Win,
        money: brl('50.00'),
        referenceExternalTransactionId: bet.transaction.externalTransactionId,
      });
      const unlinked = await submit(wallet, { kind: Kind.Win, money: brl('5.00') });

      expectStatus(linked, Status.Processed);
      expect(linked.transaction.referenceTransactionId).toBe(bet.transaction.id);
      expect(linked.transaction.observedBalance).toEqual(brl('140.00'));
      expectStatus(unlinked, Status.Processed);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('145.00'));
      expect((await ledgerOf(wallet.id)).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT', 'CREDIT']);
    });

    it('LOSS is processed with the current balance, without ledger entry or balance event', async () => {
      const wallet = await openWallet('100.00');

      const result = await submit(wallet, { kind: Kind.Loss, money: brl('0') });

      expectStatus(result, Status.Processed);
      expect(result.transaction.observedBalance).toEqual(brl('100.00'));
      expect((await storedWallet(wallet.id)).version).toBe(1);
      expect(await ledgerOf(wallet.id)).toHaveLength(1);
      expect((await eventsOf(result.transaction.id)).map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
      expect(await eventsOf(wallet.id)).toHaveLength(1);
    });
  });

  describe('reversals', () => {
    it('REFUND credits the BET back once; any further reversal of it is rejected', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('30.00') });

      const refund = await reversalOf(wallet, bet, Kind.Refund);
      const secondRefund = await reversalOf(wallet, bet, Kind.Refund);
      const rollback = await reversalOf(wallet, bet, Kind.Rollback);

      expectStatus(refund, Status.Processed);
      expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
      expect(refund.transaction.observedBalance).toEqual(brl('100.00'));
      for (const duplicate of [secondRefund, rollback]) {
        expectStatus(duplicate, Status.Rejected, FailureCode.ReferenceAlreadyReversed);
        expect(duplicate.transaction.referenceTransactionId).toBe(bet.transaction.id);
      }
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('100.00'));
      expect(await ledgerOf(wallet.id)).toHaveLength(3);
    });

    it('ROLLBACK of a BET credits; ROLLBACK of a WIN debits', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('20.00') });
      const win = await submit(wallet, { kind: Kind.Win, money: brl('50.00') });

      const betRollback = await reversalOf(wallet, bet, Kind.Rollback);
      const winRollback = await reversalOf(wallet, win, Kind.Rollback);

      expectStatus(betRollback, Status.Processed);
      expectStatus(winRollback, Status.Processed);
      expect(winRollback.transaction.observedBalance).toEqual(brl('100.00'));
      expect((await ledgerOf(wallet.id)).slice(-2).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT']);
    });

    it('a REFUND can itself be rolled back', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('20.00') });
      const refund = await reversalOf(wallet, bet, Kind.Refund);

      const rollback = await reversalOf(wallet, refund, Kind.Rollback);

      expectStatus(rollback, Status.Processed);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('80.00'));
    });

    it('a ROLLBACK that would make the balance negative is rejected with its own code and stays auditable', async () => {
      const wallet = await openWallet('0');
      const win = await submit(wallet, { kind: Kind.Win, money: brl('50.00') });
      await submit(wallet, { money: brl('40.00') });

      const rollback = await reversalOf(wallet, win, Kind.Rollback);

      expectStatus(rollback, Status.Rejected, FailureCode.ReversalInsufficientBalance);
      expect(rollback.transaction.referenceTransactionId).toBe(win.transaction.id);
      expect(rollback.transaction.observedBalance).toEqual(brl('10.00'));
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('10.00'));
    });

    it('rejects a reversal whose amount differs from the reference', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('20.00') });
      const refund = await reversalOf(wallet, bet, Kind.Refund, { money: brl('19.99') });
      expectStatus(refund, Status.Rejected, FailureCode.ReferenceAmountMismatch);
    });

    it('rejects a REFUND of something other than a BET', async () => {
      const wallet = await openWallet('100.00');
      const win = await submit(wallet, { kind: Kind.Win, money: brl('20.00') });
      expectStatus(await reversalOf(wallet, win, Kind.Refund), Status.Rejected, FailureCode.ReferenceKindNotAllowed);
    });

    it('rejects a reference from another round or wallet', async () => {
      const wallet = await openWallet('100.00');
      const other = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('20.00') });
      const otherBet = await submit(other, { money: brl('20.00') });

      const otherRound = await reversalOf(wallet, bet, Kind.Refund, { roundId: 'round-2' });
      const otherWallet = await reversalOf(wallet, otherBet, Kind.Refund);

      expectStatus(otherRound, Status.Rejected, FailureCode.ReferenceMismatch);
      expectStatus(otherWallet, Status.Rejected, FailureCode.ReferenceMismatch);
      expect((await storedWallet(other.id)).balance).toEqual(brl('80.00'));
    });

    it('rejects a reference that was not processed', async () => {
      const wallet = await openWallet('10.00');
      const rejectedBet = await submit(wallet, { money: brl('20.00') });
      expectStatus(await reversalOf(wallet, rejectedBet, Kind.Refund), Status.Rejected, FailureCode.ReferenceNotProcessed);
    });
  });

  describe('missing reference', () => {
    it('is persisted as PENDING_REFERENCE with the first check scheduled', async () => {
      const wallet = await openWallet('100.00');

      const result = await submit(wallet, {
        kind: Kind.Refund,
        money: brl('20.00'),
        referenceExternalTransactionId: 'not-yet-received',
      });

      expectStatus(result, Status.PendingReference);
      expect(result.transaction.referenceCheckAttempts).toBe(1);
      expect(result.transaction.nextReferenceCheckAt).toEqual(new Date(clock.now().getTime() + 1_000));
      expect(result.transaction.observedBalance).toBeUndefined();
      expect((await storedWallet(wallet.id)).version).toBe(1);
      expect((await eventsOf(result.transaction.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    });

    it('also waits when the reference is itself waiting for its reference', async () => {
      const wallet = await openWallet('100.00');
      const waitingRefund = await submit(wallet, {
        kind: Kind.Refund,
        money: brl('20.00'),
        referenceExternalTransactionId: 'missing-bet',
      });

      const rollback = await reversalOf(wallet, waitingRefund, Kind.Rollback);

      expectStatus(rollback, Status.PendingReference);
    });
  });

  describe('wallet checks', () => {
    it('rejects a wallet that does not exist, without observed balance', async () => {
      const wallet = await openWallet('100.00');
      const result = await submit(wallet, { walletId: randomUUID() });
      expectStatus(result, Status.Rejected, FailureCode.WalletNotFound);
      expect(result.transaction.observedBalance).toBeUndefined();
      expect((await eventsOf(result.transaction.id)).map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
    });

    it('rejects a wallet of another player without exposing its balance', async () => {
      const wallet = await openWallet('100.00');
      const result = await submit(wallet, { playerId: randomUUID() });
      expectStatus(result, Status.Rejected, FailureCode.WalletPlayerMismatch);
      expect(result.transaction.observedBalance).toBeUndefined();
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('100.00'));
    });

    it('rejects a currency different from the wallet', async () => {
      const wallet = await openWallet('100.00');
      const result = await submit(wallet, { money: Money.from({ amount: '1.00', currency: 'USD' }) });
      expectStatus(result, Status.Rejected, FailureCode.CurrencyMismatch);
    });
  });

  describe('invalid payloads', () => {
    it('refuses a walletId that is not a UUID, writing nothing', async () => {
      const wallet = await openWallet('100.00');
      const attempt = submit(wallet, { walletId: 'wallet-1', externalTransactionId: 'invalid-wallet-id' });
      await expect(attempt).rejects.toBeInstanceOf(InvalidWagerTransactionError);
      expect(await new MikroOrmWagerTransactionRepository(db.orm.em.fork()).findByExternalId('provider-a', 'invalid-wallet-id')).toBeUndefined();
    });

    it('refuses domain-invalid payloads', async () => {
      const wallet = await openWallet('100.00');
      await expect(submit(wallet, { referenceExternalTransactionId: 'x' })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
      await expect(submit(wallet, { kind: Kind.Refund })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
      await expect(submit(wallet, { kind: Kind.Opening })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
      await expect(submit(wallet, { providerId: 'internal' })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    });
  });

  describe('idempotency', () => {
    it('replays the original result, including the balance observed back then', async () => {
      const wallet = await openWallet('100.00');
      const original = command(wallet, { money: brl('30.00') });
      const first = await submitUseCase.execute(original);
      await submit(wallet, { money: brl('10.00') });

      const replay = await submitUseCase.execute({ ...original, correlationId: 'corr-2' });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction).toEqual(first.transaction);
      expect(replay.transaction.observedBalance).toEqual(brl('70.00'));
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('60.00'));
      expect(await ledgerOf(wallet.id)).toHaveLength(3);
      expect(await eventsOf(first.transaction.id)).toHaveLength(1);
    });

    it('replays rejections too', async () => {
      const wallet = await openWallet('10.00');
      const original = command(wallet, { money: brl('20.00') });
      const first = await submitUseCase.execute(original);
      await submit(wallet, { kind: Kind.Win, money: brl('100.00') });

      const replay = await submitUseCase.execute(original);

      expect(replay.idempotentReplay).toBe(true);
      expectStatus(replay, Status.Rejected, FailureCode.InsufficientBalance);
      expect(replay.transaction.id).toBe(first.transaction.id);
    });

    it('treats an equivalent amount notation as the same payload', async () => {
      const wallet = await openWallet('100.00');
      const original = command(wallet, { money: brl('25') });
      await submitUseCase.execute(original);
      const replay = await submitUseCase.execute({ ...original, money: brl('25.00') });
      expect(replay.idempotentReplay).toBe(true);
    });

    it('refuses the same key with a different payload as a conflict, not a replay', async () => {
      const wallet = await openWallet('100.00');
      const original = command(wallet);
      const first = await submitUseCase.execute(original);

      const conflict = await submitUseCase.execute({ ...original, money: brl('26.00') }).catch((e: unknown) => e);

      expect(conflict).toBeInstanceOf(IdempotencyConflictError);
      expect((conflict as IdempotencyConflictError).existingTransactionId).toBe(first.transaction.id);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('75.00'));
    });

    it('refuses an external id already submitted under another key', async () => {
      const wallet = await openWallet('100.00');
      const original = command(wallet);
      await submitUseCase.execute(original);

      const attempt = submitUseCase.execute({ ...original, idempotencyKey: 'another-key' });

      await expect(attempt).rejects.toBeInstanceOf(ExternalTransactionIdConflictError);
      expect(await ledgerOf(wallet.id)).toHaveLength(2);
    });

    it('scopes keys and external ids by provider', async () => {
      const wallet = await openWallet('100.00');
      const fromA = await submit(wallet, { externalTransactionId: 'shared-id', idempotencyKey: 'shared-key' });
      const fromB = await submit(wallet, {
        providerId: 'provider-b',
        externalTransactionId: 'shared-id',
        idempotencyKey: 'shared-key',
      });
      expect(fromB.idempotentReplay).toBe(false);
      expect(fromB.transaction.id).not.toBe(fromA.transaction.id);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous 80.00 BETs on 100.00: exactly one debit (10 wallets at once)', async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));

      const pairs = await Promise.all(
        wallets.map((wallet) => Promise.all([submit(wallet, { money: brl('80.00') }), submit(wallet, { money: brl('80.00') })])),
      );

      for (const [index, results] of pairs.entries()) {
        const wallet = wallets[index]!;
        const statuses = results.map((r) => r.transaction.status).sort();
        expect(statuses).toEqual([Status.Processed, Status.Rejected]);
        expect(results.find((r) => r.transaction.status === Status.Rejected)!.transaction.failureCode).toBe(
          FailureCode.InsufficientBalance,
        );
        expect((await storedWallet(wallet.id)).balance).toEqual(brl('20.00'));
        expect((await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
      }
    });

    it('50 simultaneous submissions of the same transaction apply it once and replay the rest', async () => {
      const wallet = await openWallet('100.00');
      const same = command(wallet, { money: brl('10.00') });

      const results = await Promise.all(Array.from({ length: 50 }, () => submitUseCase.execute(same)));

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      expect(results.every((r) => r.transaction.observedBalance!.equals(brl('90.00')))).toBe(true);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('90.00'));
      expect(await ledgerOf(wallet.id)).toHaveLength(2);
    });

    it('50 simultaneous BETs on a hot wallet never overdraw it', async () => {
      const wallet = await openWallet('200.00');

      const results = await Promise.all(Array.from({ length: 50 }, () => submit(wallet, { money: brl('10.00') })));

      expect(results.filter((r) => r.transaction.status === Status.Processed)).toHaveLength(20);
      expect(results.filter((r) => r.transaction.failureCode === FailureCode.InsufficientBalance)).toHaveLength(30);
      const stored = await storedWallet(wallet.id);
      expect(stored.balance).toEqual(brl('0.00'));
      expect(stored.version).toBe(21);
      const balances = results
        .filter((r) => r.transaction.status === Status.Processed)
        .map((r) => r.transaction.observedBalance!.toJSON().amount)
        .sort();
      expect(new Set(balances).size).toBe(20);
    });

    it('a simultaneous REFUND and ROLLBACK of the same BET: only one reversal is applied', async () => {
      const wallet = await openWallet('100.00');
      const bet = await submit(wallet, { money: brl('40.00') });

      const results = await Promise.all([reversalOf(wallet, bet, Kind.Refund), reversalOf(wallet, bet, Kind.Rollback)]);

      expect(results.filter((r) => r.transaction.status === Status.Processed)).toHaveLength(1);
      expect(results.filter((r) => r.transaction.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(1);
      expect((await storedWallet(wallet.id)).balance).toEqual(brl('100.00'));
    });

    it('different wallets are processed independently', async () => {
      const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet('50.00')));

      const results = await Promise.all(
        wallets.flatMap((wallet) => Array.from({ length: 4 }, () => submit(wallet, { money: brl('10.00') }))),
      );

      expect(results.every((r) => r.transaction.status === Status.Processed)).toBe(true);
      for (const wallet of wallets) {
        expect((await storedWallet(wallet.id)).balance).toEqual(brl('10.00'));
      }
    });
  });
});
