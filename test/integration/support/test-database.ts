import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig, type AppConfig } from '../../../src/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/database/mikro-orm.config';

export type Execute = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface TestDatabase {
  readonly orm: MikroORM;
  readonly name: string;
  readonly url: string;
  /** Executa um statement em autocommit. */
  execute: Execute;
  /** Executa `work` numa única transação SQL; constraints adiadas são verificadas no commit. */
  transaction<T>(work: (execute: Execute) => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

/** Cria um banco PostgreSQL descartável, com todas as migrations aplicadas, para um arquivo de testes de integração. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const baseConfig = loadConfig(process.env);
  const name = `wagering_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  const admin = await MikroORM.init(buildMikroOrmConfig(baseConfig));
  await admin.em.getConnection().execute(`create database "${name}"`);

  const url = new URL(baseConfig.database.url);
  url.pathname = `/${name}`;
  const config: AppConfig = { ...baseConfig, database: { url: url.toString(), poolMax: 5 } };

  const orm = await MikroORM.init(buildMikroOrmConfig(config));
  try {
    await orm.migrator.up();
  } catch (error) {
    await orm.close(true);
    await admin.em.getConnection().execute(`drop database "${name}" with (force)`);
    await admin.close(true);
    throw error;
  }

  return {
    orm,
    name,
    url: config.database.url,
    execute: <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params) as Promise<T[]>,
    transaction: (work) =>
      orm.em.fork().transactional((em) => work(<T>(sql: string, params: unknown[] = []) => em.execute(sql, params) as Promise<T[]>)),
    async drop() {
      await orm.close(true);
      await admin.em.getConnection().execute(`drop database if exists "${name}" with (force)`);
      await admin.close(true);
    },
  };
}

/** Executa `action` e verifica que o Postgres a recusou com o SQLSTATE e, se informado, a constraint esperados. */
export async function expectViolation(action: Promise<unknown>, sqlState: string, constraint?: string): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`Expected SQLSTATE ${sqlState}${constraint ? ` (${constraint})` : ''}, but the statement succeeded`);
  }
  const error = caught as { sqlState?: string; code?: string; message?: string };
  const state = error.sqlState ?? error.code;
  if (state !== sqlState || (constraint !== undefined && !error.message?.includes(`"${constraint}"`))) {
    throw new Error(
      `Expected SQLSTATE ${sqlState}${constraint ? ` (${constraint})` : ''}, got ${state}: ${error.message}`,
    );
  }
}

export const SqlState = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  NotNullViolation: '23502',
  RestrictViolation: '23001',
} as const;

export interface LedgerDivergence {
  wallet_id: string;
  balance: string;
  ledger_balance: string;
  last_balance_after: string | null;
}

/** Wallets cujo saldo difere da soma do ledger ou do saldo final do último lançamento (deve ser sempre vazio). */
export function walletsDivergingFromLedger(db: TestDatabase): Promise<LedgerDivergence[]> {
  return db.execute<LedgerDivergence>(`
    select w.id as wallet_id,
           w.balance::text as balance,
           coalesce(totals.ledger_balance, 0)::numeric(38, 2)::text as ledger_balance,
           last_entry.balance_after::text as last_balance_after
      from wallets w
      left join (
        select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as ledger_balance
          from wallet_ledger_entries
         group by wallet_id
      ) totals on totals.wallet_id = w.id
      left join lateral (
        select balance_after from wallet_ledger_entries e where e.wallet_id = w.id order by e.sequence desc limit 1
      ) last_entry on true
     where w.balance <> coalesce(totals.ledger_balance, 0)
        or w.balance <> coalesce(last_entry.balance_after, 0)
  `);
}

/**
 * Trava a wallet (`SELECT ... FOR UPDATE`) numa transação separada até a função devolvida ser chamada. Quem chama fica
 * fora do contexto dessa transação, então as próprias operações dele disputam o lock de verdade.
 */
export async function holdWalletLock(db: TestDatabase, walletId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (execute) => {
    await execute('select id from wallets where id = ? for update', [walletId]);
    locked();
    await released;
  });
  await isLocked;
  return async () => {
    release();
    await holder;
  };
}
