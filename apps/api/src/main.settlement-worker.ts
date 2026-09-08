import { hostname } from 'node:os';

import { composeSettlementWorker } from './composition-root.js';

/**
 * The settlement worker runs as its own process, and it is the only one that can sign.
 *
 * Separating it is not symmetry with the other workers. This process holds the seed that controls
 * every deposit address, so it runs with the narrowest database role in the deployment, on its own
 * container, reachable from nothing. Folding it into the API would put that key behind an HTTP
 * surface, which is the one place it must never be.
 */

const worker = await composeSettlementWorker(
  process.env,
  `${hostname()}:${process.pid.toString()}`,
);

async function shutDown(signal: NodeJS.Signals): Promise<void> {
  worker.logger.info({ signal }, 'Stopping the settlement worker');
  await worker.stop();
  await worker.databasePool.end();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutDown(signal));
process.on('SIGINT', (signal) => void shutDown(signal));

await worker.start();
