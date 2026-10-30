import { z } from 'zod';
import { isUuid } from '../application/shared/uuid';
import { WagerTransactionKind } from '../domain/wagering/wager-transaction';

/** Schemas de entrada compartilhados pela API HTTP e pelo consumidor SQS. */

export const identifier = z.string().trim().min(1).max(255);

export const uuid = z.string().trim().refine(isUuid, 'must be a UUID');

export const moneyInput = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const WagerTransactionInput = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: identifier,
  walletId: uuid,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: moneyInput,
  referenceExternalTransactionId: identifier.nullish(),
});
