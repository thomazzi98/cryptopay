import { composeApplication } from './composition-root.js';
import { ConfigurationError } from './configuration.js';

/**
 * The HTTP entry point. It serves requests and nothing else: block scanning and webhook delivery run
 * in their own processes, so an HTTP flood cannot starve payment detection and an API restart cannot
 * pause it.
 */

async function main(): Promise<void> {
  const { configuration, server } = composeApplication(process.env);

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ event: 'api.shutdown_requested', signal }, 'draining connections');
    await server.close();
    server.log.info({ event: 'api.shutdown_completed' }, 'closed');
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }

  await server.listen({ host: configuration.host, port: configuration.port });
  server.log.info(
    { event: 'api.started', host: configuration.host, port: configuration.port },
    'listening',
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78);
  }
  process.stderr.write(`Failed to start: ${String(error)}\n`);
  process.exit(1);
}
