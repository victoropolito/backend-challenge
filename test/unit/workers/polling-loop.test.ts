import { describe, expect, it } from 'bun:test';
import { PollingLoop } from '../../../src/workers/polling-loop';

const until = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not reached');
    }
    await Bun.sleep(5);
  }
};

describe('PollingLoop', () => {
  it('runs the next batch right away while there is more work, then waits', async () => {
    const answers = [true, true, false];
    const ticks: number[] = [];
    const loop = new PollingLoop({
      idleDelayMs: 10_000,
      tick: async () => {
        ticks.push(Date.now());
        return answers.shift() ?? false;
      },
      onError: () => {},
    });

    loop.start();
    await until(() => ticks.length === 3);
    await Bun.sleep(50);
    await loop.stop();

    expect(ticks).toHaveLength(3);
    expect(ticks[2]! - ticks[0]!).toBeLessThan(1_000);
  });

  it('reports a failed batch and tries again after the idle delay', async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const loop = new PollingLoop({
      idleDelayMs: 20,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error('database down');
        }
        return false;
      },
      onError: (error) => errors.push(error),
    });

    loop.start();
    await until(() => ticks >= 2);
    await loop.stop();

    expect(errors).toEqual([new Error('database down')]);
  });

  it('stop interrupts the wait and waits for the batch in progress', async () => {
    let finished = false;
    let started = false;
    const loop = new PollingLoop({
      idleDelayMs: 60_000,
      tick: async () => {
        if (started) {
          return false;
        }
        started = true;
        await Bun.sleep(100);
        finished = true;
        return false;
      },
      onError: () => {},
    });

    loop.start();
    await until(() => started);
    const stopping = Date.now();
    await loop.stop();

    expect(finished).toBe(true);
    expect(Date.now() - stopping).toBeLessThan(1_000);
  });

  it('start is idempotent', async () => {
    let ticks = 0;
    const loop = new PollingLoop({
      idleDelayMs: 60_000,
      tick: async () => {
        ticks += 1;
        return false;
      },
      onError: () => {},
    });

    loop.start();
    loop.start();
    await until(() => ticks >= 1);
    await Bun.sleep(30);
    await loop.stop();

    expect(ticks).toBe(1);
  });
});
