import { Global, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { readBacklog } from '../database/backlog-query';
import { StructuredLogger } from './structured-logger';
import { WageringMetrics } from './wagering-metrics';

/** Métricas da aplicação, compartilhadas por todos os módulos; o backlog é lido do banco a cada coleta. */
@Global()
@Module({
  providers: [
    {
      provide: WageringMetrics,
      inject: [EntityManager],
      useFactory: (em: EntityManager) =>
        new WageringMetrics({ readBacklog: () => readBacklog(em), logger: new StructuredLogger('Metrics') }),
    },
  ],
  exports: [WageringMetrics],
})
export class ObservabilityModule {}
