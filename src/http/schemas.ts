import { z } from 'zod';
import { isUuid } from '../application/shared/uuid';
import { MAX_LEDGER_PAGE_SIZE } from '../application/wallet/wallet-queries';
import { WagerTransactionKind } from '../domain/wagering/wager-transaction';

const identifier = z.string().trim().min(1).max(255);

const uuid = z.string().trim().refine(isUuid, 'must be a UUID');

const money = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const CreateWalletBody = z.object({
  playerId: identifier,
  initialBalance: money,
});

export const SubmitWagerTransactionBody = z.object({
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
  money,
  referenceExternalTransactionId: identifier.nullish(),
});

export const IdempotencyKeyHeader = identifier;

export const WalletParams = z.object({ walletId: uuid });

export const TransactionParams = z.object({ transactionId: uuid });

export const ExternalTransactionParams = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
});

export const LedgerQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LEDGER_PAGE_SIZE).optional(),
});
