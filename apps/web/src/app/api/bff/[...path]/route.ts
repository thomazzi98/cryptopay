import { NextResponse, type NextRequest } from 'next/server';

import { readSession } from '@/lib/session';

/**
 * The dashboard's only route to the API.
 *
 * Everything the browser asks for comes through here, and the merchant's API key is attached on this
 * side of the wire. The key therefore never enters the browser bundle, never appears in a network
 * panel, and cannot be read by any script that manages to run on the page.
 *
 * The proxy is also why there is no build-time API URL. Next 16 removed `publicRuntimeConfig`, and an
 * inlined base URL cannot be right in both the container and the browser anyway; here the address is
 * read from the server environment at request time.
 *
 * Only an explicit list of methods and paths is forwarded. A proxy that forwards anything is an open
 * relay into the internal network, which is the same class of mistake as an unvalidated webhook
 * destination and deserves the same treatment.
 */

const API_BASE_URL = process.env.CRYPTOPAY_API_URL ?? 'http://127.0.0.1:3001';
const FORWARDED_METHODS = new Set(['GET', 'POST', 'DELETE']);

/**
 * Paths the dashboard is allowed to reach, as patterns rather than prefixes. A prefix check would
 * let `/v1/payments/../../anything` through once a segment contains a traversal.
 */
const ALLOWED_PATHS: readonly RegExp[] = Object.freeze([
  /^v1\/merchants\/me$/,
  /^v1\/payments$/,
  /^v1\/payments\/pay_[\dA-HJKMNP-TV-Z]{26}$/,
  /^v1\/payments\/pay_[\dA-HJKMNP-TV-Z]{26}\/(transfers|timeline|deliveries|cancel)$/,
  /^v1\/webhooks\/deliveries$/,
  /^v1\/webhooks\/deliveries\/whd_[\dA-HJKMNP-TV-Z]{26}$/,
  /^v1\/webhooks\/deliveries\/whd_[\dA-HJKMNP-TV-Z]{26}\/redeliver$/,
  /^v1\/webhooks\/secrets$/,
  /^v1\/webhooks\/secrets\/whs_[\dA-HJKMNP-TV-Z]{26}$/,
  /^readyz$/,
]);

/** Response headers worth passing on. Everything else is dropped rather than relayed blindly. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'retry-after'];

function problem(status: number, title: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

async function forward(request: NextRequest, path: string[]): Promise<NextResponse> {
  if (!FORWARDED_METHODS.has(request.method)) {
    return problem(405, 'Method not allowed', 'The dashboard proxy does not forward this method.');
  }

  const joined = path.join('/');
  if (ALLOWED_PATHS.every((allowed) => !allowed.test(joined))) {
    return problem(
      404,
      'Not found',
      'The dashboard proxy forwards only the endpoints the dashboard uses.',
    );
  }

  const session = await readSession();
  if (session === null) {
    return problem(401, 'Not connected', 'Connect with an API key before using the dashboard.');
  }

  const target = new URL(`${API_BASE_URL}/${joined}`);
  target.search = request.nextUrl.search;

  const body = request.method === 'GET' ? undefined : await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        'content-type': 'application/json',
        // Idempotency is the API's requirement, not the dashboard's convenience, so it is passed
        // through rather than invented here.
        ...(request.headers.has('idempotency-key') && {
          'idempotency-key': request.headers.get('idempotency-key') ?? '',
        }),
      },
      ...(body !== undefined && body !== '' && { body }),
      cache: 'no-store',
    });
  } catch {
    return problem(
      502,
      'The API could not be reached',
      'The dashboard is running but the CryptoPay API did not answer.',
    );
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // Nothing the dashboard reads is cacheable: a payment's status is the whole point and it changes.
  headers.set('cache-control', 'no-store');

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

interface RouteContext {
  /** A Promise in Next 16. Awaiting it is not optional. */
  readonly params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path);
}
