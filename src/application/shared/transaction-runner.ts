/** Executa `work` numa transação de banco: os repositórios usados dentro dela participam da mesma transação. */
export abstract class TransactionRunner {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
