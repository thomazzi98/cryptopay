/**
 * Readiness is read with a plain fetch rather than through callApi, for one reason: the endpoint
 * answers 503 when a component has failed, and that response body is the report an operator needs
 * to read. Treating it as a transport error would replace the diagnosis with "the request failed".
 */

const COMPONENT_STATUSES = ['ok', 'degraded', 'failed'] as const;

export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export interface ReadinessComponent {
  readonly name: string;
  readonly status: ComponentStatus;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly status: ComponentStatus;
  readonly callbackSsrfPolicy: string;
  readonly uptimeSeconds: number;
  readonly components: readonly ReadinessComponent[];
}

function isComponentStatus(value: unknown): value is ComponentStatus {
  return (COMPONENT_STATUSES as readonly unknown[]).includes(value);
}

function isComponent(value: unknown): value is ReadinessComponent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.detail === 'string' &&
    isComponentStatus(candidate.status)
  );
}

function isReadinessReport(value: unknown): value is ReadinessReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isComponentStatus(candidate.status) &&
    typeof candidate.callbackSsrfPolicy === 'string' &&
    typeof candidate.uptimeSeconds === 'number' &&
    Array.isArray(candidate.components) &&
    candidate.components.every((component) => isComponent(component))
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchReadiness(): Promise<ReadinessReport> {
  const response = await fetch('/api/bff/readyz', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  const body = await readJson(response);
  if (isReadinessReport(body)) {
    return body;
  }
  throw new Error(
    `Readiness could not be read. The API answered ${response.status.toString()} with no readiness report.`,
  );
}

/**
 * A network whose scanning is halted keeps every other signal green while no payment on it can ever
 * be detected, so it is called out rather than left as one degraded line among others. The endpoint
 * states it in the detail text, which is the only place it is expressed.
 */
export function isHalted(component: ReadinessComponent): boolean {
  return component.detail.includes('halted');
}
