import { z } from 'zod';
import { payloadHash, type CanonicalJsonValue } from '../application/shared/payload-hash';
import type { WagerTransactionMessage } from '../application/wagering/consume-wager-transaction-message.use-case';
import { identifier, WagerTransactionInput } from '../contracts/wager-transaction-input';
import { Money } from '../domain/shared/money';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

const MessageSchema = z.object({
  messageId: identifier,
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime({ offset: true }),
  data: WagerTransactionInput.extend({ idempotencyKey: identifier }),
});

export interface MessageIssue {
  path: string;
  message: string;
}

/** Corpo de mensagem que não é um WagerTransactionRequested válido; repetir não muda o resultado. */
export class MalformedMessageError extends Error {
  readonly code = 'MALFORMED_MESSAGE';

  constructor(
    message: string,
    readonly issues: MessageIssue[] = [],
  ) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

/**
 * Converte o corpo de uma mensagem da fila no comando de submissão. O messageId da mensagem identifica a inbox e é
 * usado como correlation id e causation id dos eventos gerados.
 */
export function parseWagerTransactionMessage(body: string, receivedAt: Date): WagerTransactionMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('Message body is not valid JSON');
  }

  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
    throw new MalformedMessageError(
      `Invalid ${WAGER_TRANSACTION_REQUESTED} message: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      issues,
    );
  }

  let hash: string;
  try {
    hash = payloadHash(raw as CanonicalJsonValue);
  } catch (error) {
    throw new MalformedMessageError(`Message body cannot be hashed: ${(error as Error).message}`);
  }

  const { messageId, data } = parsed.data;
  return {
    messageId,
    payloadHash: hash,
    receivedAt,
    command: {
      idempotencyKey: data.idempotencyKey,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: Money.from(data.money),
      referenceExternalTransactionId: data.referenceExternalTransactionId ?? undefined,
      correlationId: messageId,
      causationId: messageId,
    },
  };
}
