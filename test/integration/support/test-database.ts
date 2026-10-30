import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig, type AppConfig } from '../../../src/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/database/mikro-orm.config';

export interface TestDatabase {
  readonly orm: MikroORM;
  readonly name: string;
  execute<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
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
    execute: <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params) as Promise<T[]>,
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
