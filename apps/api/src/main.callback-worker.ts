import { hostname } from 'node:os';

import { composeCallbackWorker } from './composition-root.js';

/**
 * The callback worker runs as its own process, and in its own container.
 *
 * This is the only part of the system that makes outbound requests to addresses a stranger chose. It
 * gets its own database role, its own network policy and its own key material, so that a compromise
 * here reaches as little as possible. That containment is the reason it is a separate process, not
 * throughput.
 */

const worker = composeCallbackWorker(process.env, `${hostname()}:${process.pid.toString()}`);

async function shutDown(signal: NodeJS.Signals): Promise<void> {
  worker.logger.info({ signal }, 'Stopping the callback worker');
  await worker.stop();
  await worker.databasePool.end();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutDown(signal));
process.on('SIGINT', (signal) => void shutDown(signal));

await worker.start();
