import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import { DomainError } from '../domain/shared/domain-error';
import { isTransientDatabaseError } from '../infrastructure/database/transient-error';
import type { HttpRequest, HttpResponse } from './http-types';
import { RequestValidationError } from './request-validation';

export interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/** Status HTTP de cada código de erro de domínio/aplicação conhecido; códigos fora da tabela são bug (500). */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_MONEY: 400,
  INVALID_WAGER_TRANSACTION: 400,
  INVALID_WALLET_OPERATION: 400,
  INVALID_CURSOR: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_ID_CONFLICT: 409,
  WALLET_CONCURRENT_MODIFICATION: 503,
};

const CODE_BY_HTTP_STATUS: Readonly<Record<number, string>> = {
  400: 'MALFORMED_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

export const RETRY_AFTER_SECONDS = 1;

/** Converte qualquer exceção na resposta de erro padronizada da API. */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof RequestValidationError) {
    return { status: 400, code: exception.code, message: 'Invalid request', retryable: false, details: exception.issues };
  }
  if (exception instanceof DomainError) {
    const status = STATUS_BY_CODE[exception.code];
    if (status !== undefined) {
      return { status, code: exception.code, message: exception.message, retryable: status === 503 };
    }
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      code: CODE_BY_HTTP_STATUS[status] ?? `HTTP_${status}`,
      message: exception.message,
      retryable: status === 503,
    };
  }
  if (isTransientDatabaseError(exception)) {
    return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, retry later', retryable: true };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false };
}

/** Filtro global: corpo `{ code, message, retryable, details?, correlationId }`; erros repetíveis incluem `Retry-After`. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new StructuredLogger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const { status, ...body } = toErrorResponse(exception);

    if (status >= 500) {
      this.logger.error(
        'Request failed',
        {
          correlationId: request.correlationId,
          method: request.method,
          path: request.originalUrl.split('?')[0],
          status,
          code: body.code,
        },
        exception,
      );
    }
    if (response.headersSent) {
      return;
    }
    if (body.retryable) {
      response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    }
    response.status(status).json({ ...body, correlationId: request.correlationId ?? null });
  }
}
