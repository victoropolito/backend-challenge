import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import { WalletConcurrentModificationError } from '../../domain/wallet/wallet-repository';

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const TRANSIENT_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Indica se o erro do banco é passageiro (conexão, lock, deadlock): repetir a operação pode dar certo. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') {
    return false;
  }
  return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_ERRNOS.has(code);
}

export type LockConflictReason = 'wallet_version' | 'deadlock' | 'lock_timeout' | 'serialization';

/** Motivo do conflito de lock ou de concorrência que desfez a transação; undefined para outros erros. */
export function lockConflictReason(error: unknown): LockConflictReason | undefined {
  if (error instanceof WalletConcurrentModificationError) {
    return 'wallet_version';
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof DeadlockException || code === '40P01') {
    return 'deadlock';
  }
  if (error instanceof LockWaitTimeoutException || code === '55P03') {
    return 'lock_timeout';
  }
  if (code === '40001') {
    return 'serialization';
  }
  return undefined;
}
