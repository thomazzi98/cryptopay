import type { ProblemDetails } from '@cryptopay/shared';

/**
 * The browser's only way to reach the API, and it goes through the dashboard's own proxy.
 *
 * There is no base URL to configure here on purpose. The proxy attaches the merchant's API key on
 * the server, so this module cannot leak a credential even if every value it holds is read.
 *
 * Errors arrive as RFC 9457 problem documents. They are surfaced as-is rather than replaced with a
 * generic message: the API already says exactly which field was wrong and why, and discarding that
 * to show "something went wrong" is throwing away the only useful part of the response.
 */

const BFF_PREFIX = '/api/bff';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  /** Everything the API said, joined for display. Field issues are what a merchant needs to see. */
  get detail(): string {
    const problem = this.problem;
    if (problem === null) {
      return this.message;
    }
    const issues = problem.errors ?? [];
    if (issues.length === 0) {
      return problem.detail;
    }
    return `${problem.detail} ${issues.map((issue) => `${issue.path}: ${issue.message}`).join(' ')}`;
  }
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return null;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export async function callApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`${BFF_PREFIX}/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    ...(options.signal !== undefined && { signal: options.signal }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const problem = await readProblem(response);
    throw new ApiError(
      response.status,
      problem,
      problem?.title ?? `The request failed with status ${response.status.toString()}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
