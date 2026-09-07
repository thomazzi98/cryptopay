import type { BlockCursorRepository } from '../../infrastructure/persistence/block-cursor.repository.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Liveness and readiness are deliberately different checks.
 *
 * `/healthz` answers "is this process alive" and touches nothing else. A liveness probe that fails
 * when the database is slow triggers a restart storm during exactly the incident where restarts help
 * least, so it must have no dependencies at all.
 *
 * `/readyz` answers "should traffic be routed here" and reports each dependency separately, so an
 * operator can see which one is at fault rather than only that something is. A halted network is
 * reported as degraded rather than failed: the API can still answer, and taking every instance out
 * of rotation because one chain stopped would turn a contained incident into an outage.
 */

export interface ReadinessDependencies {
  readonly startedAtMilliseconds: number;
  readonly callbackSsrfPolicy: 'strict' | 'relaxed';
  readonly blockCursorRepository: BlockCursorRepository;
  readonly now: () => Date;
}

type ComponentStatus = 'ok' | 'degraded' | 'failed';

interface ComponentReport {
  readonly name: string;
  readonly status: ComponentStatus;
  readonly detail: string;
}

function summarizeReadiness(components: readonly ComponentReport[]): ComponentStatus {
  if (components.some((component) => component.status === 'failed')) {
    return 'failed';
  }
  if (components.some((component) => component.status === 'degraded')) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * How long ago a network was last scanned. A cursor that has stopped moving is the failure that
 * would otherwise be invisible: payments keep being created, customers keep paying, and nothing is
 * ever detected, with every other signal green.
 */
const STALE_CURSOR_SECONDS = 120;

async function reportNetworks(
  dependencies: ReadinessDependencies,
): Promise<readonly ComponentReport[]> {
  const cursors = await dependencies.blockCursorRepository.findAll();
  if (cursors.length === 0) {
    return [
      {
        name: 'networks',
        status: 'failed',
        detail: 'no network is being scanned, so no payment could ever be detected',
      },
    ];
  }

  const now = dependencies.now().getTime();
  return cursors.map((cursor) => {
    if (cursor.haltedAt !== null) {
      return {
        name: `network:${cursor.networkIdentifier}`,
        status: 'degraded' as const,
        detail: `scanning is halted: ${cursor.haltedReason ?? 'no reason recorded'}`,
      };
    }
    const secondsSinceUpdate = Math.round((now - cursor.updatedAt.getTime()) / 1000);
    if (secondsSinceUpdate > STALE_CURSOR_SECONDS) {
      return {
        name: `network:${cursor.networkIdentifier}`,
        status: 'degraded' as const,
        detail: `the cursor has not advanced for ${secondsSinceUpdate.toString()} seconds`,
      };
    }
    return {
      name: `network:${cursor.networkIdentifier}`,
      status: 'ok' as const,
      detail: `scanned through block ${cursor.lastScannedHeight.toString()}`,
    };
  });
}

export function registerHealthRoutes(
  server: ApplicationServer,
  dependencies: ReadinessDependencies,
): void {
  server.get('/healthz', (request, reply) => {
    void reply.code(200).send({ status: 'ok' });
  });

  server.get('/readyz', async (request, reply) => {
    const components: ComponentReport[] = [
      {
        name: 'configuration',
        status: 'ok',
        detail: `callback destination policy: ${dependencies.callbackSsrfPolicy}`,
      },
    ];

    try {
      components.push(...(await reportNetworks(dependencies)));
    } catch (error) {
      // The database is the one dependency whose absence makes this instance useless, so it is the
      // one that answers 503 rather than degraded.
      components.push({
        name: 'database',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'the database could not be reached',
      });
    }

    const status = summarizeReadiness(components);
    await reply.code(status === 'failed' ? 503 : 200).send({
      status,
      callbackSsrfPolicy: dependencies.callbackSsrfPolicy,
      uptimeSeconds: Math.floor((Date.now() - dependencies.startedAtMilliseconds) / 1000),
      components,
    });
  });
}
