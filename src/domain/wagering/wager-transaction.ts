import { DomainError } from '../shared/domain-error';
import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  referenceCheckAttempts: number;
  nextReferenceCheckAt: Date | undefined;
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const SUBMITTABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const REFERENCE_REQUIRED: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const REFERENCE_FORBIDDEN: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
]);

const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Opening]: new Set(),
  [WagerTransactionKind.Bet]: new Set(),
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/** Transação de aposta recebida de um provider, com ciclo de vida PENDING → (PENDING_REFERENCE) → terminal. */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _referenceCheckAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Cria uma transação submetida por provider, em PENDING; valida campos, valor e exigência de referência. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.has(props.kind)) {
      throw new InvalidWagerTransactionError(`Kind ${props.kind} cannot be submitted`);
    }
    for (const field of [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      if (props[field].trim() === '') {
        throw new InvalidWagerTransactionError(`${field} must not be empty`);
      }
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }

    const zeroAllowed = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!zeroAllowed && props.money.isZero())) {
      throw new InvalidWagerTransactionError(`Invalid amount ${props.money} for ${props.kind}`);
    }

    const reference = props.referenceExternalTransactionId;
    if (REFERENCE_REQUIRED.has(props.kind) && (reference === undefined || reference.trim() === '')) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (REFERENCE_FORBIDDEN.has(props.kind) && reference !== undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} must not have a referenceExternalTransactionId`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('A transaction cannot reference itself');
    }

    return WagerTransaction.newPending(props);
  }

  /** Cria a transação interna OPENING do saldo inicial de uma wallet, já PROCESSED. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`Opening amount must be positive, got ${props.money}`);
    }
    const externalTransactionId = `wallet-opening:${props.walletId}`;
    const transaction = WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: externalTransactionId,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    });
    transaction.markProcessed(undefined, props.at);
    return transaction;
  }

  /** Reconstrução a partir da persistência, sem revalidar regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt && new Date(state.processedAt),
      state.referenceCheckAttempts,
      state.nextReferenceCheckAt && new Date(state.nextReferenceCheckAt),
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  get referenceCheckAttempts(): number {
    return this._referenceCheckAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt && new Date(this._nextReferenceCheckAt);
  }

  /** PENDING | PENDING_REFERENCE → PROCESSED. Exige o id interno da referência quando houver referência. */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (hasReference !== (referenceTransactionId !== undefined)) {
      throw new InvalidTransactionStateError(
        hasReference
          ? `Transaction ${this.id} references ${this.referenceExternalTransactionId} and needs its internal id`
          : `Transaction ${this.id} has no reference to resolve`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
    this._nextReferenceCheckAt = undefined;
  }

  /** PENDING | PENDING_REFERENCE → PENDING_REFERENCE, contando a tentativa e agendando a próxima verificação. */
  markPendingReference(nextCheckAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceCheckAttempts += 1;
    this._nextReferenceCheckAt = new Date(nextCheckAt);
  }

  /** PENDING | PENDING_REFERENCE → REJECTED por regra de negócio. */
  reject(code: FailureCode, referenceTransactionId?: string): void {
    this.assertNotTerminal('reject');
    if (code === FailureCode.ProcessingError) {
      throw new InvalidTransactionStateError(`${code} is not a business rejection`);
    }
    if (referenceTransactionId !== undefined && this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} has no reference to resolve`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._referenceTransactionId = referenceTransactionId;
    this._nextReferenceCheckAt = undefined;
  }

  /** PENDING | PENDING_REFERENCE → FAILED por erro permanente de infraestrutura. */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Verifica se `reference` pode ser a transação referenciada por esta; retorna o motivo da recusa, se houver. */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.id === this.id ||
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].has(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  /** Direção do lançamento no ledger; ROLLBACK inverte a direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
      case WagerTransactionKind.Rollback: {
        if (reference === undefined || !ALLOWED_REFERENCE_KINDS[this.kind].has(reference.kind)) {
          throw new InvalidTransactionStateError('ROLLBACK needs a BET, WIN or REFUND reference to define direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
