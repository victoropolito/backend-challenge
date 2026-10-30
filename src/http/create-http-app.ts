import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/app-config';
import { NestJsonLogger } from '../infrastructure/observability/nest-json-logger';
import { configureLogging } from '../infrastructure/observability/structured-logger';
import { WageringMetrics } from '../infrastructure/observability/wagering-metrics';
import { correlationIdMiddleware } from './correlation-id';
import { HttpErrorFilter } from './http-error.filter';
import { requestLogMiddleware } from './request-log';

export interface CreateHttpAppOptions {
  /** false silencia todos os logs (testes); sem a opção, vale o LOG_LEVEL da config. */
  logger?: false;
}

/** Cria a aplicação Nest com logs JSON, correlation id, log e métricas de requisições e o filtro de erros globais. */
export async function createHttpApp(options: CreateHttpAppOptions = {}): Promise<INestApplication> {
  configureLogging({ level: options.logger === false ? 'silent' : loadConfig().logLevel });
  const app = await NestFactory.create(AppModule, { logger: new NestJsonLogger() });
  app.use(correlationIdMiddleware);
  app.use(requestLogMiddleware(app.get(WageringMetrics)));
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  return app;
}
