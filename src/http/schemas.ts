import { z } from 'zod';
import { MAX_LEDGER_PAGE_SIZE } from '../application/wallet/wallet-queries';
import { identifier, moneyInput, uuid, WagerTransactionInput } from '../contracts/wager-transaction-input';

export const CreateWalletBody = z.object({
  playerId: identifier,
  initialBalance: moneyInput,
});

export const SubmitWagerTransactionBody = WagerTransactionInput;

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
