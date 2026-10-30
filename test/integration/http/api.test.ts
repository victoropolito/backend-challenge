import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createHttpApp } from '../../../src/http/create-http-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalConsumerEnabled = process.env.SQS_CONSUMER_ENABLED;
const originalPublisherEnabled = process.env.OUTBOX_PUBLISHER_ENABLED;
const originalReferenceWorkerEnabled = process.env.REFERENCE_WORKER_ENABLED;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.REFERENCE_WORKER_ENABLED = 'false';
  app = await createHttpApp({ logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
}, 30_000);

afterAll(async () => {
  await app?.close();
  process.env.DATABASE_URL = originalDatabaseUrl;
  for (const [key, value] of [
    ['SQS_CONSUMER_ENABLED', originalConsumerEnabled],
    ['OUTBOX_PUBLISHER_ENABLED', originalPublisherEnabled],
    ['REFERENCE_WORKER_ENABLED', originalReferenceWorkerEnabled],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await db?.drop();
});

interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) } as ApiResponse;
};

const createWallet = async (amount = '100.00', playerId = randomUUID()) => {
  const response = await request('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
};

const transactionBody = (wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...overrides,
});

const submit = (body: Record<string, unknown>, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) =>
  request('POST', '/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });

const expectError = (response: ApiResponse, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({ code, retryable: false });
  expect(typeof response.body.message).toBe('string');
  expect(response.body.correlationId).toBe(response.headers.get('x-correlation-id'));
};

describe('correlation id', () => {
  it('echoes a well-formed X-Correlation-Id', async () => {
    const response = await request('GET', '/health/live', undefined, { 'X-Correlation-Id': 'abc-123' });
    expect(response.headers.get('x-correlation-id')).toBe('abc-123');
  });

  it('generates one when absent or malformed', async () => {
    const absent = await request('GET', '/health/live');
    const malformed = await request('GET', '/health/live', undefined, { 'X-Correlation-Id': 'has spaces' });
    expect(absent.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(malformed.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is propagated to the events of the request', async () => {
    const wallet = await createWallet();
    const body = transactionBody(wallet);
    await request('POST', '/wagering/transactions', body, {
      'Idempotency-Key': `k-${body.externalTransactionId}`,
      'X-Correlation-Id': 'corr-events',
    });
    const [row] = await db.execute<{ count: number }>(
      `select count(*)::int as count from outbox_messages where payload->>'correlationId' = 'corr-events'`,
    );
    expect(row!.count).toBe(2);
  });
});

describe('POST /wallets', () => {
  it('creates the wallet with its opening balance', async () => {
    const playerId = randomUUID();
    const response = await request('POST', '/wallets', { playerId, initialBalance: { amount: '1000', currency: 'BRL' } });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second wallet for the same player and currency with 409', async () => {
    const wallet = await createWallet();
    const response = await request('POST', '/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expectError(response, 409, 'WALLET_ALREADY_EXISTS');
  });

  it('answers 400 with the invalid fields', async () => {
    const response = await request('POST', '/wallets', { initialBalance: { amount: 10, currency: 'BRL' } });
    expectError(response, 400, 'VALIDATION_ERROR');
    expect(response.body.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'body.initialBalance.amount',
      'body.playerId',
    ]);
  });

  it.each([
    ['more than 2 decimal places', '10.001', 'BRL'],
    ['a negative amount', '-1.00', 'BRL'],
    ['an invalid currency', '10.00', 'brl'],
  ])('answers 400 INVALID_MONEY for %s', async (_, amount, currency) => {
    const response = await request('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency } });
    expectError(response, 400, 'INVALID_MONEY');
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the wallet', async () => {
    const wallet = await createWallet('50.00');
    const response = await request('GET', `/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: wallet.id, balance: { amount: '50.00', currency: 'BRL' }, version: 1 });
  });

  it('answers 404 for an unknown wallet and 400 for a malformed id', async () => {
    expectError(await request('GET', `/wallets/${randomUUID()}`), 404, 'WALLET_NOT_FOUND');
    expectError(await request('GET', '/wallets/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages through every entry in order with an opaque cursor', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 4; i += 1) {
      expect((await submit(transactionBody(wallet, { money: { amount: '10.00', currency: 'BRL' } }))).status).toBe(200);
    }

    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await request('GET', `/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(200);
      pages.push(response.body);
      cursor = response.body.nextCursor;
    } while (cursor !== null);

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    const balances = pages.flatMap((page) => page.items.map((item: any) => item.balanceAfter.amount));
    expect(balances).toEqual(['100.00', '90.00', '80.00', '70.00', '60.00']);
    expect(pages[0].items[0]).toMatchObject({ direction: 'CREDIT', balanceBefore: { amount: '0.00', currency: 'BRL' } });
  });

  it('returns an empty last page when the wallet has no entries', async () => {
    const wallet = await createWallet('0');
    const response = await request('GET', `/wallets/${wallet.id}/ledger`);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('rejects malformed cursors, cursors of another wallet and out-of-range limits', async () => {
    const wallet = await createWallet('100.00');
    const other = await createWallet('100.00');
    await submit(transactionBody(other));
    const { nextCursor } = (await request('GET', `/wallets/${other.id}/ledger?limit=1`)).body;

    expectError(await request('GET', `/wallets/${wallet.id}/ledger?cursor=garbage`), 400, 'INVALID_CURSOR');
    expectError(await request('GET', `/wallets/${wallet.id}/ledger?cursor=${nextCursor}`), 400, 'INVALID_CURSOR');
    expectError(await request('GET', `/wallets/${wallet.id}/ledger?limit=0`), 400, 'VALIDATION_ERROR');
    expectError(await request('GET', `/wallets/${wallet.id}/ledger?limit=201`), 400, 'VALIDATION_ERROR');
    expectError(await request('GET', `/wallets/${randomUUID()}/ledger`), 404, 'WALLET_NOT_FOUND');
  });
});

describe('POST /wagering/transactions', () => {
  it('answers 200 for a processed transaction, and the same response as a replay', async () => {
    const wallet = await createWallet('1000.00');
    const body = transactionBody(wallet);

    const first = await submit(body);
    const replay = await submit(body);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('answers 422 for a business rejection, also on replay', async () => {
    const wallet = await createWallet('10.00');
    const body = transactionBody(wallet, { money: { amount: '10.01', currency: 'BRL' } });

    const first = await submit(body);
    const replay = await submit(body);

    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('answers 202 when the reference has not arrived yet', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(
      transactionBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-not-received' }),
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null, balance: null });
  });

  it('answers 409 for the same key with a different payload', async () => {
    const wallet = await createWallet('100.00');
    const body = transactionBody(wallet);
    await submit(body);

    const conflict = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });

    expectError(conflict, 409, 'IDEMPOTENCY_CONFLICT');
  });

  it('answers 409 for an external id already submitted under another key', async () => {
    const wallet = await createWallet('100.00');
    const body = transactionBody(wallet);
    await submit(body);
    expectError(await submit(body, 'another-key'), 409, 'EXTERNAL_TRANSACTION_ID_CONFLICT');
  });

  it('requires the Idempotency-Key header', async () => {
    const wallet = await createWallet('100.00');
    const response = await request('POST', '/wagering/transactions', transactionBody(wallet));
    expectError(response, 400, 'VALIDATION_ERROR');
    expect(response.body.details).toEqual([{ path: 'headers.idempotency-key', message: expect.any(String) }]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an OPENING', { kind: 'OPENING' }, 'VALIDATION_ERROR'],
    ['an unknown kind', { kind: 'JACKPOT' }, 'VALIDATION_ERROR'],
    ['a walletId that is not a UUID', { walletId: 'wallet-1' }, 'VALIDATION_ERROR'],
    ['a blank roundId', { roundId: '   ' }, 'VALIDATION_ERROR'],
    ['a numeric amount', { money: { amount: 25, currency: 'BRL' } }, 'VALIDATION_ERROR'],
    ['an amount with 3 decimal places', { money: { amount: '25.001', currency: 'BRL' } }, 'INVALID_MONEY'],
    ['a REFUND without reference', { kind: 'REFUND' }, 'INVALID_WAGER_TRANSACTION'],
    ['a BET with a reference', { referenceExternalTransactionId: 'x' }, 'INVALID_WAGER_TRANSACTION'],
    ['the reserved internal provider', { providerId: 'internal' }, 'INVALID_WAGER_TRANSACTION'],
  ])('answers 400 for %s, writing nothing', async (_, overrides, code) => {
    const wallet = await createWallet('100.00');
    const body = transactionBody(wallet, overrides);
    expectError(await submit(body), 400, code);
    const [row] = await db.execute<{ count: number }>(
      'select count(*)::int as count from wager_transactions where external_transaction_id = ?',
      [body.externalTransactionId],
    );
    expect(row!.count).toBe(0);
  });

  it('trims identifiers before storing and hashing them', async () => {
    const wallet = await createWallet('100.00');
    const body = transactionBody(wallet);
    const padded = {
      ...body,
      providerId: ` ${body.providerId} `,
      externalTransactionId: `\t${body.externalTransactionId}\n`,
      playerId: `  ${body.playerId}`,
      walletId: `${body.walletId} `,
      roundId: `${body.roundId}  `,
      gameId: ` ${body.gameId}`,
    };

    const first = await submit(padded, `${body.providerId}:${body.externalTransactionId}`);
    const replay = await submit(body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    const stored = await request('GET', `/wagering/transactions/${first.body.transactionId}`);
    expect(stored.body).toMatchObject({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
    });
  });

  it('answers 400 for malformed JSON', async () => {
    const response = await request('POST', '/wagering/transactions', '{"providerId":', { 'Idempotency-Key': 'k' });
    expectError(response, 400, 'MALFORMED_REQUEST');
  });

  it('two simultaneous 80.00 BETs on 100.00: one 200, one 422', async () => {
    const wallet = await createWallet('100.00');
    const responses = await Promise.all([
      submit(transactionBody(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(transactionBody(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await request('GET', `/wallets/${wallet.id}`)).body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
  });
});

describe('GET transactions', () => {
  it('finds a transaction by id and by provider + external id', async () => {
    const wallet = await createWallet('100.00');
    const body = transactionBody(wallet);
    const { transactionId } = (await submit(body)).body;

    const byId = await request('GET', `/wagering/transactions/${transactionId}`);
    const byExternalId = await request(
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '75.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
    expect(byExternalId.body).toEqual(byId.body);
  });

  it('answers 404 for unknown transactions and 400 for a malformed id', async () => {
    expectError(await request('GET', `/wagering/transactions/${randomUUID()}`), 404, 'TRANSACTION_NOT_FOUND');
    expectError(await request('GET', '/providers/provider-a/wagering/transactions/unknown'), 404, 'TRANSACTION_NOT_FOUND');
    expectError(await request('GET', '/wagering/transactions/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });
});

describe('errors outside the API', () => {
  it('answers unknown routes with the standard error body', async () => {
    expectError(await request('GET', '/does-not-exist'), 404, 'NOT_FOUND');
  });

  it('keeps the readiness body', async () => {
    const response = await request('GET', '/health/ready');
    expect(response.body.checks.postgres).toEqual({ status: 'up' });
  });
});
