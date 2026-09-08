import { NextResponse, type NextRequest } from 'next/server';

/**
 * The customer-facing proxy. No credential is attached here, and none is needed.
 *
 * It exists so the checkout page can poll from the browser without the API having to serve
 * cross-origin requests, and so the API's address stays a server-side detail. The checkout token in
 * the path is the only credential involved, and it belongs to the customer holding the link.
 *
 * Separate from the dashboard proxy deliberately: that one attaches a merchant API key, and a single
 * proxy that sometimes attaches a key and sometimes does not is one refactor away from attaching it
 * on a public route.
 */

const API_BASE_URL = process.env.CRYPTOPAY_API_URL ?? 'http://127.0.0.1:3001';
const CHECKOUT_TOKEN_PATTERN = /^[\w-]{16,128}$/;

interface RouteContext {
  readonly params: Promise<{ checkoutToken: string }>;
}

function problem(status: number, title: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

async function relay(path: string, method: 'GET' | 'POST', body?: string): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE_URL}/${path}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body !== undefined && body !== '' && { body }),
      cache: 'no-store',
    });
  } catch {
    return problem(
      502,
      'The payment service could not be reached',
      'This page is running but the CryptoPay API did not answer. Your payment is unaffected.',
    );
  }

  const headers = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) {
    headers.set('content-type', contentType);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { checkoutToken } = await context.params;
  if (!CHECKOUT_TOKEN_PATTERN.test(checkoutToken)) {
    return problem(404, 'Not found', 'That is not a checkout link.');
  }
  return relay(`v1/checkout/${checkoutToken}`, 'GET');
}

/**
 * Forwards the browser's report of the transaction it sent. The API treats it as a hint and nothing
 * more: every figure is re-derived from the chain, so a fabricated hash changes nothing.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { checkoutToken } = await context.params;
  if (!CHECKOUT_TOKEN_PATTERN.test(checkoutToken)) {
    return problem(404, 'Not found', 'That is not a checkout link.');
  }
  const body = await request.text();
  return relay(`v1/checkout/${checkoutToken}/transaction-hint`, 'POST', body);
}
