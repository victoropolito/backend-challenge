import { Controller, Get, Inject, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { HttpResponse } from '../http/http-types';

type CheckResult = { status: 'up' } | { status: 'down'; reason: string };

const CHECK_TIMEOUT_MS = 2_000;

/** Health checks de liveness e readiness (sem autenticação). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, CheckResult> }> {
    const [postgres, sqs] = await Promise.all([
      this.check(async () => {
        await this.orm.em.getConnection().execute('select 1');
      }),
      this.check(async () => {
        const { wagerQueueName, wagerDlqName, eventsQueueName } = this.config.sqs;
        await Promise.all(
          [wagerQueueName, wagerDlqName, eventsQueueName].map((QueueName) => this.sqs.send(new GetQueueUrlCommand({ QueueName }))),
        );
      }),
    ]);

    const checks = { postgres, sqs };
    if (Object.values(checks).some((c) => c.status === 'down')) {
      response.status(503);
      return { status: 'unavailable', checks };
    }
    return { status: 'ok', checks };
  }

  private async check(probe: () => Promise<void>): Promise<CheckResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
        }),
      ]);
      return { status: 'up' };
    } catch (error) {
      const reason = error instanceof Error ? error.message || error.name : String(error);
      return { status: 'down', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}
