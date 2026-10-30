import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../../src/config/app-config';

export interface TestQueues {
  readonly sqs: SQSClient;
  readonly queueName: string;
  readonly dlqName: string;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly eventsQueueName: string;
  readonly eventsUrl: string;
  /** Publica um corpo na fila principal, com deduplicação explícita (cada chamada é uma mensagem nova). */
  send(body: unknown, groupId: string): Promise<void>;
  /** Mensagens visíveis + em processamento + atrasadas na fila principal. */
  countMain(): Promise<number>;
  /** Lê (sem apagar) as mensagens da DLQ com os atributos. */
  readDlq(): Promise<Message[]>;
  /** Consome (lê e apaga) todas as mensagens disponíveis na fila de eventos. */
  drainEvents(): Promise<Message[]>;
  delete(): Promise<void>;
}

export const MAX_RECEIVE_COUNT = 5;

/** Cria filas FIFO descartáveis no LocalStack: transações + DLQ (RedrivePolicy como a do ambiente) e eventos. */
export async function createTestQueues(): Promise<TestQueues> {
  const config = loadConfig(process.env);
  const sqs = new SQSClient({
    region: config.aws.region,
    ...(config.aws.endpoint !== undefined && { endpoint: config.aws.endpoint }),
    ...(config.aws.credentials !== undefined && { credentials: config.aws.credentials }),
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const queueName = `wager-test-${suffix}.fifo`;
  const dlqName = `wager-test-${suffix}-dlq.fifo`;
  const eventsQueueName = `wager-test-${suffix}-events.fifo`;

  const { QueueUrl: dlqUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const { QueueUrl: queueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
      },
    }),
  );

  const { QueueUrl: eventsUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );

  return {
    sqs,
    queueName,
    dlqName,
    queueUrl: queueUrl!,
    dlqUrl: dlqUrl!,
    eventsQueueName,
    eventsUrl: eventsUrl!,
    async send(body, groupId) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: randomUUID(),
        }),
      );
    },
    async countMain() {
      const { Attributes: counts } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
        }),
      );
      return Object.values(counts ?? {}).reduce((total, value) => total + Number(value), 0);
    },
    async readDlq() {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
          MessageAttributeNames: ['All'],
        }),
      );
      return Messages ?? [];
    },
    async drainEvents() {
      const drained: Message[] = [];
      for (;;) {
        const { Messages } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['MessageGroupId'],
          }),
        );
        if (!Messages?.length) {
          return drained;
        }
        drained.push(...Messages);
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: eventsUrl,
            Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle! })),
          }),
        );
      }
    },
    async delete() {
      await Promise.allSettled([
        sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })),
        sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })),
        sqs.send(new DeleteQueueCommand({ QueueUrl: eventsUrl })),
      ]);
      sqs.destroy();
    },
  };
}

/** Repete `check` até ele passar (sem lançar) ou o prazo acabar. */
export async function eventually(check: () => Promise<void> | void, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await Bun.sleep(intervalMs);
    }
  }
}
