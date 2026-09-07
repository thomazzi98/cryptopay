import { hostname } from 'node:os';

import { composeChainWorker } from './composition-root.js';

/**
 * The chain worker runs as its own process.
 *
 * Keeping it out of the API is not tidiness. An HTTP flood must not be able to starve detection, and
 * detection must keep running while the API is being redeployed; a customer whose money has already
 * left their wallet cannot be told to try again later.
 */

const worker = composeChainWorker(process.env, `${hostname()}:${process.pid.toString()}`);

async function shutDown(signal: NodeJS.Signals): Promise<void> {
  worker.logger.info({ signal }, 'Stopping the chain worker');
  await worker.stop();
  await worker.databasePool.end();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutDown(signal));
process.on('SIGINT', (signal) => void shutDown(signal));

await worker.start();
