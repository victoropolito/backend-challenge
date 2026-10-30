import type { OutboxRepository } from '../../domain/messaging/messaging-repositories';
import { DEFAULT_OUTBOX_RETRY_POLICY } from '../../domain/messaging/outbox-message';
import type { BackoffPolicy } from '../../domain/shared/backoff';
import type { Clock } from '../shared/clock';
import type { TransactionRunner } from '../shared/transaction-runner';
import type { EventPublisher } from './event-publisher';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  /** Mensagens que voltaram para a fila de espera da outbox, com o motivo. */
  failures: Map<string, string>;
}

export interface PublishOutboxDependencies {
  transactions: TransactionRunner;
  outbox: OutboxRepository;
  publisher: EventPublisher;
  clock: Clock;
  retryPolicy?: BackoffPolicy;
}

/**
 * Publica um lote da outbox: trava as mensagens vencidas (puladas por outros publishers), publica, e na mesma transação
 * marca as aceitas como publicadas e agenda nova tentativa para as recusadas. Se o processo morrer antes do commit, as
 * travas caem e outro publisher republica as mesmas mensagens, com o mesmo id.
 */
export class PublishOutboxUseCase {
  constructor(private readonly deps: PublishOutboxDependencies) {}

  async execute(batchSize: number): Promise<PublishOutboxResult> {
    const { transactions, outbox, publisher, clock } = this.deps;
    return transactions.run(async () => {
      const messages = await outbox.claimDue(clock.now(), batchSize);
      if (messages.length === 0) {
        return { claimed: 0, published: 0, failures: new Map() };
      }

      let failures: Map<string, string>;
      try {
        failures = await publisher.publish(messages);
      } catch (error) {
        const reason = error instanceof Error ? error.message || error.name : String(error);
        failures = new Map(messages.map((message) => [message.id, reason]));
      }

      const now = clock.now();
      for (const message of messages) {
        if (failures.has(message.id)) {
          message.scheduleRetry(now, this.deps.retryPolicy ?? DEFAULT_OUTBOX_RETRY_POLICY);
        } else {
          message.markPublished(now);
        }
        await outbox.update(message);
      }
      return { claimed: messages.length, published: messages.length - failures.size, failures };
    });
  }
}
