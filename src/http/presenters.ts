import type { SubmitWagerTransactionResult } from '../application/wagering/submit-wager-transaction.use-case';
import type { LedgerPage } from '../application/wallet/wallet-queries';
import type { MoneyProps } from '../domain/shared/money';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

export function walletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function ledgerPageResponse(page: LedgerPage) {
  return { items: page.entries.map(ledgerEntryResponse), nextCursor: page.nextCursor ?? null };
}

function ledgerEntryResponse(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionResponse(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: balanceOf(transaction),
    referenceCheckAttempts: transaction.referenceCheckAttempts,
    nextReferenceCheckAt: transaction.nextReferenceCheckAt?.toISOString() ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  };
}

export function submissionResponse({ transaction, idempotentReplay }: SubmitWagerTransactionResult) {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: balanceOf(transaction),
    idempotentReplay,
  };
}

/** Status HTTP da submissão pelo desfecho da transação; um replay recebe o mesmo status da resposta original. */
export function submissionStatus(transaction: WagerTransaction): number {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 500;
  }
}

function balanceOf(transaction: WagerTransaction): MoneyProps | null {
  return transaction.observedBalance?.toJSON() ?? null;
}
