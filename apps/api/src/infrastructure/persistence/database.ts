import { Pool } from 'pg';

import type { Configuration } from '../../configuration.js';
import type { StructuredLogger } from '../../observability/logger.js';

/**
 * One pool per process, with the timeouts that keep a slow database from becoming a stopped one.
 *
 * The timeouts are set on the connection rather than left to the role. Leaving them to the role is
 * the tidier idea and it is how this file used to describe itself, which was worse than saying
 * nothing: no role ever set them, so a comment asserted a control that did not exist. `roles.sql`
 * now sets them too, for sessions this code does not open, and these are what protect the service.
 *
 * What each one prevents:
 *
 * - `statement_timeout` stops a query that will never finish from holding a pool connection until
 *   every worker is blocked behind it. Ten connections and one runaway query is an outage.
 * - `lock_timeout` makes a contended row fail fast instead of queueing. A payment write that waits
 *   forever on a lock looks exactly like a hung process to everything upstream.
 * - `idle_in_transaction_session_timeout` closes a transaction a crashed handler left open. Those
 *   hold their locks and hold back vacuum, and nothing else in the system will ever end them.
 *
 * The values are generous rather than tight. The purpose is to bound a failure, not to police
 * ordinary latency, and a timeout that fires during normal operation is a timeout that gets removed.
 */

const MAXIMUM_POOL_CONNECTIONS = 10;
const IDLE_TIMEOUT_MILLISECONDS = 30_000;
const CONNECTION_TIMEOUT_MILLISECONDS = 5000;

const STATEMENT_TIMEOUT_MILLISECONDS = 30_000;
const LOCK_TIMEOUT_MILLISECONDS = 10_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MILLISECONDS = 60_000;

export interface DatabasePoolOptions {
  /** Names the process in pg_stat_activity, so an incident can be attributed without guessing. */
  readonly applicationName?: string;
  readonly logger?: StructuredLogger;
}

export function createDatabasePool(
  configuration: Configuration,
  options: DatabasePoolOptions = {},
): Pool {
  const pool = new Pool({
    connectionString: configuration.databaseUrl,
    max: MAXIMUM_POOL_CONNECTIONS,
    idleTimeoutMillis: IDLE_TIMEOUT_MILLISECONDS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    application_name: options.applicationName ?? 'cryptopay',
    options: [
      `-c statement_timeout=${STATEMENT_TIMEOUT_MILLISECONDS.toString()}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MILLISECONDS.toString()}`,
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MILLISECONDS.toString()}`,
    ].join(' '),
  });

  /**
   * An idle client failing is not an application error and must not reach the process.
   *
   * `pg` emits `error` on the pool when a connection sitting in the pool dies — a database restart,
   * a failover, an idle connection reaped by a firewall. With no listener, Node treats it as an
   * unhandled `error` event and terminates the process. That turns a database blip that the pool
   * would have recovered from by opening a new connection into every worker dying at once.
   */
  pool.on('error', (error) => {
    options.logger?.error(
      { event: 'database.idle_client_failed', error },
      'An idle database connection failed and was discarded',
    );
  });

  return pool;
}
