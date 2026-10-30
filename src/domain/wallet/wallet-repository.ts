import { DomainError } from '../shared/domain-error';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class WalletConcurrentModificationError extends DomainError {
  readonly code = 'WALLET_CONCURRENT_MODIFICATION';

  constructor(
    readonly walletId: string,
    readonly expectedVersion: number,
  ) {
    super(`Wallet ${walletId} is no longer at version ${expectedVersion}`);
  }
}

/** Persistência de wallets. */
export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | undefined>;

  /** Carrega a wallet com lock exclusivo de linha até o fim da transação corrente; exige transação aberta. */
  abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  /** Lança WalletAlreadyExistsError se o player já tiver wallet na moeda. */
  abstract insert(wallet: Wallet): Promise<void>;

  /** Grava saldo/version somente se a version persistida ainda for `expectedVersion`; senão lança WalletConcurrentModificationError. */
  abstract update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

/** Persistência do ledger: somente inserção e leitura. */
export abstract class LedgerRepository {
  abstract insert(entry: WalletLedgerEntry): Promise<void>;

  abstract findByTransactionId(transactionId: string): Promise<WalletLedgerEntry[]>;
}
