import type { Pool } from 'pg';

import { type Configuration, loadConfiguration } from './configuration.js';
import { buildServer } from './http/build-server.js';
import type { ApplicationServer } from './http/server-types.js';
import { createDatabasePool } from './infrastructure/persistence/database.js';
import { MerchantRepository } from './infrastructure/persistence/merchant.repository.js';
import { createLogger } from './observability/logger.js';

/**
 * Explicit construction, in one place, in dependency order. This is what a dependency-injection
 * container would do, written out: the wiring is greppable, the order is visible, and there is no
 * runtime resolution step that can fail on a name.
 */

export interface Application {
  readonly configuration: Configuration;
  readonly server: ApplicationServer;
  readonly databasePool: Pool;
}

export function composeApplication(source: NodeJS.ProcessEnv): Application {
  const configuration = loadConfiguration(source);
  const logger = createLogger(configuration);
  const databasePool = createDatabasePool(configuration);
  const merchantRepository = new MerchantRepository(databasePool);
  const server = buildServer({ configuration, logger, merchantRepository });

  return { configuration, server, databasePool };
}
