import { LockMode, QueryOrder } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import {
  DuplicateInboxMessageError,
  InboxRepository,
  OutboxRepository,
} from '../../../domain/messaging/messaging-repositories';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { InboxMessageSchema, type InboxMessageRecord } from '../records/inbox-message.record';
import { OutboxMessageSchema, type OutboxMessageRecord } from '../records/outbox-message.record';
import { violatedUniqueConstraint } from './constraint-violation';

/** InboxRepository sobre MikroORM. */
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, { disableIdentityMap: true });
    return record ? toInboxMessage(record) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    try {
      await this.em.insert(InboxMessageSchema, {
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      });
    } catch (error) {
      if (violatedUniqueConstraint(error) === 'inbox_messages_pkey') {
        throw new DuplicateInboxMessageError(message.consumerName, message.messageId);
      }
      throw error;
    }
  }

  async update(message: InboxMessage): Promise<void> {
    const affected = await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
    if (affected !== 1) {
      throw new Error(`Inbox message ${message.consumerName}/${message.messageId} does not exist`);
    }
  }
}

/** OutboxRepository sobre MikroORM. */
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageSchema, { id }, { disableIdentityMap: true });
    return record ? toOutboxMessage(record) : undefined;
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        orderBy: { nextAttemptAt: QueryOrder.ASC_NULLS_FIRST, sequence: QueryOrder.ASC },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return records.map(toOutboxMessage);
  }

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
  }

  async update(message: OutboxMessage): Promise<void> {
    const affected = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
    if (affected !== 1) {
      throw new Error(`Outbox message ${message.id} does not exist`);
    }
  }
}

function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}
