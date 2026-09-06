import { Pool } from 'pg';

import type { Configuration } from '../../configuration.js';

/**
 * One pool per process. Statement, lock and idle-in-transaction timeouts are set on the database
 * role rather than here, so they apply to every connection whatever opens it, including a psql
 * session during an incident.
 */

const MAXIMUM_POOL_CONNECTIONS = 10;
const IDLE_TIMEOUT_MILLISECONDS = 30_000;
const CONNECTION_TIMEOUT_MILLISECONDS = 5000;

export function createDatabasePool(configuration: Configuration): Pool {
  return new Pool({
    connectionString: configuration.databaseUrl,
    max: MAXIMUM_POOL_CONNECTIONS,
    idleTimeoutMillis: IDLE_TIMEOUT_MILLISECONDS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    application_name: 'cryptopay-api',
  });
}
