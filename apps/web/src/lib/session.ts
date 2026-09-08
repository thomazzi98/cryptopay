import { cookies } from 'next/headers';

/**
 * Where the merchant's API key lives while they are using the dashboard.
 *
 * In an httpOnly cookie, read only on the server. The dashboard is a client of the same public API a
 * merchant's own server uses, so it has to hold a key; putting that key anywhere JavaScript can read
 * it — localStorage, a context, a prop — means any script that ever runs on the page can take it and
 * create live payments. The cookie is set by the connect form and attached by the proxy; nothing in
 * the browser bundle ever sees its value.
 *
 * There is no accounts table behind this, deliberately. A dashboard that authenticates the same way
 * a merchant's server does is both smaller and a stronger demonstration that the public API is
 * complete: anything the dashboard can do, a merchant can do.
 */

const COOKIE_NAME = 'cryptopay_key';
const SESSION_HOURS = 12;

export interface MerchantSession {
  readonly apiKey: string;
  readonly environment: 'test' | 'live';
}

/** Derived from the key's own prefix rather than stored separately, so the two cannot disagree. */
export function environmentOf(apiKey: string): 'test' | 'live' | null {
  if (apiKey.startsWith('cp_test_')) {
    return 'test';
  }
  if (apiKey.startsWith('cp_live_')) {
    return 'live';
  }
  return null;
}

export async function readSession(): Promise<MerchantSession | null> {
  const store = await cookies();
  const apiKey = store.get(COOKIE_NAME)?.value;
  if (apiKey === undefined || apiKey === '') {
    return null;
  }
  const environment = environmentOf(apiKey);
  if (environment === null) {
    return null;
  }
  return { apiKey, environment };
}

export async function writeSession(apiKey: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, apiKey, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure is conditional only because the local demo runs over plain HTTP; a production build
    // sets it, and the cookie is httpOnly and same-site in both cases.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
