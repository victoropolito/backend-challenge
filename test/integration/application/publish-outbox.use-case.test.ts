import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventPublisher } from '../../../src/application/messaging/event-publisher';
import { PublishOutboxUseCase } from '../../../src/application/messaging/publish-outbox.use-case';
import { Clock } from '../../../src/application/shared/clock';
import { OutboxRepository } from '../../../src/domain/messaging/messaging-repositories';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import { MikroOrmOutboxRepository } from '../../../src/infrastructure/database/repositories/mikro-orm-messaging.repositories';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let outbox: MikroOrmOutboxRepository;
let transactions: MikroOrmTransactionRunner;

const clock = new (class extends Clock {
  current = new Date('2026-10-30T12:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
})();

/** Publisher em memória: registra cada publicação, pode recusar ids, falhar inteiro, demorar ou esperar um portão. */
class RecordingPublisher extends EventPublisher {
  readonly published: string[] = [];
  readonly reject = new Set<string>();
  failAll = false;
  delayMs = 0;
  gate: Promise<void> | undefined;
  onPublish: (() => void) | undefined;

  async publish(messages: readonly OutboxMessage[]): Promise<Map<string, string>> {
    this.onPublish?.();
    await this.gate;
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    if (this.failAll) {
      throw new Error('destination unavailable');
    }
    const failures = new Map<string, string>();
    for (const message of messages) {
      if (this.reject.has(message.id)) {
        failures.set(message.id, 'rejected');
      } else {
        this.published.push(message.id);
      }
    }
    return failures;
  }
}

const useCaseWith = (publisher: EventPublisher, repository: OutboxRepository = outbox) =>
  new PublishOutboxUseCase({ transactions, outbox: repository, publisher, clock });

beforeAll(async () => {
  db = await createTestDatabase();
  outbox = new MikroOrmOutboxRepository(db.orm.em);
  transactions = new MikroOrmTransactionRunner(db.orm.em);
}, 30_000);

beforeEach(async () => {
  clock.current = new Date('2026-10-30T12:00:00.000Z');
  await db.execute(`update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null`);
});

afterAll(async () => {
  await db?.drop();
});

const enqueue = async (count: number, nextAttemptAt?: Date): Promise<string[]> => {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    await outbox.insert(
      OutboxMessage.rehydrate({
        id,
        aggregateId: randomUUID(),
        eventType: 'WagerTransactionProcessed',
        payload: { eventId: id, index },
        occurredAt: clock.now(),
        attempts: 0,
        nextAttemptAt,
        publishedAt: undefined,
      }),
    );
    ids.push(id);
  }
  return ids;
};

const stored = async (id: string) => (await new MikroOrmOutboxRepository(db.orm.em.fork()).findById(id))!;

describe('PublishOutboxUseCase', () => {
  it('publishes the due messages in the order they were written and marks them published', async () => {
    const ids = await enqueue(3);
    const publisher = new RecordingPublisher();

    const result = await useCaseWith(publisher).execute(10);

    expect(result).toEqual({ claimed: 3, published: 3, failures: new Map() });
    expect(publisher.published).toEqual(ids);
    for (const id of ids) {
      const message = await stored(id);
      expect(message.publishedAt).toEqual(clock.now());
      expect(message.nextAttemptAt).toBeUndefined();
    }
  });

  it('does nothing when there is nothing due', async () => {
    const publisher = new RecordingPublisher();
    expect(await useCaseWith(publisher).execute(10)).toEqual({ claimed: 0, published: 0, failures: new Map() });
    expect(publisher.published).toEqual([]);
  });

  it('respects the batch size', async () => {
    const ids = await enqueue(5);
    const publisher = new RecordingPublisher();

    await useCaseWith(publisher).execute(2);

    expect(publisher.published).toEqual(ids.slice(0, 2));
  });

  it('skips messages whose next attempt is still in the future', async () => {
    const [later] = await enqueue(1, new Date('2026-10-30T12:00:05.000Z'));
    const publisher = new RecordingPublisher();

    expect((await useCaseWith(publisher).execute(10)).claimed).toBe(0);

    clock.current = new Date('2026-10-30T12:00:05.000Z');
    await useCaseWith(publisher).execute(10);
    expect(publisher.published).toEqual([later!]);
  });

  it('schedules a retry with backoff for the messages the destination refused', async () => {
    const [ok, refused] = await enqueue(2);
    const publisher = new RecordingPublisher();
    publisher.reject.add(refused!);

    const result = await useCaseWith(publisher).execute(10);

    expect(result.published).toBe(1);
    expect(result.failures).toEqual(new Map([[refused!, 'rejected']]));
    expect((await stored(ok!)).publishedAt).toEqual(clock.now());
    const retried = await stored(refused!);
    expect(retried.publishedAt).toBeUndefined();
    expect(retried.attempts).toBe(1);
    expect(retried.nextAttemptAt).toEqual(new Date('2026-10-30T12:00:01.000Z'));
  });

  it('schedules a retry for the whole batch when the destination is unavailable, and publishes it later', async () => {
    const ids = await enqueue(3);
    const publisher = new RecordingPublisher();
    publisher.failAll = true;

    const failed = await useCaseWith(publisher).execute(10);

    expect(failed.published).toBe(0);
    expect([...failed.failures.values()]).toEqual(Array(3).fill('destination unavailable'));
    expect((await stored(ids[0]!)).attempts).toBe(1);

    publisher.failAll = false;
    clock.current = new Date('2026-10-30T12:00:01.000Z');
    await useCaseWith(publisher).execute(10);
    expect(publisher.published).toEqual(ids);
  });

  it('a second publisher skips the messages locked by the first one', async () => {
    const ids = await enqueue(15);
    let release!: () => void;
    let entered!: () => void;
    const first = new RecordingPublisher();
    first.gate = new Promise((resolve) => (release = resolve));
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    first.onPublish = entered;

    const running = useCaseWith(first).execute(10);
    await firstEntered;
    const second = new RecordingPublisher();
    await useCaseWith(second).execute(10);
    release();
    await running;

    expect(first.published).toEqual(ids.slice(0, 10));
    expect(second.published).toEqual(ids.slice(10));
  });

  it('5 concurrent publishers publish every message exactly once', async () => {
    const ids = await enqueue(200);
    const publisher = new RecordingPublisher();
    publisher.delayMs = 10;
    const useCase = useCaseWith(publisher);

    await Promise.all(
      Array.from({ length: 5 }, async () => {
        while ((await useCase.execute(10)).claimed > 0) {}
      }),
    );

    expect(publisher.published.toSorted()).toEqual(ids.toSorted());
    const [row] = await db.execute<{ pending: number }>(
      'select count(*)::int as pending from outbox_messages where published_at is null',
    );
    expect(row!.pending).toBe(0);
  });

  it('republishes with the same id when the process dies after publishing but before the commit', async () => {
    const ids = await enqueue(2);
    const publisher = new RecordingPublisher();
    const crashing = new (class extends OutboxRepository {
      findById = outbox.findById.bind(outbox);
      claimDue = outbox.claimDue.bind(outbox);
      insert = outbox.insert.bind(outbox);
      async update(): Promise<void> {
        throw new Error('process died');
      }
    })();

    await expect(useCaseWith(publisher, crashing).execute(10)).rejects.toThrow('process died');
    expect((await stored(ids[0]!)).publishedAt).toBeUndefined();

    await useCaseWith(publisher).execute(10);

    expect(publisher.published).toEqual([...ids, ...ids]);
    expect((await stored(ids[0]!)).publishedAt).toEqual(clock.now());
  });
});
