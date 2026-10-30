import { DomainError } from '../../domain/shared/domain-error';

/** Quem fez a requisição, segundo a credencial apresentada. */
export interface Principal {
  subject: string;
  /** Provider a que a credencial pertence; `undefined` quando ela não é restrita a um provider. */
  providerId: string | undefined;
}

/**
 * Ponto de extensão da autenticação da API: valida a credencial da requisição e devolve o principal, ou `undefined`
 * quando ela está ausente ou é inválida.
 */
export abstract class RequestAuthenticator {
  abstract authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<Principal | undefined>;
}

/** Principal usado enquanto não há provedor de identidade: sem restrição de provider. */
export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({ subject: 'anonymous', providerId: undefined });

/** Autenticação desligada: aceita toda requisição como o principal anônimo. */
export class AllowAllAuthenticator extends RequestAuthenticator {
  async authenticate(): Promise<Principal> {
    return ANONYMOUS_PRINCIPAL;
  }
}

/** Credencial ausente ou inválida. */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('Missing or invalid credentials');
  }
}

/** A credencial pertence a outro provider. */
export class ProviderForbiddenError extends DomainError {
  readonly code = 'PROVIDER_FORBIDDEN';

  constructor(
    readonly subject: string,
    readonly providerId: string,
  ) {
    super(`Credentials of ${subject} cannot act on behalf of provider ${providerId}`);
  }
}

/** Recusa a operação se o principal for restrito a um provider diferente de `providerId`. */
export function assertProviderAccess(principal: Principal, providerId: string): void {
  if (principal.providerId !== undefined && principal.providerId !== providerId) {
    throw new ProviderForbiddenError(principal.subject, providerId);
  }
}

/** Indica se o principal pode ver dados do provider (sem restrição ou o mesmo provider). */
export function canAccessProvider(principal: Principal, providerId: string): boolean {
  return principal.providerId === undefined || principal.providerId === providerId;
}
