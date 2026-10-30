import { EntitySchema } from '@mikro-orm/core';

/** Linha da tabela `wager_transactions`. */
export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  status: string;
  referenceTransactionId: string | null;
  failureCode: string | null;
  processedAt: Date | null;
  referenceCheckAttempts: number;
  nextReferenceCheckAt: Date | null;
  observedBalance: string | null;
  createdAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    status: { type: 'text' },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    processedAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
    referenceCheckAttempts: { type: 'integer' },
    nextReferenceCheckAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
    observedBalance: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz(3)' },
  },
});
