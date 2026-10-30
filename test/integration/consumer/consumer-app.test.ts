import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createHttpApp } from '../../../src/http/create-http-app';
import { configureLogging } from '../../../src/infrastructure/observability/structured-logger';
import { sampleValue } from '../../support/metrics';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { itKeepsEveryBalanceEqualToItsLedger } from '../support/ledger-invariant';
import { createTestQueues, eventually, type TestQueues } from '../support/test-queues';

setDefaultTimeout(30_000);

const ENV_KEYS = [
  'DATABASE_URL',
  'SQS_WAGER_QUEUE_NAME',
  'SQS_WAGER_DLQ_NAME',
  'SQS_EVENTS_QUEUE_NAME',
  'SQS_CONSUMER_ENABLED',
  'SQS_CONSUMER_WAIT_TIME_SECONDS',
  'REFERENCE_WORKER_IDLE_DELAY_MS',
] as const;

let db: TestDatabase;
let queues: TestQueues;
let app: INestApplication | undefined;
const logLines: Record<string, any>[] = [];
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
    REFERENCE_WORKER_IDLE_DELAY_MS: '100',
  });
  app = await createHttpApp({ logger: false });
  configureLogging({ level: 'debug', write: (line) => logLines.push(JSON.parse(line)) });
  await app.listen(0);
}, 30_000);

afterAll(async () => {
  await app?.close();
  configureLogging({ level: 'silent' });
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

const baseUrl = async () => (await app!.getUrl()).replace('[::1]', 'localhost');

const openWallet = async () => {
  const created = await fetch(`${await baseUrl()}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  return (await created.json()) as { id: string; playerId: string };
};

const sendTransaction = async (
  wallet: { id: string; playerId: string },
  data: { externalTransactionId: string; kind: string; amount: string; referenceExternalTransactionId?: string },
) => {
  const messageId = randomUUID();
  await queues.send(
    {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: `provider-a:${data.externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: data.kind,
        money: { amount: data.amount, currency: 'BRL' },
        referenceExternalTransactionId: data.referenceExternalTransactionId ?? null,
      },
    },
    wallet.id,
  );
  return messageId;
};

const transactionOf = async (externalTransactionId: string) =>
  (await fetch(`${await baseUrl()}/providers/provider-a/wagering/transactions/${externalTransactionId}`)).json() as Promise<{
    status: string;
    balance: { amount: string } | null;
  }>;

describe('consumer and outbox publisher in the application', () => {
  it('a WIN received before its BET waits and is applied by the pending reference worker once the BET arrives', async () => {
    const wallet = await openWallet();
    const betId = randomUUID();
    const winId = randomUUID();

    await sendTransaction(wallet, { externalTransactionId: winId, kind: 'WIN', amount: '40.00', referenceExternalTransactionId: betId });
    await eventually(async () => expect((await transactionOf(winId)).status).toBe('PENDING_REFERENCE'));
    await sendTransaction(wallet, { externalTransactionId: betId, kind: 'BET', amount: '25.00' });

    await eventually(async () => expect(await transactionOf(winId)).toMatchObject({ status: 'PROCESSED', balance: { amount: '115.00' } }));
    expect(await transactionOf(betId)).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
  });

  it('consumes the configured queue with the same use case as the API, publishes the events, and stops on close', async () => {
    const wallet = await openWallet();
    const externalTransactionId = randomUUID();

    const messageId = await sendTransaction(wallet, { externalTransactionId, kind: 'BET', amount: '25.00' });

    await eventually(async () =>
      expect(await transactionOf(externalTransactionId)).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } }),
    );
    const recorded = logLines.find(
      (line) => line.message === 'Wager transaction recorded' && line.externalTransactionId === externalTransactionId,
    );
    expect(recorded).toMatchObject({
      level: 'info',
      context: 'Wagering',
      messageId,
      correlationId: messageId,
      sqsMessageId: expect.any(String),
      receiveCount: 1,
      transactionId: expect.any(String),
      walletId: wallet.id,
      providerId: 'provider-a',
      status: 'PROCESSED',
      origin: 'SUBMISSION',
    });
    const walletRequest = logLines.find((line) => line.context === 'Http' && line.method === 'POST' && line.path === '/wallets');
    expect(walletRequest).toMatchObject({ level: 'info', status: 201, correlationId: expect.any(String), durationMs: expect.any(Number) });
    expect(logLines).toContainEqual(
      expect.objectContaining({ level: 'warn', context: 'Auth', message: 'Authentication disabled: every API request is accepted as anonymous' }),
    );
    expect(logLines.filter((line) => JSON.stringify(line).includes('25.00') || 'amount' in line)).toEqual([]);
    await eventually(async () => expect(await queues.countMain()).toBe(0));

    const events: { eventType: string; data: { externalTransactionId?: string; walletId?: string } }[] = [];
    await eventually(async () => {
      events.push(...(await queues.drainEvents()).map((item) => JSON.parse(item.Body!)));
      expect(
        events.filter((event) => event.data.externalTransactionId === externalTransactionId).map((event) => event.eventType),
      ).toEqual(['WagerTransactionProcessed']);
      expect(
        events.filter((event) => event.eventType === 'WalletBalanceChanged' && event.data.walletId === wallet.id),
      ).toHaveLength(2);
    });

    const metrics = await (await fetch(`${await baseUrl()}/metrics`)).text();
    expect(sampleValue(metrics, 'wagering_messages_total{outcome="processed",failure_code=""}')).toBeGreaterThanOrEqual(1);
    expect(sampleValue(metrics, 'wagering_outbox_published_total')).toBeGreaterThanOrEqual(3);
    expect(sampleValue(metrics, 'wagering_outbox_pending_messages')).toBeNumber();

    const closing = Date.now();
    await app!.close();
    app = undefined;
    expect(Date.now() - closing).toBeLessThan(5_000);
  });
});

itKeepsEveryBalanceEqualToItsLedger(() => db);
