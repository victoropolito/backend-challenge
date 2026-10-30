import { EntitySchema } from '@mikro-orm/core';

/** Linha da tabela `wallet_ledger_entries`; `sequence` é gerado pelo banco. */
export interface WalletLedgerEntryRecord {
  id: string;
  sequence?: bigint;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    sequence: { type: 'bigint', persist: false },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime', columnType: 'timestamptz(3)' },
  },
});
