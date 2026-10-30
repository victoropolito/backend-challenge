const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Formato textual de UUID (qualquer versão), exigido pelas colunas `uuid` do banco. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
