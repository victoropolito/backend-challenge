import { DomainError } from '../shared/domain-error';
import type { InboxMessage } from './inbox-message';
import type { OutboxMessage } from './outbox-message';

export class DuplicateInboxMessageError extends DomainError {
  readonly code = 'DUPLICATE_INBOX_MESSAGE';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Message ${messageId} was already received by ${consumerName}`);
  }
}

/** Persistência da inbox de deduplicação dos consumidores. */
export abstract class InboxRepository {
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;

  /** Lança DuplicateInboxMessageError se (consumerName, messageId) já existir. */
  abstract insert(message: InboxMessage): Promise<void>;

  abstract update(message: InboxMessage): Promise<void>;
}

/** Persistência da outbox de eventos de integração. */
export abstract class OutboxRepository {
  abstract findById(id: string): Promise<OutboxMessage | undefined>;

  abstract insert(message: OutboxMessage): Promise<void>;

  /** Grava tentativas, próxima tentativa e publicação. */
  abstract update(message: OutboxMessage): Promise<void>;
}
