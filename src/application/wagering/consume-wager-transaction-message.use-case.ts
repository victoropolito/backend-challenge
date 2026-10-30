import { DuplicateInboxMessageError, type InboxRepository } from '../../domain/messaging/messaging-repositories';
import { DomainError } from '../../domain/shared/domain-error';
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
  SubmitWagerTransactionUseCase,
} from './submit-wager-transaction.use-case';

export interface WagerTransactionMessage {
  messageId: string;
  /** Hash do conteúdo da mensagem, usado para detectar o mesmo messageId com outro conteúdo. */
  payloadHash: string;
  receivedAt: Date;
  command: Omit<SubmitWagerTransactionCommand, 'inbox'>;
}

export type ConsumeWagerTransactionMessageResult =
  | { duplicate: true }
  | { duplicate: false; submission: SubmitWagerTransactionResult };

export interface ConsumeWagerTransactionMessageDependencies {
  consumerName: string;
  inbox: InboxRepository;
  submit: SubmitWagerTransactionUseCase;
}

/** O messageId já foi recebido por este consumidor com outro conteúdo. */
export class InboxPayloadConflictError extends DomainError {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Message ${messageId} was already received by ${consumerName} with a different payload`);
  }
}

/**
 * Processa uma mensagem de fila pedindo uma transação de aposta: deduplica pela inbox (consumerName, messageId) e
 * submete pelo mesmo caso de uso da API, que grava a inbox na mesma transação SQL do desfecho.
 */
export class ConsumeWagerTransactionMessageUseCase {
  constructor(private readonly deps: ConsumeWagerTransactionMessageDependencies) {}

  async execute(message: WagerTransactionMessage): Promise<ConsumeWagerTransactionMessageResult> {
    if (await this.alreadyReceived(message)) {
      return { duplicate: true };
    }
    try {
      const submission = await this.deps.submit.execute({
        ...message.command,
        inbox: {
          consumerName: this.deps.consumerName,
          messageId: message.messageId,
          payloadHash: message.payloadHash,
          receivedAt: message.receivedAt,
        },
      });
      return { duplicate: false, submission };
    } catch (error) {
      if (error instanceof DuplicateInboxMessageError && (await this.alreadyReceived(message))) {
        return { duplicate: true };
      }
      throw error;
    }
  }

  private async alreadyReceived(message: WagerTransactionMessage): Promise<boolean> {
    const { consumerName, inbox } = this.deps;
    const previous = await inbox.find(consumerName, message.messageId);
    if (previous === undefined) {
      return false;
    }
    if (!previous.matchesPayload(message.payloadHash)) {
      throw new InboxPayloadConflictError(consumerName, message.messageId);
    }
    return true;
  }
}
