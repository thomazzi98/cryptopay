import type { ProblemDetails } from '@cryptopay/shared';

/**
 * Every error response is RFC 9457 `application/problem+json` carrying a stable machine-readable
 * `code`. Clients branch on the code; the human-readable title is free to change without breaking
 * an integration.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const PROBLEM_TYPE_BASE_URL = 'https://cryptopay.dev/problems';

export interface ProblemCatalogEntry {
  readonly status: number;
  readonly title: string;
}

/**
 * The catalogue is the complete list of failures the API is allowed to report. A test asserts every
 * entry is reachable from code, so a code cannot be documented without being raised.
 */
export const PROBLEM_CATALOG = Object.freeze({
  validation_failed: { status: 422, title: 'Request validation failed' },
  malformed_request: { status: 400, title: 'Malformed request' },
  unauthorized: { status: 401, title: 'Missing or invalid API key' },
  resource_not_found: { status: 404, title: 'Resource not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  rate_limited: { status: 429, title: 'Too many requests' },
  internal_error: { status: 500, title: 'Internal server error' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, ProblemCatalogEntry>);

export type ProblemCode = keyof typeof PROBLEM_CATALOG;

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ApplicationError extends Error {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly issues: readonly ValidationIssue[];
  /**
   * A more specific name for the same failure, for the gateway surface.
   *
   * The problem catalogue is deliberately small: eight codes a dashboard can branch on. An
   * orchestrator integrating over `/api/v1` needs to tell an unsupported currency from an amount it
   * cannot express, and both are `validation_failed` here. Carrying the finer name on the error
   * keeps one catalogue with one place that raises each failure, rather than two that drift.
   */
  readonly gatewayCode: string | null;

  constructor(
    code: ProblemCode,
    detail: string,
    issues: readonly ValidationIssue[] = [],
    gatewayCode: string | null = null,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ApplicationError';
    this.code = code;
    this.detail = detail;
    this.issues = issues;
    this.gatewayCode = gatewayCode;
  }

  get status(): number {
    return PROBLEM_CATALOG[this.code].status;
  }
}

export function toProblemDetails(
  error: ApplicationError,
  requestId: string,
  instance?: string,
): ProblemDetails {
  const entry = PROBLEM_CATALOG[error.code];
  const problem: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE_URL}/${error.code.replaceAll('_', '-')}`,
    title: entry.title,
    status: entry.status,
    detail: error.detail,
    code: error.code,
    requestId,
  };

  const withInstance = instance === undefined ? problem : { ...problem, instance };
  if (error.issues.length === 0) {
    return withInstance;
  }
  return { ...withInstance, errors: [...error.issues] };
}

/**
 * An unexpected throw must never reach the client as a stack trace or a driver message: those leak
 * table names, file paths and occasionally credentials. The detail is deliberately generic and the
 * request identifier is the way back to the log line that has everything.
 */
export function toUnexpectedProblemDetails(requestId: string): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE_URL}/internal-error`,
    title: PROBLEM_CATALOG.internal_error.title,
    status: PROBLEM_CATALOG.internal_error.status,
    detail: 'The request could not be completed. Quote the request identifier when reporting it.',
    code: 'internal_error',
    requestId,
  };
}
