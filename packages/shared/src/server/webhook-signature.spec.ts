import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateSigningSecret,
  signWebhook,
  verifyWebhook,
  type WebhookSignatureHeaders,
} from './webhook-signature.js';

/**
 * The signature is the only thing standing between a merchant's endpoint and anyone who knows its
 * URL. These tests are written from the receiver's side, because that is where a mistake is
 * exploitable rather than merely inconvenient.
 */

const SECRET = 'whsec_c2VjcmV0LWtleS1tYXRlcmlhbC10aGlydHktdHdvLWI=';
const OTHER_SECRET = 'whsec_YW5vdGhlci1zZWNyZXQta2V5LW1hdGVyaWFsLTMyLQ==';
const IDENTIFIER = 'whd_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const NOW = 1_788_000_000;
const BODY = '{"type":"payment.completed","data":{"id":"pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N"}}';

function headersOf(overrides: Partial<WebhookSignatureHeaders> = {}): Record<string, string> {
  return {
    ...signWebhook({ identifier: IDENTIFIER, timestamp: NOW, body: BODY, secrets: [SECRET] }),
    ...overrides,
  };
}

describe('signing a webhook', () => {
  it('emits the three Standard Webhooks headers', () => {
    const headers = headersOf();
    expect(headers['webhook-id']).toBe(IDENTIFIER);
    expect(headers['webhook-timestamp']).toBe(NOW.toString());
    expect(headers['webhook-signature']).toMatch(/^v1,[\w+/=]+$/);
  });

  /**
   * Matching the published scheme byte for byte is the whole point of using it: a merchant verifies
   * with `svix` or `standardwebhooks` on day one and never reads our documentation.
   */
  it('signs the id, the timestamp and the body, in that order, separated by dots', () => {
    const expected = createHmac('sha256', Buffer.from(SECRET.slice('whsec_'.length), 'base64'))
      .update(`${IDENTIFIER}.${NOW.toString()}.${BODY}`)
      .digest('base64');
    expect(headersOf()['webhook-signature']).toBe(`v1,${expected}`);
  });

  /**
   * The id is the merchant's idempotency key. A retry that changed it would be processed as a second
   * event, which for a payment notification means shipping the order twice.
   */
  it('keeps the id byte-identical across attempts', () => {
    const first = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW,
      body: BODY,
      secrets: [SECRET],
    });
    const retry = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW + 3600,
      body: BODY,
      secrets: [SECRET],
    });
    expect(retry['webhook-id']).toBe(first['webhook-id']);
  });

  /**
   * The mirror of the rule above, and the one implementations get wrong. Reusing the event's original
   * timestamp makes every retry past the tolerance window fail verification, so a merchant who was
   * briefly down can never be told what happened.
   */
  it('regenerates the timestamp on every attempt', () => {
    const retry = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW + 3600,
      body: BODY,
      secrets: [SECRET],
    });
    expect(retry['webhook-timestamp']).toBe((NOW + 3600).toString());
    expect(retry['webhook-signature']).not.toBe(headersOf()['webhook-signature']);
  });

  it('presents one signature per secret during a rotation', () => {
    const rotating = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW,
      body: BODY,
      secrets: [OTHER_SECRET, SECRET],
    });
    expect(rotating['webhook-signature'].split(' ')).toHaveLength(2);
  });
});

