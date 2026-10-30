import { describe, expect, it } from 'bun:test';
import { DeadlockException } from '@mikro-orm/core';
import { InboxPayloadConflictError } from '../../../src/application/wagering/consume-wager-transaction-message.use-case';
import {
  ExternalTransactionIdConflictError,
  IdempotencyConflictError,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { classifyMessageFailure, messageFailureCode } from '../../../src/consumer/message-failure';
import { MalformedMessageError } from '../../../src/consumer/wager-transaction-message';
import { DuplicateInboxMessageError } from '../../../src/domain/messaging/messaging-repositories';
import { InvalidMoneyError } from '../../../src/domain/shared/money';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/wagering/wager-transaction';
import { WalletConcurrentModificationError } from '../../../src/domain/wallet/wallet-repository';

const withCode = (code: string) => Object.assign(new Error('db'), { code });

describe('classifyMessageFailure', () => {
  it.each<[string, unknown]>([
    ['a malformed message', new MalformedMessageError('bad')],
    ['an invalid amount', new InvalidMoneyError('bad')],
    ['an invalid transaction', new InvalidWagerTransactionError('bad')],
    ['an idempotency conflict', new IdempotencyConflictError('p', 'k', 't')],
    ['an external id conflict', new ExternalTransactionIdConflictError('p', 'e', 't')],
    ['an inbox payload conflict', new InboxPayloadConflictError('c', 'm')],
  ])('%s is permanent', (_, error) => {
    expect(classifyMessageFailure(error)).toBe('PERMANENT');
  });

  it.each<[string, unknown]>([
    ['a concurrent wallet modification', new WalletConcurrentModificationError('w', 1)],
    ['a duplicate inbox insert', new DuplicateInboxMessageError('c', 'm')],
    ['a deadlock', new DeadlockException(new Error('deadlock'))],
    ['a lost connection', withCode('ECONNREFUSED')],
    ['a serialization failure', withCode('40001')],
  ])('%s is transient', (_, error) => {
    expect(classifyMessageFailure(error)).toBe('TRANSIENT');
  });

  it.each<[string, unknown]>([
    ['an invalid state transition (bug)', new InvalidTransactionStateError('bad')],
    ['an unexpected constraint violation', withCode('23514')],
    ['a plain error', new Error('boom')],
    ['a non-error value', 'boom'],
  ])('%s is unexpected', (_, error) => {
    expect(classifyMessageFailure(error)).toBe('UNEXPECTED');
  });
});

describe('messageFailureCode', () => {
  it('uses the error code, then the error name', () => {
    expect(messageFailureCode(new IdempotencyConflictError('p', 'k', 't'))).toBe('IDEMPOTENCY_CONFLICT');
    expect(messageFailureCode(new TypeError('x'))).toBe('TypeError');
    expect(messageFailureCode(null)).toBe('UNKNOWN');
  });
});
