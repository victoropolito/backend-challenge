/** Gerador dos ids internos (UUID) de wallets, transações, lançamentos e eventos. */
export abstract class IdGenerator {
  abstract next(): string;
}
