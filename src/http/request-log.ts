import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import type { HttpRequest, HttpResponse } from './http-types';

const logger = new StructuredLogger('Http');

/** Registra cada requisição concluída: método, caminho (sem query), status e duração; health checks só em debug. */
export function requestLogMiddleware(request: HttpRequest, response: HttpResponse, next: () => void): void {
  const startedAt = performance.now();
  const path = request.originalUrl.split('?')[0]!;
  const correlationId = request.correlationId;
  response.on('finish', () => {
    const fields = {
      correlationId,
      method: request.method,
      path,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
    if (path.startsWith('/health/')) {
      logger.debug('HTTP request', fields);
    } else {
      logger.info('HTTP request', fields);
    }
  });
  next();
}
