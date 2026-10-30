import { expect, it } from 'bun:test';
import { walletsDivergingFromLedger, type TestDatabase } from './test-database';

/**
 * Registra, no fim do arquivo, o teste do invariante final: o saldo de toda wallet criada pelos testes é igual ao
 * saldo reconstruído pelo ledger.
 */
export function itKeepsEveryBalanceEqualToItsLedger(database: () => TestDatabase): void {
  it('final invariant: every wallet balance equals the balance rebuilt from its ledger', async () => {
    const [{ wallets }] = (await database().execute<{ wallets: number }>('select count(*)::int as wallets from wallets')) as [
      { wallets: number },
    ];
    expect(wallets).toBeGreaterThan(0);
    expect(await walletsDivergingFromLedger(database())).toEqual([]);
  });
}
