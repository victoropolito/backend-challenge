import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Clock } from '../application/shared/clock';
import type { ConsumeWagerTransactionMessageUseCase } from '../application/wagering/consume-wager-transaction-message.use-case';
import { exponentialBackoffDelayMs, type BackoffPolicy } from '../domain/shared/backoff';
import { addLogContext, withLogContext } from '../infrastructure/observability/log-context';
import type { AppLogger } from '../infrastructure/observability/structured-logger';
import { classifyMessageFailure, messageFailureCode, type MessageFailureKind } from './message-failure';
import { parseWagerTransactionMessage } from './wager-transaction-message';

export interface SqsWagerTransactionConsumerOptions {
  queueUrl: string;
  deadLetterQueueUrl: string;
  waitTimeSeconds: number;
  batchSize: number;
  visibilityTimeoutSeconds: number;
  /** Entregas (ApproximateReceiveCount) aceitas antes de mandar uma mensagem com falha transitória para a DLQ. */
  maxAttempts: number;
  retryPolicy: BackoffPolicy;
  shutdownTimeoutMs: number;
}

export interface SqsWagerTransactionConsumerDependencies {
  sqs: SQSClient;
  handler: Pick<ConsumeWagerTransactionMessageUseCase, 'execute'>;
  clock: Clock;
  logger: AppLogger;
  options: SqsWagerTransactionConsumerOptions;
}

type Outcome =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number; error: unknown }
  | { action: 'dead-letter'; kind: MessageFailureKind; error: unknown };

const RECEIVE_ERROR_PAUSE_MS = 1_000;
const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * Consome a fila FIFO de transações: processa grupos em paralelo e as mensagens de um grupo em ordem, confirma só
 * depois do commit, repete falhas transitórias com backoff (visibilidade) e manda falhas permanentes ou esgotadas
 * para a DLQ. No shutdown para de receber, conclui o que está em andamento e devolve a visibilidade do resto.
 */
