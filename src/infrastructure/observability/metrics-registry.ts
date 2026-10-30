type LabelValues<L extends string> = Readonly<Record<L, string>>;

interface Sample {
  suffix?: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  samples(): Promise<Sample[]>;
}

/** Contador monotônico, uma série por combinação de labels. */
export class Counter<L extends string = never> implements Metric {
  readonly type = 'counter';
  private readonly series = new Map<string, { labels: LabelValues<L>; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly L[],
  ) {}

  inc(labels: LabelValues<L>, by = 1): void {
    const key = seriesKey(this.labelNames, labels);
    const current = this.series.get(key);
    if (current) {
      current.value += by;
    } else {
      this.series.set(key, { labels: pick(this.labelNames, labels), value: by });
    }
  }

  async samples(): Promise<Sample[]> {
    if (this.labelNames.length === 0 && this.series.size === 0) {
      return [{ labels: {}, value: 0 }];
    }
    return [...this.series.values()].map(({ labels, value }) => ({ labels, value }));
  }
}

/** Valor lido no momento da coleta; quando a leitura falha, a métrica sai sem amostras. */
export class Gauge implements Metric {
  readonly type = 'gauge';

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly read: () => Promise<number | undefined>,
  ) {}

  async samples(): Promise<Sample[]> {
    const value = await this.read();
    return value === undefined ? [] : [{ labels: {}, value }];
  }
}

/** Histograma com buckets cumulativos, soma e contagem por combinação de labels. */
export class Histogram<L extends string = never> implements Metric {
  readonly type = 'histogram';
  private readonly series = new Map<string, { labels: LabelValues<L>; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly L[],
    private readonly buckets: readonly number[],
  ) {}

  observe(labels: LabelValues<L>, value: number): void {
    const key = seriesKey(this.labelNames, labels);
    let current = this.series.get(key);
    if (!current) {
      current = { labels: pick(this.labelNames, labels), counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, current);
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound) {
        current.counts[index]! += 1;
      }
    });
    current.sum += value;
    current.count += 1;
  }

  async samples(): Promise<Sample[]> {
    return [...this.series.values()].flatMap(({ labels, counts, sum, count }) => [
      ...this.buckets.map((bound, index) => ({
        suffix: '_bucket',
        labels: { ...labels, le: formatNumber(bound) },
        value: counts[index]!,
      })),
      { suffix: '_bucket', labels: { ...labels, le: '+Inf' }, value: count },
      { suffix: '_sum', labels, value: sum },
      { suffix: '_count', labels, value: count },
    ]);
  }
}

/** Conjunto de métricas do processo, exportado no formato de texto do Prometheus (0.0.4). */
export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  counter<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, read: () => Promise<number | undefined>): Gauge {
    return this.register(new Gauge(name, help, read));
  }

  histogram<L extends string = never>(name: string, help: string, labelNames: readonly L[], buckets: readonly number[]): Histogram<L> {
    return this.register(new Histogram(name, help, labelNames, [...buckets].sort((a, b) => a - b)));
  }

  async render(): Promise<string> {
    const blocks = await Promise.all(
      this.metrics.map(async (metric) => {
        const lines = [`# HELP ${metric.name} ${escapeHelp(metric.help)}`, `# TYPE ${metric.name} ${metric.type}`];
        for (const sample of await metric.samples()) {
          lines.push(`${metric.name}${sample.suffix ?? ''}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
        }
        return lines.join('\n');
      }),
    );
    return `${blocks.join('\n')}\n`;
  }

  private register<M extends Metric>(metric: M): M {
    if (this.metrics.some((existing) => existing.name === metric.name)) {
      throw new Error(`Metric ${metric.name} is already registered`);
    }
    this.metrics.push(metric);
    return metric;
  }
}

function pick<L extends string>(labelNames: readonly L[], labels: LabelValues<L>): LabelValues<L> {
  return Object.fromEntries(labelNames.map((name) => [name, labels[name]])) as LabelValues<L>;
}

function seriesKey<L extends string>(labelNames: readonly L[], labels: LabelValues<L>): string {
  return JSON.stringify(labelNames.map((name) => labels[name]));
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '+Inf' : '-Inf';
  }
  return String(value);
}

function escapeHelp(help: string): string {
  return help.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
