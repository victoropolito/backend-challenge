import { deepFreeze } from '../shared/deep-freeze';
import { DomainError } from '../shared/domain-error';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export class InvalidIntegrationEventError extends DomainError {
  readonly code = 'INVALID_INTEGRATION_EVENT';
}

/** Envelope base dos eventos de integração publicados via outbox; cada evento concreto fixa `eventType` e `version`. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const field of ['eventId', 'aggregateId', 'correlationId'] as const) {
      if (props[field].trim() === '') {
        throw new InvalidIntegrationEventError(`${field} must not be empty`);
      }
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = deepFreeze(structuredClone(props.data));
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }
}
