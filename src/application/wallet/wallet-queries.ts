import { DomainError } from '../../domain/shared/domain-error';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { LedgerRepository, WalletRepository } from '../../domain/wallet/wallet-repository';
import { isUuid } from '../shared/uuid';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
}

export interface LedgerPageRequest {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Cursor opaco da próxima página; ausente quando não há mais lançamentos. */
  nextCursor: string | undefined;
}

export interface WalletQueriesDependencies {
  wallets: WalletRepository;
  ledger: LedgerRepository;
}

/** Consultas de wallets e do ledger, fora de transação e sem lock. */
export class WalletQueries {
  constructor(private readonly deps: WalletQueriesDependencies) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = isUuid(walletId) ? await this.deps.wallets.findById(walletId) : undefined;
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }

  /** Lançamentos em ordem de gravação; o cursor é estável porque o ledger é append-only. */
  async listLedger(walletId: string, request: LedgerPageRequest = {}): Promise<LedgerPage> {
    const limit = request.limit ?? DEFAULT_LEDGER_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE_SIZE) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}, got ${limit}`);
    }
    const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, walletId);
    await this.getWallet(walletId);

    const items = await this.deps.ledger.findPageByWallet(walletId, after, limit + 1);
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((item) => item.entry),
      nextCursor: items.length > limit && last !== undefined ? encodeCursor(walletId, last.position) : undefined,
    };
  }
}

interface CursorPayload {
  w: string;
  p: string;
}

function encodeCursor(walletId: string, position: bigint): string {
  const payload: CursorPayload = { w: walletId, p: position.toString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, walletId: string): bigint {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Cursor is malformed');
  }
  const { w, p } = (payload ?? {}) as Partial<CursorPayload>;
  if (typeof w !== 'string' || typeof p !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(p)) {
    throw new InvalidCursorError('Cursor is malformed');
  }
  if (w !== walletId) {
    throw new InvalidCursorError('Cursor belongs to another wallet');
  }
  return BigInt(p);
}
