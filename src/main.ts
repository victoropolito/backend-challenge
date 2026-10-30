import 'reflect-metadata';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { StructuredLogger } from './infrastructure/observability/structured-logger';
import { createHttpApp } from './http/create-http-app';

const logger = new StructuredLogger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await createHttpApp();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
  logger.info('HTTP listening', { port: config.port });
}

bootstrap().catch((error: unknown) => {
  logger.error('Bootstrap failed', undefined, error);
  process.exit(1);
});
