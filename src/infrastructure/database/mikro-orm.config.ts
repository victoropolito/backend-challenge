import { join } from 'node:path';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig, type AppConfig } from '../../config/app-config';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/** Configuração única do MikroORM, usada tanto pela aplicação (Nest) quanto pela CLI de migrations. */
export function buildMikroOrmConfig(config: AppConfig): Options {
  return defineConfig({
    clientUrl: config.database.url,
    pool: { max: config.database.poolMax },
    entities: [],
    discovery: { warnWhenNoEntities: false },
    forceUtcTimezone: true,
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
    debug: false,
  });
}

export default buildMikroOrmConfig(loadConfig());
