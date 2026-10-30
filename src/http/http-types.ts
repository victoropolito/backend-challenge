import type { Principal } from './auth/request-authenticator';

/** Recorte das interfaces de requisição e resposta do Express usadas pela camada HTTP. */
export interface HttpRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  principal?: Principal;
  /** Rota que atendeu a requisição (template, ex.: `/wallets/:walletId`), preenchida pelo roteador. */
  route?: { path?: unknown };
  baseUrl?: string;
}

export interface HttpResponse {
  headersSent: boolean;
  statusCode: number;
  on(event: 'finish', listener: () => void): void;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}
