import { describe, expect, it } from 'bun:test';
import { WageringMetrics, type Backlog } from '../../../src/infrastructure/observability/wagering-metrics';
import { RecordingLogger } from '../../support/loggers';
import { sampleValue } from '../../support/metrics';

const backlog: Backlog = { outboxPending: 4, outboxOldestPendingAgeSeconds: 12.5, pendingReferenceTransactions: 2 };

describe('WageringMetrics', () => {
  it('exports the backlog gauges, reading the backlog once per render', async () => {
    let reads = 0;
    const metrics = new WageringMetrics({
      readBacklog: async () => {
        reads += 1;
        return backlog;
      },
    });

    const first = await metrics.render();
    await metrics.render();

    expect(sampleValue(first, 'wagering_outbox_pending_messages')).toBe(4);
    expect(sampleValue(first, 'wagering_outbox_oldest_pending_age_seconds')).toBe(12.5);
    expect(sampleValue(first, 'wagering_pending_reference_transactions')).toBe(2);
    expect(reads).toBe(2);
  });

  it('a failed backlog reading omits the gauges, keeps the other metrics and logs a warning', async () => {
    const logger = new RecordingLogger();
    const metrics = new WageringMetrics({
      readBacklog: async () => {
        throw new Error('database down');
      },
      logger,
    });
    metrics.outboxPublished.inc({}, 3);

    const text = await metrics.render();

    expect(sampleValue(text, 'wagering_outbox_pending_messages')).toBeUndefined();
    expect(sampleValue(text, 'wagering_outbox_published_total')).toBe(3);
    expect(logger.entries).toEqual([
      { level: 'warn', message: 'Could not read the backlog for metrics', fields: { reason: 'database down' } },
    ]);
  });

  it('without a backlog reader, the gauges are not registered', async () => {
    expect(await new WageringMetrics().render()).not.toContain('wagering_outbox_pending_messages');
  });
});
