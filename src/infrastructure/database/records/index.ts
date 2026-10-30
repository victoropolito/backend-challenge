import { InboxMessageSchema } from './inbox-message.record';
import { OutboxMessageSchema } from './outbox-message.record';
import { WagerTransactionSchema } from './wager-transaction.record';
import { WalletLedgerEntrySchema } from './wallet-ledger-entry.record';
import { WalletSchema } from './wallet.record';

/** Todos os `EntitySchema` registrados no MikroORM. */
export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
