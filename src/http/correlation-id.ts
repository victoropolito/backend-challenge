import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { randomUUIDv7 } from 'bun';
import type { HttpRequest, HttpResponse } from './http-types';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Adota o X-Correlation-Id recebido (se bem formado) ou gera um, e o devolve no header da resposta. */
export function correlationIdMiddleware(request: HttpRequest, response: HttpResponse, next: () => void): void {
  const received = request.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof received === 'string' && VALID_CORRELATION_ID.test(received) ? received : randomUUIDv7();
  request.correlationId = correlationId;
  response.setHeader('X-Correlation-Id', correlationId);
  next();
}

/** Correlation id da requisição corrente. */
export const CorrelationId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => context.switchToHttp().getRequest<HttpRequest>().correlationId!,
);
