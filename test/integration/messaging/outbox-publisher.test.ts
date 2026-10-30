import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import { PublishOutboxUseCase } from '../../../src/application/messaging/publish-outbox.use-case';
import { Clock } from '../../../src/application/shared/clock';
import { CreateWalletUseCase } from '../../../src/application/wallet/create-wallet.use-case';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/shared/money';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import { MikroOrmOutboxRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../src/infrastructure/database/repositories/mikro-orm-wallet.repository';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { UuidV7Generator } from '../../../src/infrastructure/system/uuid-v7-generator';
import { OutboxPublisherWorker } from '../../../src/workers/outbox-publisher.worker';
import { silentLogger } from '../../support/loggers';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, eventually, type TestQueues } from '../support/test-queues';

setDefaultTimeout(30_000);

let db: TestDatabase;
let queues: TestQueues;
let createWallet: CreateWalletUseCase;
const stops: (() => Promise<void>)[] = [];

const clock = new (class extends Clock {
  now(): Date {
    return new Date();
  }
})();

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  const em = db.orm.em;
  createWallet = new CreateWalletUseCase({
    transactions: new MikroOrmTransactionRunner(em),
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    wagerTransactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    clock,
    ids: new UuidV7Generator(),
  });
}, 30_000);

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  await queues.drainEvents();
});

afterAll(async () => {
  await queues?.delete();
  await db?.drop();
});

const publisherFor = (queueName: string) => new SqsEventPublisher(queues.sqs, { queueName, timeoutMs: 5_000 });

const startWorker = () => {
  const publish = new PublishOutboxUseCase({
    transactions: new MikroOrmTransactionRunner(db.orm.em),
    outbox: new MikroOrmOutboxRepository(db.orm.em),
    publisher: publisherFor(queues.eventsQueueName),
    clock,
  });
  const worker = new OutboxPublisherWorker({ publish, logger: silentLogger, options: { batchSize: 10, idleDelayMs: 100 } });
  worker.start();
  stops.push(() => worker.stop());
  return worker;
};

const message = (aggregateId = randomUUID()) => {
  const id = randomUUID();
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: id, eventType: 'WagerTransactionProcessed', aggregateId, data: { amount: '1.00' } },
    occurredAt: new Date(),
    attempts: 0,
    nextAttemptAt: undefined,
    publishedAt: undefined,
  });
};

const attribute = (received: Message, name: string) => received.MessageAttributes?.[name]?.StringValue;

const pendingCount = async () =>
  (await db.execute<{ count: number }>('select count(*)::int as count from outbox_messages where published_at is null'))[0]!
    .count;

describe('SqsEventPublisher', () => {
  it('publishes the envelope with the aggregate as group and the event id as deduplication id', async () => {
    const aggregateId = randomUUID();
    const messages = Array.from({ length: 12 }, () => message(aggregateId));

    const failures = await publisherFor(queues.eventsQueueName).publish(messages);

    expect(failures).toEqual(new Map());
    const received = await queues.drainEvents();
    expect(received.map((item) => JSON.parse(item.Body!))).toEqual(messages.map((item) => item.payload));
    expect(received.every((item) => item.Attributes?.MessageGroupId === aggregateId)).toBe(true);
    expect(attribute(received[0]!, 'eventType')).toBe('WagerTransactionProcessed');
    expect(attribute(received[0]!, 'eventId')).toBe(messages[0]!.id);
  });

  it('a republication of the same event within the deduplication window is delivered once', async () => {
    const event = message();
    const publisher = publisherFor(queues.eventsQueueName);

    await publisher.publish([event]);
    await publisher.publish([event]);

    expect((await queues.drainEvents()).map((item) => attribute(item, 'eventId'))).toEqual([event.id]);
  });

  it('fails when the queue does not exist', async () => {
    await expect(publisherFor(`missing-${randomUUID()}.fifo`).publish([message()])).rejects.toThrow();
  });
});

describe('OutboxPublisherWorker', () => {
  it('publishes events committed while no publisher was running, then empties the outbox', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () =>
        createWallet.execute({
          playerId: randomUUID(),
          initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
          correlationId: 'corr-outbox',
        }),
      ),
    );
    expect(await pendingCount()).toBe(10);

    startWorker();

    await eventually(async () => expect(await pendingCount()).toBe(0));
    const events = (await queues.drainEvents()).map((item) => JSON.parse(item.Body!));
    expect(events).toHaveLength(10);
    for (const wallet of wallets) {
      expect(events.filter((event) => event.data.walletId === wallet.id).map((event) => event.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    }
    expect(events.every((event) => event.correlationId === 'corr-outbox')).toBe(true);
  });

  it('three workers together publish every event, each one received once', async () => {
    startWorker();
    startWorker();
    startWorker();

    await Promise.all(
      Array.from({ length: 30 }, () =>
        createWallet.execute({
          playerId: randomUUID(),
          initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
          correlationId: randomUUID(),
        }),
      ),
    );

    await eventually(async () => expect(await pendingCount()).toBe(0));
    const ids = (await queues.drainEvents()).map((item) => attribute(item, 'eventId'));
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  it('stops promptly, finishing the batch in progress', async () => {
    const worker = startWorker();
    await Bun.sleep(200);

    const started = Date.now();
    await worker.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
