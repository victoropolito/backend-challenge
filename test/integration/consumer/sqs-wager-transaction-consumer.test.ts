import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import { Clock } from '../../../src/application/shared/clock';
import {
  ConsumeWagerTransactionMessageUseCase,
  type WagerTransactionMessage,
} from '../../../src/application/wagering/consume-wager-transaction-message.use-case';
import { SubmitWagerTransactionUseCase } from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionProcessor } from '../../../src/application/wagering/wager-transaction-processor';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import {
  SqsWagerTransactionConsumer,
  type SqsWagerTransactionConsumerOptions,
} from '../../../src/consumer/sqs-wager-transaction-consumer';
import { parseWagerTransactionMessage } from '../../../src/consumer/wager-transaction-message';
import { silentLogger } from '../../support/loggers';
import { Money } from '../../../src/domain/shared/money';
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
import { createTestQueues, eventually, type TestQueues } from '../support/test-queues';

setDefaultTimeout(30_000);

type Handler = Pick<ConsumeWagerTransactionMessageUseCase, 'execute'>;

let db: TestDatabase;
let useCase: ConsumeWagerTransactionMessageUseCase;
let createWallet: CreateWalletUseCase;
const cleanups: (() => Promise<void>)[] = [];

const clock = new (class extends Clock {
  now(): Date {
    return new Date();
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
  const submit = new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids });
  useCase = new ConsumeWagerTransactionMessageUseCase({ consumerName: 'wager-transactions-consumer', inbox, submit });
  createWallet = new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids });
}, 30_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

afterAll(async () => {
  await db?.drop();
});

const queues = async (): Promise<TestQueues> => {
  const created = await createTestQueues();
  cleanups.push(() => created.delete());
  return created;
};

const startConsumer = (
  q: TestQueues,
  handler: Handler = useCase,
  options: Partial<SqsWagerTransactionConsumerOptions> = {},
): SqsWagerTransactionConsumer => {
  const consumer = new SqsWagerTransactionConsumer({
    sqs: q.sqs,
    handler,
    clock,
    logger: silentLogger,
    options: {
      queueUrl: q.queueUrl,
      deadLetterQueueUrl: q.dlqUrl,
      waitTimeSeconds: 1,
      batchSize: 10,
      visibilityTimeoutSeconds: 30,
      maxAttempts: 3,
      retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
      shutdownTimeoutMs: 5_000,
      ...options,
    },
  });
  consumer.start();
  cleanups.unshift(() => consumer.stop());
  return consumer;
};

const openWallet = (amount = '100.00') =>
  createWallet.execute({
    playerId: randomUUID(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: randomUUID(),
  });

const messageBody = (wallet: Wallet, data: Record<string, unknown> = {}, messageId = randomUUID()) => {
  const externalTransactionId = (data.externalTransactionId as string | undefined) ?? randomUUID();
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
};

const balanceOf = async (walletId: string) =>
  (await db.execute<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;

const transactionsOf = (walletId: string) =>
  db.execute<{ external_transaction_id: string; status: string; failure_code: string | null }>(
    `select external_transaction_id, status, failure_code from wager_transactions
     where wallet_id = ? and kind <> 'OPENING' order by created_at, id`,
    [walletId],
  );

const ledgerOrder = async (walletId: string) =>
  (
    await db.execute<{ external_transaction_id: string }>(
      `select t.external_transaction_id from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
       where l.wallet_id = ? and t.kind <> 'OPENING' order by l.sequence`,
      [walletId],
    )
  ).map((row) => row.external_transaction_id);

const attribute = (message: Message, name: string) => message.MessageAttributes?.[name]?.StringValue;

const expectDrained = (q: TestQueues) =>
  eventually(async () => {
    expect(await q.countMain()).toBe(0);
  });

/** Handler que falha nas primeiras `failures` chamadas com `error` e depois delega ao caso de uso real. */
const failing = (failures: number, error: unknown) => {
  const calls: Date[] = [];
  const handler: Handler = {
    async execute(message: WagerTransactionMessage) {
      calls.push(new Date());
      if (calls.length <= failures) {
        throw error;
      }
      return useCase.execute(message);
    },
  };
  return { handler, calls };
};

/** Handler que espera `open()` antes de delegar ao caso de uso real. */
const gated = () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let started!: () => void;
  const startedSignal = new Promise<void>((resolve) => (started = resolve));
  const handler: Handler = {
    async execute(message: WagerTransactionMessage) {
      started();
      await gate;
      return useCase.execute(message);
    },
  };
  return { handler, open, started: startedSignal };
};

const connectionLost = () => Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });

