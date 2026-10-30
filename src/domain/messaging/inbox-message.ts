import { DomainError } from '../shared/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

export class InvalidInboxStateError extends DomainError {
  readonly code = 'INVALID_INBOX_STATE';
}

/** Registro de uma mensagem recebida por um consumidor, identificada por (consumerName, messageId), para deduplicação. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ['messageId', 'consumerName', 'payloadHash'] as const) {
      if (props[field].trim() === '') {
        throw new InvalidInboxStateError(`${field} must not be empty`);
      }
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt), undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt && new Date(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxStateError(`Inbox message ${this.consumerName}/${this.messageId} is already processed`);
    }
    this._processedAt = new Date(at);
  }
}
