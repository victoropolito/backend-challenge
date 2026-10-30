import { AsyncLocalStorage } from 'node:async_hooks';

export type LogValue = string | number | boolean | null | undefined;

/** Campos estruturados de um log; os identificadores padronizados aparecem com estes nomes em toda a aplicação. */
export interface LogFields {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  [field: string]: LogValue;
}

const storage = new AsyncLocalStorage<LogFields>();

/** Executa `work` com `fields` somados ao contexto corrente; todo log emitido dentro dele carrega esses campos. */
export function withLogContext<T>(fields: LogFields, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, work);
}

/** Acrescenta campos ao contexto aberto pelo `withLogContext` mais próximo (sem efeito fora de um). */
export function addLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store !== undefined) {
    Object.assign(store, fields);
  }
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}
