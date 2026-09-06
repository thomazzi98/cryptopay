import type { ApplicationServer } from '../server-types.js';

/**
 * Liveness and readiness are deliberately different checks.
 *
 * `/healthz` answers "is this process alive" and touches nothing else. A liveness probe that fails
 * when the database is slow triggers a restart storm during exactly the incident where restarts help
 * least, so it must have no dependencies at all.
 *
 * `/readyz` answers "should traffic be routed here" and reports each dependency separately, so an
 * operator can see which one is at fault rather than only that something is.
 */

export interface ReadinessDependencies {
  readonly startedAtMilliseconds: number;
  readonly callbackSsrfPolicy: 'strict' | 'relaxed';
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

export function registerHealthRoutes(
  server: ApplicationServer,
  dependencies: ReadinessDependencies,
): void {
  server.get('/healthz', (request, reply) => {
    void reply.code(200).send({ status: 'ok' });
  });

  server.get('/readyz', (request, reply) => {
    const components: ComponentReport[] = [
      {
        name: 'configuration',
        status: 'ok',
        detail: `callback SSRF policy: ${dependencies.callbackSsrfPolicy}`,
      },
    ];

    const status = summarizeReadiness(components);
    const body = {
      status,
      callbackSsrfPolicy: dependencies.callbackSsrfPolicy,
      uptimeSeconds: Math.floor((Date.now() - dependencies.startedAtMilliseconds) / 1000),
      components,
    };

    void reply.code(status === 'failed' ? 503 : 200).send(body);
  });
}
