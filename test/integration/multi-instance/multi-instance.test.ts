import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sampleValue } from '../../support/metrics';
import { itKeepsEveryBalanceEqualToItsLedger } from '../support/ledger-invariant';
import { startAppInstance, type AppInstance } from '../support/app-instances';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, eventually, type TestQueues } from '../support/test-queues';

const TIMEOUT_MS = 180_000;

let db: TestDatabase;
let queues: TestQueues;
const instances: AppInstance[] = [];

const instanceEnv = () => ({
  DATABASE_URL: db.url,
  SQS_WAGER_QUEUE_NAME: queues.queueName,
  SQS_WAGER_DLQ_NAME: queues.dlqName,
  SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName,
  SQS_CONSUMER_ENABLED: 'true',
  SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
  SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
  OUTBOX_PUBLISHER_ENABLED: 'true',
  OUTBOX_IDLE_DELAY_MS: '100',
  REFERENCE_WORKER_ENABLED: 'true',
  REFERENCE_WORKER_IDLE_DELAY_MS: '100',
});

const start = async (name: string) => {
  const instance = await startAppInstance(name, instanceEnv());
  instances.push(instance);
  return instance;
};

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  await Promise.all(['instance-1', 'instance-2', 'instance-3'].map(start));
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(instances.map((instance) => instance.kill()));
  await queues?.delete();
  await db?.drop();
});

const running = () => instances.filter((instance) => instance.process.exitCode === null && !instance.process.killed);
const pick = (index: number) => {
  const alive = running();
  return alive[index % alive.length]!;
};

