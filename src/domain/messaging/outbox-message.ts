import type { IntegrationEvent } from '../events/integration-event';
import { exponentialBackoffDelayMs, type BackoffPolicy } from '../shared/backoff';
import { deepFreeze } from '../shared/deep-freeze';
import { DomainError } from '../shared/domain-error';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export const DEFAULT_OUTBOX_RETRY_POLICY: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };

export class InvalidOutboxStateError extends DomainError {
  readonly code = 'INVALID_OUTBOX_STATE';
}

/** Evento de integração gravado na mesma transação SQL da mudança de estado, aguardando publicação. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** Enfileira o evento usando o `eventId` como id da mensagem, para o consumidor deduplicar republicações. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze({ ...event.toJSON() }),
      new Date(event.occurredAt),
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt && new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt && new Date(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Incrementa `attempts` e agenda a próxima tentativa com backoff exponencial; não há limite de tentativas. */
  scheduleRetry(now: Date, policy: BackoffPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + exponentialBackoffDelayMs(this._attempts, policy));
  }

  private assertPending(operation: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(`Cannot ${operation}: outbox message ${this.id} is already published`);
    }
  }
}
