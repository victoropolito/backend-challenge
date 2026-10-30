import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/messaging/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

export interface SqsEventPublisherOptions {
  queueName: string;
  /** Limite de cada chamada ao SQS; a transação da outbox fica aberta enquanto a publicação não termina. */
  timeoutMs: number;
}

/**
 * Publica eventos na fila FIFO de eventos: corpo = envelope do evento, `MessageGroupId` = agregado,
 * `MessageDeduplicationId` = id do evento (o SQS descarta republicações em 5 min; depois disso o consumidor deduplica
 * pelo `eventId`).
 */
export class SqsEventPublisher extends EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SqsEventPublisherOptions,
  ) {
    super();
  }

  async publish(messages: readonly OutboxMessage[]): Promise<Map<string, string>> {
    const queueUrl = await this.resolveQueueUrl();
    const failures = new Map<string, string>();
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventId: { DataType: 'String', StringValue: message.id },
            },
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.options.timeoutMs) },
      );
      for (const failed of result.Failed ?? []) {
        const message = chunk[Number(failed.Id)];
        if (message !== undefined) {
          failures.set(message.id, `${failed.Code ?? 'UNKNOWN'}: ${failed.Message ?? ''}`.trim());
        }
      }
    }
    return failures;
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.queueName }), {
        abortSignal: AbortSignal.timeout(this.options.timeoutMs),
      });
      this.queueUrl = QueueUrl!;
    }
    return this.queueUrl;
  }
}
