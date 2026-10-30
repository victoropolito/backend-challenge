import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createHttpApp } from '../../../src/http/create-http-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, eventually, type TestQueues } from '../support/test-queues';

const ENV_KEYS = [
  'DATABASE_URL',
  'SQS_WAGER_QUEUE_NAME',
  'SQS_WAGER_DLQ_NAME',
  'SQS_EVENTS_QUEUE_NAME',
  'SQS_CONSUMER_ENABLED',
  'SQS_CONSUMER_WAIT_TIME_SECONDS',
] as const;

let db: TestDatabase;
let queues: TestQueues;
let app: INestApplication | undefined;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  Object.assign(process.env, {
    DATABASE_URL: db.url,
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName,
    SQS_CONSUMER_ENABLED: 'true',
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
  });
  app = await createHttpApp({ logger: false });
  await app.listen(0);
}, 30_000);

afterAll(async () => {
  await app?.close();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await queues?.delete();
  await db?.drop();
});

describe('consumer and outbox publisher in the application', () => {
  it('consumes the configured queue with the same use case as the API, publishes the events, and stops on close', async () => {
    const baseUrl = (await app!.getUrl()).replace('[::1]', 'localhost');
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet = (await created.json()) as { id: string; playerId: string };
    const externalTransactionId = randomUUID();

    await queues.send(
      {
        messageId: randomUUID(),
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
        },
      },
      wallet.id,
    );

    await eventually(async () => {
      const response = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/${externalTransactionId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
    });
    await eventually(async () => expect(await queues.countMain()).toBe(0));

    const events: { eventType: string; data: { externalTransactionId?: string } }[] = [];
    await eventually(async () => {
      events.push(...(await queues.drainEvents()).map((item) => JSON.parse(item.Body!)));
      expect(
        events.filter((event) => event.data.externalTransactionId === externalTransactionId).map((event) => event.eventType),
      ).toEqual(['WagerTransactionProcessed']);
      expect(events.filter((event) => event.eventType === 'WalletBalanceChanged')).toHaveLength(2);
    });

    const closing = Date.now();
    await app!.close();
    app = undefined;
    expect(Date.now() - closing).toBeLessThan(5_000);
  });
});
