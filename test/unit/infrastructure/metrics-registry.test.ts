import { describe, expect, it } from 'bun:test';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics-registry';

describe('MetricsRegistry', () => {
  it('renders counters in the Prometheus text format, one series per label combination', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('requests_total', 'Requests handled.', ['method', 'status']);

    counter.inc({ method: 'GET', status: '200' });
    counter.inc({ method: 'GET', status: '200' }, 2);
    counter.inc({ method: 'POST', status: '422' });

    expect(await registry.render()).toBe(
      [
        '# HELP requests_total Requests handled.',
        '# TYPE requests_total counter',
        'requests_total{method="GET",status="200"} 3',
        'requests_total{method="POST",status="422"} 1',
        '',
      ].join('\n'),
    );
  });

  it('an unlabeled counter starts at zero; a labeled one has no series until used', async () => {
    const registry = new MetricsRegistry();
    registry.counter('published_total', 'Published.');
    registry.counter('failures_total', 'Failures.', ['code']);

    const text = await registry.render();

    expect(text).toContain('published_total 0\n');
    expect(text).not.toContain('failures_total{');
  });

  it('renders histograms with cumulative buckets, +Inf, sum and count', async () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram('duration_seconds', 'Duration.', ['route'], [0.5, 0.1]);

    histogram.observe({ route: '/a' }, 0.05);
    histogram.observe({ route: '/a' }, 0.3);
    histogram.observe({ route: '/a' }, 2);

    expect(await registry.render()).toBe(
      [
        '# HELP duration_seconds Duration.',
        '# TYPE duration_seconds histogram',
        'duration_seconds_bucket{route="/a",le="0.1"} 1',
        'duration_seconds_bucket{route="/a",le="0.5"} 2',
        'duration_seconds_bucket{route="/a",le="+Inf"} 3',
        'duration_seconds_sum{route="/a"} 2.35',
        'duration_seconds_count{route="/a"} 3',
        '',
      ].join('\n'),
    );
  });

  it('reads gauges at render time and leaves them without samples when the reading is undefined', async () => {
    const registry = new MetricsRegistry();
    let value: number | undefined = 7;
    registry.gauge('backlog', 'Backlog.', async () => value);

    expect(await registry.render()).toContain('backlog 7\n');
    value = undefined;
    expect(await registry.render()).toBe('# HELP backlog Backlog.\n# TYPE backlog gauge\n');
  });

  it('escapes label values and help text', async () => {
    const registry = new MetricsRegistry();
    registry.counter('c_total', 'Line one\nline two \\ end', ['v']).inc({ v: 'a "quoted" \\ value\n' });

    const text = await registry.render();

    expect(text).toContain('# HELP c_total Line one\\nline two \\\\ end');
    expect(text).toContain('c_total{v="a \\"quoted\\" \\\\ value\\n"} 1');
  });

  it('refuses two metrics with the same name', () => {
    const registry = new MetricsRegistry();
    registry.counter('x_total', 'X.');
    expect(() => registry.gauge('x_total', 'X.', async () => 1)).toThrow('already registered');
  });
});
