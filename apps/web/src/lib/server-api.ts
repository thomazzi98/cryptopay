/**
 * Server-side reads, used where the first paint has to already contain the answer.
 *
 * The checkout page is the only caller, and it is the reason this exists. A customer opening it sees
 * the amount, the network and the countdown in the first frame rather than after a round trip, which
 * matters because they are about to move money and a page that fills in piecemeal reads as
 * untrustworthy.
 *
 * The dashboard deliberately does not use this. A payment's status changes while it is on screen, so
 * those screens poll through the browser proxy; server rendering a value that goes stale in four
 * seconds buys nothing and costs a round trip on every navigation.
 */

const API_BASE_URL = process.env.CRYPTOPAY_API_URL ?? 'http://127.0.0.1:3001';

export class ServerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ServerApiError';
    this.status = status;
  }
}

/** Reads a public endpoint, with no credential attached. The checkout token is the only credential. */
export async function fetchPublic<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new ServerApiError(response.status, `The API answered ${response.status.toString()}`);
  }
  return (await response.json()) as T;
}
