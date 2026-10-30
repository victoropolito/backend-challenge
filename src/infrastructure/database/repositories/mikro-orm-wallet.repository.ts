import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/shared/money';
import { Wallet } from '../../../domain/wallet/wallet';
import {
  LedgerRepository,
  WalletAlreadyExistsError,
  WalletConcurrentModificationError,
  WalletRepository,
  type LedgerPageItem,
} from '../../../domain/wallet/wallet-repository';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { WalletSchema, type WalletRecord } from '../records/wallet.record';
import { WalletLedgerEntrySchema, type WalletLedgerEntryRecord } from '../records/wallet-ledger-entry.record';
import { violatedUniqueConstraint } from './constraint-violation';

/** WalletRepository sobre MikroORM: leituras sem identity map e escritas nativas com controle de version. */
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return record ? toWallet(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? toWallet(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, toWalletRecord(wallet));
    } catch (error) {
      if (violatedUniqueConstraint(error) === 'wallets_player_currency_key') {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new WalletConcurrentModificationError(wallet.id, expectedVersion);
    }
  }
}

/** LedgerRepository sobre MikroORM; a tabela só aceita INSERT. */
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntrySchema, toLedgerEntryRecord(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      WalletLedgerEntrySchema,
      { transactionId },
      { orderBy: { sequence: 'asc' }, disableIdentityMap: true },
    );
    return records.map(toLedgerEntry);
  }

  async findPageByWallet(walletId: string, after: bigint | undefined, limit: number): Promise<LedgerPageItem[]> {
    const records = await this.em.find(
      WalletLedgerEntrySchema,
      after === undefined ? { walletId } : { walletId, sequence: { $gt: after } },
      { orderBy: { sequence: 'asc' }, limit, disableIdentityMap: true },
    );
    return records.map((record) => ({ entry: toLedgerEntry(record), position: BigInt(record.sequence!) }));
  }
}

function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.rehydrate({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toWalletRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toLedgerEntry(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.rehydrate({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}

function toLedgerEntryRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}
