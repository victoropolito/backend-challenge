/** Códigos estáveis e legíveis por máquina que explicam por que uma transação terminou REJECTED ou FAILED. */
export enum FailureCode {
  /** BET maior que o saldo disponível. */
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  /** Reversão (ROLLBACK de WIN/REFUND) que deixaria o saldo negativo. */
  ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
  /** Moeda da transação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet informada não existe. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Wallet informada não pertence ao playerId informado. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Transação referenciada não apareceu dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo da referência não permitido para esta operação. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência existe mas não está PROCESSED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência já revertida por uma operação do mesmo tipo. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Erro permanente de infraestrutura ao processar a transação. */
  ProcessingError = 'PROCESSING_ERROR',
}