export class SqsWagerTransactionConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Map<string, Message>();
  private readonly abandoned = new Set<string>();
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: SqsWagerTransactionConsumerDependencies) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /** Para de receber, espera as mensagens em andamento até o timeout e devolve a visibilidade das que sobrarem. */
  async stop(): Promise<void> {
    if (!this.running) {
      await this.loop;
      return;
    }
    this.running = false;
    this.wakeUp?.();
    this.deps.logger.info('Stopping', { inFlight: this.inFlight.size });
    const finished = await settlesWithin(this.loop!, this.deps.options.shutdownTimeoutMs);
    if (!finished) {
      const pending = [...this.inFlight.values()];
      this.deps.logger.warn('Shutdown timeout reached; releasing in-flight messages', { released: pending.length });
      for (const message of pending) {
        this.abandoned.add(message.ReceiptHandle!);
      }
      await Promise.all(pending.map((message) => this.release(message)));
      return;
    }
    this.deps.logger.info('Stopped: messages in progress were finished');
  }

  private async run(): Promise<void> {
    while (this.running) {
      const messages = await this.receive();
      if (messages.length > 0) {
        await this.processBatch(messages);
      }
    }
  }

  private async receive(): Promise<Message[]> {
    const { sqs, options, logger } = this.deps;
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: options.batchSize,
          WaitTimeSeconds: options.waitTimeSeconds,
          VisibilityTimeout: options.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      return response.Messages ?? [];
    } catch (error) {
      logger.warn('Receive failed', { queueUrl: options.queueUrl, reason: describeError(error) });
      await this.pause(RECEIVE_ERROR_PAUSE_MS);
      return [];
    }
  }

  /** Grupos em paralelo; dentro de um grupo, em ordem, parando no primeiro que precisar ser repetido. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      if (!this.running) {
        await Promise.all(messages.slice(index).map((rest) => this.release(rest)));
        return;
      }
      const outcome = await withLogContext(
        { sqsMessageId: message.MessageId, receiveCount: receiveCount(message) },
        async () => {
          const decided = await this.track(message, () => this.process(message));
          await this.settle(message, decided);
          return decided;
        },
      );
      if (outcome.action === 'retry') {
        await Promise.all(messages.slice(index + 1).map((rest) => this.release(rest)));
        return;
      }
    }
  }

  private async track<T>(message: Message, work: () => Promise<T>): Promise<T> {
    this.inFlight.set(message.ReceiptHandle!, message);
    try {
      return await work();
    } finally {
      this.inFlight.delete(message.ReceiptHandle!);
    }
  }

  private async process(message: Message): Promise<Outcome> {
    const { handler, clock, options } = this.deps;
    const attempt = receiveCount(message);
    try {
      const parsed = parseWagerTransactionMessage(message.Body ?? '', clock.now());
      addLogContext({
        messageId: parsed.messageId,
        correlationId: parsed.command.correlationId,
        providerId: parsed.command.providerId,
        walletId: parsed.command.walletId,
        externalTransactionId: parsed.command.externalTransactionId,
      });
      await handler.execute(parsed);
      return { action: 'ack' };
    } catch (error) {
      const kind = classifyMessageFailure(error);
      if (kind === 'PERMANENT' || attempt >= options.maxAttempts) {
        return { action: 'dead-letter', kind, error };
      }
      const delayMs = exponentialBackoffDelayMs(attempt, options.retryPolicy);
      return { action: 'retry', delaySeconds: Math.ceil(delayMs / 1_000), error };
    }
  }

  /** Executa no SQS a decisão tomada; se o SQS falhar aqui, a mensagem volta sozinha e é reprocessada com segurança. */
  private async settle(message: Message, outcome: Outcome): Promise<void> {
    const { logger } = this.deps;
    if (this.abandoned.delete(message.ReceiptHandle!)) {
      return;
    }
    try {
      switch (outcome.action) {
        case 'ack':
          await this.delete(message);
          logger.debug('Message acknowledged');
          return;
        case 'retry':
          logger.warn('Message failed, will retry', {
            failureCode: messageFailureCode(outcome.error),
            reason: describeError(outcome.error),
            retryInSeconds: outcome.delaySeconds,
          });
          await this.changeVisibility(message, outcome.delaySeconds);
          return;
        case 'dead-letter':
          logDeadLetter(logger, outcome);
          await this.deadLetter(message, outcome);
          return;
      }
    } catch (error) {
      logger.warn('Could not settle message', { action: outcome.action, reason: describeError(error) });
    }
  }

  private async deadLetter(message: Message, outcome: Extract<Outcome, { action: 'dead-letter' }>): Promise<void> {
    const { sqs, options } = this.deps;
    const attribute = (value: string) => ({ DataType: 'String', StringValue: value.slice(0, MAX_ATTRIBUTE_LENGTH) });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: options.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
        MessageDeduplicationId: message.MessageId!,
        MessageAttributes: {
          failureKind: attribute(outcome.kind),
          failureCode: attribute(messageFailureCode(outcome.error)),
          failureMessage: attribute(describeError(outcome.error) || '-'),
          sourceMessageId: attribute(message.MessageId!),
          receiveCount: { DataType: 'Number', StringValue: String(receiveCount(message)) },
        },
      }),
    );
    await this.delete(message);
  }

  private async delete(message: Message): Promise<void> {
    await this.deps.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.deps.options.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.deps.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.deps.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Devolve a mensagem à fila imediatamente, sem processá-la. */
  private async release(message: Message): Promise<void> {
    try {
      await this.changeVisibility(message, 0);
    } catch (error) {
      this.deps.logger.warn('Could not release message', { sqsMessageId: message.MessageId, reason: describeError(error) });
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}

/** true se `promise` terminar antes de `ms`; o timer é cancelado para não segurar o processo vivo. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function receiveCount(message: Message): number {
  const count = Number(message.Attributes?.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${messageFailureCode(error)}: ${error.message || error.name}`;
  }
  return String(error);
}

/** Falha permanente é aviso (problema da mensagem); tentativas esgotadas são erro, com a stack. */
function logDeadLetter(logger: AppLogger, outcome: { kind: MessageFailureKind; error: unknown }): void {
  const fields = { failureKind: outcome.kind, failureCode: messageFailureCode(outcome.error), reason: describeError(outcome.error) };
  if (outcome.kind === 'PERMANENT') {
    logger.warn('Message sent to the DLQ', fields);
  } else {
    logger.error('Message sent to the DLQ', fields, outcome.error);
  }
}