const post = async (instance: AppInstance, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${instance.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const createWallet = async (amount: string, instance = pick(0)) => {
  const response = await post(instance, '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
};

type Wallet = { id: string; playerId: string };

const transaction = (wallet: Wallet, overrides: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
  ...overrides,
});

const submit = (instance: AppInstance, body: Record<string, unknown>) =>
  post(instance, '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

const walletRow = async (walletId: string) =>
  (await db.execute<{ balance: string; version: number }>('select balance::text as balance, version from wallets where id = ?', [walletId]))[0]!;

const countOf = async (sql: string, params: unknown[] = []) =>
  (await db.execute<{ count: number }>(`select count(*)::int as count from ${sql}`, params))[0]!.count;

describe('three or more application instances on the same database and queues', () => {
  it(
    'HTTP: the 100.00 / 80.00 + 80.00 scenario with each BET sent to a different instance, on 10 wallets at once',
    async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, (_, index) => createWallet('100.00', pick(index))));

      const pairs = await Promise.all(
        wallets.map((wallet, index) =>
          Promise.all([
            submit(pick(index), transaction(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
            submit(pick(index + 1), transaction(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
          ]),
        ),
      );

      for (const [index, responses] of pairs.entries()) {
        expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
        expect(responses.find((response) => response.status === 422)!.body.failureCode).toBe('INSUFFICIENT_BALANCE');
        expect((await walletRow(wallets[index]!.id)).balance).toBe('20.00');
        expect(await countOf(`wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallets[index]!.id])).toBe(1);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'HTTP: the same BET sent 30 times in parallel across the instances is debited once',
    async () => {
      const wallet = await createWallet('100.00');
      const bet = transaction(wallet);

      const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => submit(pick(index), bet)));

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
      expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
      expect(responses.every((response) => response.body.balance.amount === '90.00')).toBe(true);
      expect((await walletRow(wallet.id)).balance).toBe('90.00');
      expect(await countOf(`wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id])).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    'HTTP: 60 BETs on a hot wallet spread over the instances never overdraw it',
    async () => {
      const wallet = await createWallet('300.00');

      const responses = await Promise.all(Array.from({ length: 60 }, (_, index) => submit(pick(index), transaction(wallet))));

      expect(responses.filter((response) => response.status === 200)).toHaveLength(30);
      expect(responses.filter((response) => response.body.failureCode === 'INSUFFICIENT_BALANCE')).toHaveLength(30);
      expect(new Set(responses.filter((response) => response.status === 200).map((response) => response.body.balance.amount)).size).toBe(30);
      expect(await walletRow(wallet.id)).toEqual({ balance: '0.00', version: 31 });
    },
    TIMEOUT_MS,
  );

  it(
    'queue: every instance consumes, one is killed mid-burst and replaced, and every transaction is applied exactly once',
    async () => {
      const WALLETS = 8;
      const BETS_PER_WALLET = 40;
      const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, index) => createWallet('1000.00', pick(index))));

      const message = (wallet: Wallet, data: Record<string, unknown>, messageId: string) => ({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...transaction(wallet, data),
          idempotencyKey: `provider-a:${data.externalTransactionId as string}`,
        },
      });

      // Por wallet, em ordem no grupo: um WIN antes da sua BET (referência fora de ordem) e cada BET entregue duas vezes.
      const sending = Promise.all(
        wallets.map(async (wallet) => {
          const firstBet = `bet-${wallet.id}-0`;
          await queues.send(
            message(
              wallet,
              { externalTransactionId: `win-${wallet.id}`, kind: 'WIN', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: firstBet },
              randomUUID(),
            ),
            wallet.id,
          );
          for (let index = 0; index < BETS_PER_WALLET; index += 1) {
            const body = message(wallet, { externalTransactionId: `bet-${wallet.id}-${index}`, money: { amount: '1.00', currency: 'BRL' } }, randomUUID());
            await queues.send(body, wallet.id);
            await queues.send(body, wallet.id);
          }
        }),
      );

      const expected = WALLETS * (BETS_PER_WALLET + 1);
      const recorded = () => countOf(`wager_transactions where kind <> 'OPENING' and wallet_id in (?)`, [wallets.map((wallet) => wallet.id)]);
      await eventually(async () => expect(await recorded()).toBeGreaterThanOrEqual(expected / 5), 60_000, 50);
      const victim = running()[1]!;
      await victim.kill();
      const recordedAtKill = await recorded();
      await start('instance-4');
      await sending;

      await eventually(
        async () => {
          expect(await queues.countMain()).toBe(0);
          expect(
            await countOf(`wager_transactions where status <> 'PROCESSED' and wallet_id in (?)`, [wallets.map((wallet) => wallet.id)]),
          ).toBe(0);
          expect(await recorded()).toBe(expected);
        },
        120_000,
        500,
      );

      for (const wallet of wallets) {
        expect((await walletRow(wallet.id)).balance).toBe('965.00');
        expect(await countOf(`wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(1 + BETS_PER_WALLET + 1);
      }
      expect(await countOf('inbox_messages')).toBe(expected);
      expect(await queues.readDlq()).toEqual([]);
      expect(victim.process.exitCode).not.toBe(0);
      expect(recordedAtKill).toBeLessThan(expected);
      const consumedBy = await Promise.all(
        running().map(async (instance) => {
          const metrics = await (await fetch(`${instance.url}/metrics`)).text();
          return [instance.name, (sampleValue(metrics, 'wagering_messages_total{outcome="processed",failure_code=""}') ?? 0)] as const;
        }),
      );
      expect(consumedBy.filter(([name, processed]) => name !== 'instance-4' && processed > 0)).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  it(
    'events: the outbox written by all instances is published completely, each event once',
    async () => {
      await eventually(async () => expect(await countOf('outbox_messages where published_at is null')).toBe(0), 60_000, 200);

      const ids: string[] = [];
      await eventually(
        async () => {
          ids.push(...(await queues.drainEvents()).map((event) => event.MessageAttributes!.eventId!.StringValue!));
          expect(ids.length).toBe(await countOf('outbox_messages'));
        },
        60_000,
        200,
      );
      expect(new Set(ids).size).toBe(ids.length);
    },
    TIMEOUT_MS,
  );

  it(
    'restart: after every instance crashes, a fresh one starts on the same state and finds nothing left to do',
    async () => {
      const before = await db.execute('select id, balance::text, version from wallets order by id');
      const transactions = await countOf('wager_transactions');
      await Promise.all(running().map((instance) => instance.kill()));

      const fresh = await start('instance-5');
      await Bun.sleep(2_000);

      expect(await db.execute('select id, balance::text, version from wallets order by id')).toEqual(before);
      expect(await countOf('wager_transactions')).toBe(transactions);
      expect(await countOf('outbox_messages where published_at is null')).toBe(0);
      const response = await submit(fresh, transaction(await createWallet('10.00', fresh)));
      expect(response.status).toBe(200);
    },
    TIMEOUT_MS,
  );
});

itKeepsEveryBalanceEqualToItsLedger(() => db);
