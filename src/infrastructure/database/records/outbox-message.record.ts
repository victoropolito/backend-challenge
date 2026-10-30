import { EntitySchema } from '@mikro-orm/core';

/** Linha da tabela `outbox_messages`; `sequence` é gerado pelo banco. */
export interface OutboxMessageRecord {
  id: string;
  sequence?: bigint;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    sequence: { type: 'bigint', persist: false },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz(3)' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
    publishedAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
  },
});
