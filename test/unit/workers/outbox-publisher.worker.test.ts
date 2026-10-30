import { describe, expect, it } from 'bun:test';
import { WageringMetrics } from '../../../src/infrastructure/observability/wagering-metrics';
import { OutboxPublisherWorker } from '../../../src/workers/outbox-publisher.worker';
import { RecordingLogger } from '../../support/loggers';
import { sampleValue } from '../../support/metrics';

describe('OutboxPublisherWorker', () => {
  it('counts published events and refused ones, and logs each refusal', async () => {
    const metrics = new WageringMetrics();
    const logger = new RecordingLogger();
    let batches = 0;
    const worker = new OutboxPublisherWorker({
      publish: {
        async execute() {
          batches += 1;
          return batches === 1
            ? { claimed: 3, published: 2, failures: new Map([['event-3', 'throttled']]) }
            : { claimed: 0, published: 0, failures: new Map() };
        },
      },
      logger,
      metrics,
      options: { batchSize: 10, idleDelayMs: 5 },
    });

    worker.start();
    while (batches < 2) {
      await Bun.sleep(5);
    }
    await worker.stop();

    const text = await metrics.render();
    expect(sampleValue(text, 'wagering_outbox_published_total')).toBe(2);
    expect(sampleValue(text, 'wagering_outbox_publish_failures_total')).toBe(1);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Event not published, will retry',
      fields: { eventId: 'event-3', reason: 'throttled' },
    });
  });
});
