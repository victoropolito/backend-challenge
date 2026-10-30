import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import type { SubmitWagerTransactionUseCase } from '../../../src/application/wagering/submit-wager-transaction.use-case';
import {
  WagerTransactionNotFoundError,
  type WagerTransactionQueries,
} from '../../../src/application/wagering/wager-transaction-queries';
import { Money } from '../../../src/domain/shared/money';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { AuthenticationGuard } from '../../../src/http/auth/authentication.guard';
import {
  AllowAllAuthenticator,
  ANONYMOUS_PRINCIPAL,
  ProviderForbiddenError,
  RequestAuthenticator,
  UnauthenticatedError,
  assertProviderAccess,
  canAccessProvider,
  type Principal,
} from '../../../src/http/auth/request-authenticator';
import { HttpErrorFilter } from '../../../src/http/http-error.filter';
import type { HttpRequest, HttpResponse } from '../../../src/http/http-types';
import { WageringController } from '../../../src/http/wagering.controller';

const providerA: Principal = { subject: 'client-a', providerId: 'provider-a' };

const httpContext = (request: HttpRequest, response?: HttpResponse) =>
  ({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  }) as unknown as ExecutionContext;

const request = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET',
  originalUrl: '/wallets',
  headers,
  correlationId: 'corr-1',
});

/** Aceita só `Authorization: Bearer token-a`, como credencial do provider-a. */
const bearerAuthenticator = new (class extends RequestAuthenticator {
  async authenticate(headers: Readonly<Record<string, string | string[] | undefined>>) {
    return headers.authorization === 'Bearer token-a' ? providerA : undefined;
  }
})();

const transaction = (providerId: string) =>
  WagerTransaction.create({
    id: '01900000-0000-7000-8000-000000000001',
    providerId,
    externalTransactionId: 'ext-1',
    idempotencyKey: `${providerId}:ext-1`,
    payloadHash: 'a'.repeat(64),
    walletId: '01900000-0000-7000-8000-000000000002',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    createdAt: new Date('2026-10-30T12:00:00Z'),
  });

const controller = (stored: WagerTransaction) => {
  const submitted: unknown[] = [];
  const submit = {
    async execute(command: unknown) {
      submitted.push(command);
      return { transaction: stored, idempotentReplay: false };
    },
  } as unknown as SubmitWagerTransactionUseCase;
  const queries = {
    async getById() {
      return stored;
    },
    async getByExternalId() {
      return stored;
    },
  } as unknown as WagerTransactionQueries;
  return { controller: new WageringController(submit, queries), submitted };
};

const body = (providerId: string) => ({
  providerId,
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: '01900000-0000-7000-8000-000000000002',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

const response = { status: () => response } as unknown as HttpResponse;

describe('AllowAllAuthenticator', () => {
  it('accepts any request as the anonymous principal, without provider restriction', async () => {
    expect(await new AllowAllAuthenticator().authenticate()).toEqual({ subject: 'anonymous', providerId: undefined });
  });
});

describe('AuthenticationGuard', () => {
  it('stores the authenticated principal on the request', async () => {
    const req = request({ authorization: 'Bearer token-a' });

    expect(await new AuthenticationGuard(bearerAuthenticator).canActivate(httpContext(req))).toBe(true);
    expect(req.principal).toEqual(providerA);
  });

  it('refuses a request without valid credentials with 401 and WWW-Authenticate', async () => {
    const req = request({ authorization: 'Bearer wrong' });
    const guard = new AuthenticationGuard(bearerAuthenticator);

    const error = await guard.canActivate(httpContext(req)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthenticatedError);

    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const res = {
      headersSent: false,
      status(code: number) {
        sent.status = code;
        return res;
      },
      setHeader(name: string, value: string) {
        sent.headers[name] = value;
      },
      json(value: unknown) {
        sent.body = value;
      },
    } as unknown as HttpResponse;
    new HttpErrorFilter().catch(error, { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as never);

    expect(sent).toMatchObject({
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
      body: { code: 'UNAUTHENTICATED', retryable: false, correlationId: 'corr-1' },
    });
  });
});

describe('provider access', () => {
  it('an unrestricted principal can act for any provider; a provider credential only for its own', () => {
    expect(canAccessProvider(ANONYMOUS_PRINCIPAL, 'provider-b')).toBe(true);
    expect(canAccessProvider(providerA, 'provider-a')).toBe(true);
    expect(canAccessProvider(providerA, 'provider-b')).toBe(false);
    expect(() => assertProviderAccess(providerA, 'provider-a')).not.toThrow();
    expect(() => assertProviderAccess(providerA, 'provider-b')).toThrow(ProviderForbiddenError);
  });

  it('refuses a submission for another provider before running the use case', async () => {
    const { controller: wagering, submitted } = controller(transaction('provider-b'));

    await expect(wagering.submit(body('provider-b'), 'key-1', 'corr-1', providerA, response)).rejects.toBeInstanceOf(
      ProviderForbiddenError,
    );
    expect(submitted).toEqual([]);

    await wagering.submit(body('provider-a'), 'key-1', 'corr-1', providerA, response);
    expect(submitted).toHaveLength(1);
  });

  it('hides transactions of another provider in the queries', async () => {
    const { controller: wagering } = controller(transaction('provider-b'));
    const params = { transactionId: '01900000-0000-7000-8000-000000000001' };

    await expect(wagering.getById(params, providerA)).rejects.toBeInstanceOf(WagerTransactionNotFoundError);
    await expect(
      wagering.getByExternalId({ providerId: 'provider-b', externalTransactionId: 'ext-1' }, providerA),
    ).rejects.toBeInstanceOf(ProviderForbiddenError);
    expect(await wagering.getById(params, ANONYMOUS_PRINCIPAL)).toMatchObject({ providerId: 'provider-b' });
  });
});
