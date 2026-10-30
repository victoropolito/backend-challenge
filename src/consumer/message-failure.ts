import { isTransientDatabaseError } from '../infrastructure/database/transient-error';

/**
 * - `PERMANENT`: a mensagem nunca vai ser aceita como está (malformada, conflito de idempotência); vai direto para a DLQ.
 * - `TRANSIENT`: falha passageira de infraestrutura ou de concorrência; repetir com backoff.
 * - `UNEXPECTED`: erro não previsto (bug); repetido como transitório, até o limite de tentativas.
 */
export type MessageFailureKind = 'PERMANENT' | 'TRANSIENT' | 'UNEXPECTED';

const PERMANENT_CODES = new Set([
  'MALFORMED_MESSAGE',
  'INVALID_MONEY',
  'INVALID_WAGER_TRANSACTION',
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_TRANSACTION_ID_CONFLICT',
  'INBOX_PAYLOAD_CONFLICT',
]);

const TRANSIENT_CODES = new Set(['WALLET_CONCURRENT_MODIFICATION', 'DUPLICATE_INBOX_MESSAGE']);

/** Classifica a falha do processamento de uma mensagem para decidir entre DLQ e nova tentativa. */
export function classifyMessageFailure(error: unknown): MessageFailureKind {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && PERMANENT_CODES.has(code)) {
    return 'PERMANENT';
  }
  if ((typeof code === 'string' && TRANSIENT_CODES.has(code)) || isTransientDatabaseError(error)) {
    return 'TRANSIENT';
  }
  return 'UNEXPECTED';
}

/** Código curto da falha, para logs e atributos da mensagem na DLQ. */
export function messageFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}
