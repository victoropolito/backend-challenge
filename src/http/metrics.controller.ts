import { Controller, Get, Header, Inject } from '@nestjs/common';
import { WageringMetrics } from '../infrastructure/observability/wagering-metrics';

/** Exporta as métricas no formato de texto do Prometheus (sem autenticação, como os health checks). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(WageringMetrics) private readonly metrics: WageringMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): Promise<string> {
    return this.metrics.render();
  }
}
