import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import type { WageringMetrics } from '../infrastructure/observability/wagering-metrics';
import type { HttpRequest, HttpResponse } from './http-types';

const logger = new StructuredLogger('Http');

/**
 * Registra cada requisição concluída: log com método, caminho (sem query), status e duração (health checks só em
 * debug) e a latência no histograma, pelo template da rota (`unmatched` quando nenhuma rota da API atendeu,
 * inclusive o curinga de 404 do Nest).
 */
export function requestLogMiddleware(metrics?: WageringMetrics) {
  return (request: HttpRequest, response: HttpResponse, next: () => void): void => {
    const startedAt = performance.now();
    const path = request.originalUrl.split('?')[0]!;
    const correlationId = request.correlationId;
    response.on('finish', () => {
      const seconds = (performance.now() - startedAt) / 1_000;
      metrics?.httpRequestDuration.observe(
        { method: request.method, route: routeTemplate(request), status_code: String(response.statusCode) },
        seconds,
      );
      const fields = {
        correlationId,
        method: request.method,
        path,
        status: response.statusCode,
        durationMs: Math.round(seconds * 10_000) / 10,
      };
      if (path.startsWith('/health/')) {
        logger.debug('HTTP request', fields);
      } else {
        logger.info('HTTP request', fields);
      }
    });
    next();
  };
}

function routeTemplate(request: HttpRequest): string {
  const route = request.route?.path;
  if (typeof route !== 'string' || route.includes('*')) {
    return 'unmatched';
  }
  return `${request.baseUrl ?? ''}${route}`;
}