describe('SqsWagerTransactionConsumer', () => {
  it('applies a message and deletes it after the commit', async () => {
    const q = await queues();
    const wallet = await openWallet();
    startConsumer(q);

    await q.send(messageBody(wallet), wallet.id);

    await eventually(async () => expect(await balanceOf(wallet.id)).toBe('75.00'));
    await expectDrained(q);
    expect(await q.readDlq()).toEqual([]);
  });

  it('acknowledges business rejections without retrying them', async () => {
    const q = await queues();
    const wallet = await openWallet('10.00');
    startConsumer(q);

    await q.send(messageBody(wallet), wallet.id);

    await eventually(async () =>
      expect(await transactionsOf(wallet.id)).toEqual([
        expect.objectContaining({ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }),
      ]),
    );
    await expectDrained(q);
    expect(await q.readDlq()).toEqual([]);
  });

  it('applies a redelivered message only once', async () => {
    const q = await queues();
    const wallet = await openWallet();
    const body = messageBody(wallet);
    startConsumer(q);

    await q.send(body, wallet.id);
    await q.send(body, wallet.id);
    await q.send({ ...body, messageId: randomUUID() }, wallet.id);

    await expectDrained(q);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect(await q.readDlq()).toEqual([]);
  });

  it('acknowledges a message whose transaction was committed before a crash, without applying it again', async () => {
    const q = await queues();
    const wallet = await openWallet();
    const body = messageBody(wallet);
    await useCase.execute(parseWagerTransactionMessage(JSON.stringify(body), new Date()));

    await q.send(body, wallet.id);
    startConsumer(q);

    await expectDrained(q);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await q.readDlq()).toEqual([]);
  });

  it('sends a malformed message straight to the DLQ with the failure reason', async () => {
    const q = await queues();
    const { handler, calls } = failing(0, undefined);
    startConsumer(q, handler);

    await q.send('{"messageId":', 'group-1');

    let dead: Message[] = [];
    await eventually(async () => {
      dead = await q.readDlq();
      expect(dead).toHaveLength(1);
    });
    expect(dead[0]!.Body).toBe('{"messageId":');
    expect(attribute(dead[0]!, 'failureKind')).toBe('PERMANENT');
    expect(attribute(dead[0]!, 'failureCode')).toBe('MALFORMED_MESSAGE');
    expect(attribute(dead[0]!, 'receiveCount')).toBe('1');
    expect(calls).toHaveLength(0);
    await expectDrained(q);
  });

  it('sends an idempotency conflict to the DLQ and keeps the original transaction', async () => {
    const q = await queues();
    const wallet = await openWallet();
    const body = messageBody(wallet);
    startConsumer(q);

    await q.send(body, wallet.id);
    await q.send(
      { ...body, messageId: randomUUID(), data: { ...body.data, money: { amount: '30.00', currency: 'BRL' } } },
      wallet.id,
    );

    await eventually(async () => {
      const dead = await q.readDlq();
      expect(dead.map((message) => attribute(message, 'failureCode'))).toEqual(['IDEMPOTENCY_CONFLICT']);
    });
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  it('retries a transient failure with backoff until it succeeds', async () => {
    const q = await queues();
    const wallet = await openWallet();
    const { handler, calls } = failing(2, connectionLost());
    startConsumer(q, handler);

    await q.send(messageBody(wallet), wallet.id);

    await eventually(async () => expect(await balanceOf(wallet.id)).toBe('75.00'));
    expect(calls).toHaveLength(3);
    expect(calls[1]!.getTime() - calls[0]!.getTime()).toBeGreaterThanOrEqual(900);
    expect(calls[2]!.getTime() - calls[1]!.getTime()).toBeGreaterThanOrEqual(900);
    await expectDrained(q);
    expect(await q.readDlq()).toEqual([]);
  });

  it('sends a message to the DLQ once the attempts are exhausted', async () => {
    const q = await queues();
    const wallet = await openWallet();
    const { handler, calls } = failing(Number.POSITIVE_INFINITY, connectionLost());
    startConsumer(q, handler);

    await q.send(messageBody(wallet), wallet.id);

    let dead: Message[] = [];
    await eventually(async () => {
      dead = await q.readDlq();
      expect(dead).toHaveLength(1);
    });
    expect(attribute(dead[0]!, 'failureKind')).toBe('TRANSIENT');
    expect(attribute(dead[0]!, 'failureCode')).toBe('ECONNRESET');
    expect(attribute(dead[0]!, 'receiveCount')).toBe('3');
    expect(calls).toHaveLength(3);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectDrained(q);
  });

  it('processes the messages of a group in order, and groups in parallel', async () => {
    const q = await queues();
    const first = await openWallet('1000.00');
    const second = await openWallet('1000.00');
    const ids = (prefix: string) => Array.from({ length: 6 }, (_, index) => `${prefix}-${index}`);
    for (const [wallet, prefix] of [[first, 'a'], [second, 'b']] as const) {
      for (const externalTransactionId of ids(prefix)) {
        await q.send(messageBody(wallet, { externalTransactionId }), wallet.id);
      }
    }
    startConsumer(q);

    await expectDrained(q);
    expect(await ledgerOrder(first.id)).toEqual(ids('a'));
    expect(await ledgerOrder(second.id)).toEqual(ids('b'));
  });

  describe('shutdown', () => {
    it('finishes the message in progress and stops receiving', async () => {
      const q = await queues();
      const wallet = await openWallet();
      const { handler, open, started } = gated();
      const consumer = startConsumer(q, handler);
      await q.send(messageBody(wallet), wallet.id);
      await started;

      let stopped = false;
      const stopping = consumer.stop().then(() => (stopped = true));
      await Bun.sleep(300);
      expect(stopped).toBe(false);

      open();
      await stopping;
      expect(await balanceOf(wallet.id)).toBe('75.00');
      expect(await q.countMain()).toBe(0);

      await q.send(messageBody(wallet), wallet.id);
      await Bun.sleep(1_500);
      expect(await balanceOf(wallet.id)).toBe('75.00');
      expect(await q.countMain()).toBe(1);
    });

    it('releases the visibility of a message still in progress when the timeout is reached', async () => {
      const q = await queues();
      const wallet = await openWallet();
      const { handler, open, started } = gated();
      const consumer = startConsumer(q, handler, { shutdownTimeoutMs: 200 });
      await q.send(messageBody(wallet), wallet.id);
      await started;

      await consumer.stop();
      const releasedAt = Date.now();
      startConsumer(q);

      await eventually(async () => expect(await balanceOf(wallet.id)).toBe('75.00'));
      expect(Date.now() - releasedAt).toBeLessThan(10_000);
      open();
      await expectDrained(q);
      expect(await transactionsOf(wallet.id)).toHaveLength(1);
    });
  });
});
