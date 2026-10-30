import type { INestApplication, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { correlationIdMiddleware } from './correlation-id';
import { HttpErrorFilter } from './http-error.filter';

export interface CreateHttpAppOptions {
  logger?: LogLevel[] | false;
}

/** Cria a aplicação Nest com o correlation id e o filtro de erros globais; usada pelo bootstrap e pelos testes. */
export async function createHttpApp(options: CreateHttpAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, options.logger === undefined ? {} : { logger: options.logger });
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  return app;
}