describe('verifying a webhook', () => {
  it('accepts a signature it produced', () => {
    expect(
      verifyWebhook({ headers: headersOf(), body: BODY, secrets: [SECRET], now: NOW }),
    ).toEqual({ kind: 'valid' });
  });

  it('accepts either secret while a rotation is in progress', () => {
    const signed = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW,
      body: BODY,
      secrets: [OTHER_SECRET],
    });
    expect(
      verifyWebhook({ headers: signed, body: BODY, secrets: [SECRET, OTHER_SECRET], now: NOW }),
    ).toEqual({ kind: 'valid' });
  });

  /**
   * The body is compared as received, never re-serialized. `JSON.parse` then `JSON.stringify`
   * reorders keys and drops insignificant whitespace, and the signature then never matches anything.
   */
  it('rejects a body altered by a single character', () => {
    const tampered = BODY.replace('completed', 'overpaid');
    expect(
      verifyWebhook({ headers: headersOf(), body: tampered, secrets: [SECRET], now: NOW }).kind,
    ).toBe('invalid');
  });

  it('rejects a signature made with a different secret', () => {
    expect(
      verifyWebhook({ headers: headersOf(), body: BODY, secrets: [OTHER_SECRET], now: NOW }).kind,
    ).toBe('invalid');
  });

  it('rejects a signature moved onto a different event id', () => {
    const moved = { ...headersOf(), 'webhook-id': 'whd_01K4QW6ZR2M8X4T7YQ0C3D5B9P' };
    expect(verifyWebhook({ headers: moved, body: BODY, secrets: [SECRET], now: NOW }).kind).toBe(
      'invalid',
    );
  });

  it('rejects a captured request replayed after the tolerance window', () => {
    expect(
      verifyWebhook({ headers: headersOf(), body: BODY, secrets: [SECRET], now: NOW + 301 }).kind,
    ).toBe('invalid');
  });

  /**
   * Bounded in both directions. Rejecting only old timestamps leaves a forged future timestamp valid
   * indefinitely, which is a replay window that never closes.
   */
  it('rejects a timestamp from the future', () => {
    expect(
      verifyWebhook({ headers: headersOf(), body: BODY, secrets: [SECRET], now: NOW - 301 }).kind,
    ).toBe('invalid');
  });

  it('accepts an attempt at the edge of the window, because a slow retry is not an attack', () => {
    expect(
      verifyWebhook({ headers: headersOf(), body: BODY, secrets: [SECRET], now: NOW + 299 }).kind,
    ).toBe('valid');
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'rejects a request with no %s header',
    (missing) => {
      const headers = headersOf();
      delete headers[missing];
      expect(verifyWebhook({ headers, body: BODY, secrets: [SECRET], now: NOW }).kind).toBe(
        'invalid',
      );
    },
  );

  it('rejects a timestamp that is not a number at all', () => {
    const headers = { ...headersOf(), 'webhook-timestamp': 'yesterday' };
    expect(verifyWebhook({ headers, body: BODY, secrets: [SECRET], now: NOW }).kind).toBe(
      'invalid',
    );
  });

  it('rejects a signature presented under an unknown version', () => {
    const headers = { ...headersOf() };
    headers['webhook-signature'] = headers['webhook-signature']?.replace('v1,', 'v9,') ?? '';
    expect(verifyWebhook({ headers, body: BODY, secrets: [SECRET], now: NOW }).kind).toBe(
      'invalid',
    );
  });

  it('rejects an empty secret list rather than accepting anything', () => {
    expect(verifyWebhook({ headers: headersOf(), body: BODY, secrets: [], now: NOW }).kind).toBe(
      'invalid',
    );
  });

  it('accepts when one of several presented signatures matches', () => {
    const headers = { ...headersOf() };
    headers['webhook-signature'] = `v1,ZmFrZXNpZ25hdHVyZQ== ${headers['webhook-signature'] ?? ''}`;
    expect(verifyWebhook({ headers, body: BODY, secrets: [SECRET], now: NOW }).kind).toBe('valid');
  });

  it('explains every refusal, because a merchant debugging this has no other signal', () => {
    const verification = verifyWebhook({
      headers: headersOf(),
      body: 'tampered',
      secrets: [SECRET],
      now: NOW,
    });
    expect(verification.kind === 'invalid' && verification.reason !== '').toBe(true);
  });
});

describe('generating a signing secret', () => {
  it('is prefixed so it is recognisable in a log or a support ticket', () => {
    expect(generateSigningSecret().startsWith('whsec_')).toBe(true);
  });

  it('carries 32 bytes of randomness', () => {
    const secret = generateSigningSecret();
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toHaveLength(32);
  });

  it('never repeats', () => {
    const generated = new Set(Array.from({ length: 200 }, () => generateSigningSecret()));
    expect(generated.size).toBe(200);
  });

  it('produces a secret that round-trips through signing and verification', () => {
    const secret = generateSigningSecret();
    const headers = signWebhook({
      identifier: IDENTIFIER,
      timestamp: NOW,
      body: BODY,
      secrets: [secret],
    });
    expect(verifyWebhook({ headers, body: BODY, secrets: [secret], now: NOW }).kind).toBe('valid');
  });
});
