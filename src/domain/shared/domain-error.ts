/** Base para erros de regra de negócio do domínio, identificados por um código estável. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
