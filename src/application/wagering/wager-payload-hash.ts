import type { Money } from '../../domain/shared/money';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { payloadHash } from '../shared/payload-hash';

export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

/** Hash dos campos de negócio de uma submissão; o valor entra já normalizado pelo Money e a referência ausente como null. */
export function wagerPayloadHash(fields: WagerPayloadFields): string {
  return payloadHash({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { ...fields.money.toJSON() },
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  });
}
