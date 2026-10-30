import { createParamDecorator, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { HttpRequest } from '../http-types';
import { RequestAuthenticator, UnauthenticatedError, type Principal } from './request-authenticator';

/** Exige um principal válido (401 sem ele) e o guarda na requisição para os controllers. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(@Inject(RequestAuthenticator) private readonly authenticator: RequestAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const principal = await this.authenticator.authenticate(request.headers);
    if (principal === undefined) {
      throw new UnauthenticatedError();
    }
    request.principal = principal;
    return true;
  }
}

/** Principal autenticado da requisição corrente (definido pelo AuthenticationGuard). */
export const AuthenticatedPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal => context.switchToHttp().getRequest<HttpRequest>().principal!,
);
