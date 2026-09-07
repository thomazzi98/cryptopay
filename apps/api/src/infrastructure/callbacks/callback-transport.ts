import { Agent, request } from 'undici';

/**
 * Sending one callback, to one address that was already checked.
 *
 * The address is pinned through undici's `connect.lookup`, which is the only part of this that
 * actually closes the DNS rebinding hole. Validating a hostname and then handing the URL to `fetch`
 * leaves the resolver free to answer again at connect time, and answer differently; the check then
 * proves nothing about where the bytes went. A legacy `http.Agent` passed to `fetch` does nothing at
 * all, which is the shape this bug usually ships in.
 *
 * Redirects are not followed, at this layer and again in the retry policy. Following one lets anyone
 * who can influence a merchant's DNS or hosting bounce a signed request to an address the policy
 * refused.
 */

const RESPONSE_SNIPPET_BYTES = 512;

interface CallbackRequest {
  readonly url: string;
  /** The address the policy checked. The connection goes here, whatever the resolver says now. */
  readonly pinnedAddress: string;
  readonly addressFamily: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMilliseconds: number;
}

interface CallbackResponse {
  readonly status: number | null;
  readonly snippet: string | null;
  readonly retryAfterSeconds: number | null;
  readonly durationMilliseconds: number;
  readonly failureReason: string | null;
  readonly timedOut: boolean;
}

export type CallbackTransport = (input: CallbackRequest) => Promise<CallbackResponse>;

function parseRetryAfter(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds >= 0) {
    return seconds;
  }
  // The header also permits an HTTP date. A value we cannot read is treated as absent rather than as
  // zero, because zero would mean retrying immediately against an endpoint asking for room.
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * The shipped transport. Exported as a value rather than built by a factory because it closes over
 * nothing: every request builds its own agent, so there is no shared state to construct.
 */
export const sendCallback: CallbackTransport = async (
  input: CallbackRequest,
): Promise<CallbackResponse> => {
  const startedAt = Date.now();
  // A fresh agent per request, so a pinned address can never be reused by a connection kept alive
  // for a different destination.
  const agent = new Agent({
    connect: {
      // Node's lookup contract has two shapes and undici uses the `all` one. Answering with the
      // single-address shape when an array was asked for hands undici an undefined address, which
      // surfaces as a confusing "Invalid IP address" rather than as a pinning bug.
      lookup: (_hostname, options, callback) => {
        const pinned = { address: input.pinnedAddress, family: input.addressFamily };
        if (options.all === true) {
          callback(null, [pinned] as never);
          return;
        }
        callback(null, pinned.address, pinned.family);
      },
      timeout: input.timeoutMilliseconds,
    },
    headersTimeout: input.timeoutMilliseconds,
    bodyTimeout: input.timeoutMilliseconds,
    // One connection, used once. Nothing is pooled across destinations.
    connections: 1,
    pipelining: 0,
  });

  try {
    const response = await request(input.url, {
      method: 'POST',
      headers: { ...input.headers, 'content-type': 'application/json' },
      body: input.body,
      dispatcher: agent,
    });

    // Undici follows no redirect unless a redirect interceptor is added to the dispatcher, and
    // none is. A 3xx therefore arrives here as a response, and the retry policy classifies it as
    // permanent rather than chasing it.

    const text = await response.body.text();
    return {
      status: response.statusCode,
      snippet: text.slice(0, RESPONSE_SNIPPET_BYTES),
      retryAfterSeconds: parseRetryAfter(response.headers['retry-after']),
      durationMilliseconds: Date.now() - startedAt,
      failureReason: null,
      timedOut: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the request failed';
    const timedOut = reason.toLowerCase().includes('timeout');
    return {
      status: null,
      snippet: null,
      retryAfterSeconds: null,
      durationMilliseconds: Date.now() - startedAt,
      failureReason: reason.slice(0, RESPONSE_SNIPPET_BYTES),
      timedOut,
    };
  } finally {
    await agent.close();
  }
};
