import type { EntityManager } from '@mikro-orm/postgresql';
import type { Backlog } from '../observability/wagering-metrics';

/** Lê numa só consulta os eventos não publicados da outbox, a idade do mais antigo e as transações PENDING_REFERENCE. */
export async function readBacklog(em: EntityManager): Promise<Backlog> {
  const [row] = await em.getConnection().execute<{ outbox_pending: string; outbox_age: string; pending_references: string }[]>(`
    select
      (select count(*) from outbox_messages where published_at is null) as outbox_pending,
      (select coalesce(greatest(extract(epoch from now() - min(occurred_at)), 0), 0)
         from outbox_messages where published_at is null) as outbox_age,
      (select count(*) from wager_transactions where status = 'PENDING_REFERENCE') as pending_references
  `);
  return {
    outboxPending: Number(row!.outbox_pending),
    outboxOldestPendingAgeSeconds: Number(row!.outbox_age),
    pendingReferenceTransactions: Number(row!.pending_references),
  };
}
