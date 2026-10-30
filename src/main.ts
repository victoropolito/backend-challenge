import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { createHttpApp } from './http/create-http-app';

async function bootstrap(): Promise<void> {
  const app = await createHttpApp();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
  Logger.log(`HTTP listening on port ${config.port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error, 'Bootstrap');
  process.exit(1);
});
