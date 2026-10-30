import { describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConnectionException, DeadlockException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { IdempotencyConflictError } from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { WalletNotFoundError } from '../../../src/application/wallet/wallet-queries';
import { DomainError } from '../../../src/domain/shared/domain-error';
import { InvalidMoneyError } from '../../../src/domain/shared/money';
import { InvalidTransactionStateError } from '../../../src/domain/wagering/wager-transaction';
import { WalletConcurrentModificationError } from '../../../src/domain/wallet/wallet-repository';
import { ProviderForbiddenError, UnauthenticatedError } from '../../../src/http/auth/request-authenticator';
import { toErrorResponse } from '../../../src/http/http-error.filter';
import { RequestValidationError } from '../../../src/http/request-validation';
import { isTransientDatabaseError } from '../../../src/infrastructure/database/transient-error';

const withCode = (code: string) => Object.assign(new Error('driver error'), { code });

describe('toErrorResponse', () => {
  it('maps request validation errors to 400 with the issues', () => {
    const issues = [{ path: 'body.playerId', message: 'Required' }];
    expect(toErrorResponse(new RequestValidationError(issues))).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      retryable: false,
      details: issues,
    });
  });

  it.each<[string, DomainError, number]>([
    ['invalid money', new InvalidMoneyError('bad'), 400],
    ['not found', new WalletNotFoundError('w-1'), 404],
    ['idempotency conflict', new IdempotencyConflictError('p', 'k', 't'), 409],
    ['missing credentials', new UnauthenticatedError(), 401],
    ['another provider', new ProviderForbiddenError('client-a', 'provider-b'), 403],
  ])('maps %s to its status', (_, error, status) => {
    expect(toErrorResponse(error)).toMatchObject({ status, code: error.code, retryable: false });
  });

  it('maps a concurrent modification to a retryable 503', () => {
    expect(toErrorResponse(new WalletConcurrentModificationError('w-1', 1))).toMatchObject({
      status: 503,
      code: 'WALLET_CONCURRENT_MODIFICATION',
      retryable: true,
    });
  });

  it('treats an unmapped domain error as an internal error, without leaking its message', () => {
    expect(toErrorResponse(new InvalidTransactionStateError('secret detail'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal error',
      retryable: false,
    });
  });

  it('keeps the status of framework HTTP exceptions', () => {
    expect(toErrorResponse(new NotFoundException('Cannot GET /x'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(toErrorResponse(new BadRequestException('bad json'))).toMatchObject({ status: 400, code: 'MALFORMED_REQUEST' });
  });

  it('maps transient database failures to a retryable 503', () => {
    expect(toErrorResponse(new ConnectionException(new Error('connection refused')))).toEqual({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Temporarily unavailable, retry later',
      retryable: true,
    });
  });

  it('maps any other error to 500', () => {
    expect(toErrorResponse(new Error('boom'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(toErrorResponse('not even an error')).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});

describe('isTransientDatabaseError', () => {
  it('recognizes connection, deadlock and lock timeout failures', () => {
    expect(isTransientDatabaseError(new ConnectionException(new Error('x')))).toBe(true);
    expect(isTransientDatabaseError(new DeadlockException(new Error('x')))).toBe(true);
  });

  it.each(['40001', '40P01', '55P03', '53300', '57P01', '08006', 'ECONNREFUSED', 'ETIMEDOUT'])(
    'recognizes code %s',
    (code) => {
      expect(isTransientDatabaseError(withCode(code))).toBe(true);
    },
  );

  it('does not treat constraint violations or bugs as transient', () => {
    expect(isTransientDatabaseError(new UniqueConstraintViolationException(new Error('x')))).toBe(false);
    expect(isTransientDatabaseError(withCode('23505'))).toBe(false);
    expect(isTransientDatabaseError(new TypeError('x'))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});
