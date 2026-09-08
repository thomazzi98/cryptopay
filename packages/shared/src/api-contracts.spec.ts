import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AccountSchema,
  AmountSchema,
  AssetSchema,
  CallbackUrlSchema,
  CheckoutSchema,
  CreatePaymentRequestSchema,
  ListPaymentsQuerySchema,
  MetadataSchema,
  PaymentIdentifierSchema,
  PaymentSchema,
  ProblemDetailsSchema,
  TransactionHintRequestSchema,
} from './api-contracts.js';

const VALID_IDENTIFIER = 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const VALID_ACCOUNT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';

describe('payment identifiers', () => {
  it('accepts a prefixed ULID', () => {
    expect(PaymentIdentifierSchema.safeParse(VALID_IDENTIFIER).success).toBe(true);
  });

  it.each([
    { description: 'the wrong prefix', candidate: 'whd_01K4QW6ZR2M8X4T7YQ0C3D5B9N' },
    { description: 'no prefix', candidate: '01K4QW6ZR2M8X4T7YQ0C3D5B9N' },
    { description: 'a truncated ULID', candidate: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9' },
    { description: 'lowercase base32', candidate: 'pay_01k4qw6zr2m8x4t7yq0c3d5b9n' },
    // I, L, O and U are excluded from Crockford base32 to avoid transcription errors.
    { description: 'an excluded letter', candidate: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5BIL' },
    { description: 'an empty string', candidate: '' },
  ])('rejects $description', ({ candidate }) => {
    expect(PaymentIdentifierSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('accounts', () => {
  it('accepts a lowercase address', () => {
    expect(AccountSchema.safeParse(VALID_ACCOUNT).success).toBe(true);
  });

  it('rejects a checksummed address, because storage and comparison are lowercase', () => {
    expect(AccountSchema.safeParse(getAddress(VALID_ACCOUNT)).success).toBe(false);
  });

  it('rejects a truncated address', () => {
    expect(AccountSchema.safeParse('0xabc').success).toBe(false);
  });
});

describe('amounts', () => {
  it('accepts both representations together', () => {
    expect(AmountSchema.safeParse({ baseUnits: '25000000', display: '25.000000' }).success).toBe(
      true,
    );
  });

  it.each([
    {
      description: 'a JSON number for base units',
      value: { baseUnits: 25_000_000, display: '25.0' },
    },
    { description: 'a decimal in base units', value: { baseUnits: '25.0', display: '25.0' } },
    { description: 'a negative amount', value: { baseUnits: '-1', display: '-1.0' } },
    { description: 'exponent notation', value: { baseUnits: '25e6', display: '25.0' } },
    { description: 'a missing display value', value: { baseUnits: '25000000' } },
  ])('rejects $description', ({ value }) => {
    expect(AmountSchema.safeParse(value).success).toBe(false);
  });

  it('is the only accepted amount shape, so no endpoint can return a bare number', () => {
    const amountFields = Object.entries(PaymentSchema.shape).filter(([name]) =>
      name.toLowerCase().includes('amount'),
    );
    expect(amountFields.length).toBeGreaterThan(0);
    for (const [, schema] of amountFields) {
      expect(schema.safeParse(25_000_000).success).toBe(false);
    }
  });
});

describe('assets', () => {
  it('accepts a six-decimal token', () => {
    expect(
      AssetSchema.safeParse({
        reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
        symbol: 'USDC',
        decimals: 6,
      }).success,
    ).toBe(true);
  });

  it('rejects a fractional or negative decimals value', () => {
    const base = { reference: '0xabc', symbol: 'USDC' };
    expect(AssetSchema.safeParse({ ...base, decimals: 6.5 }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...base, decimals: -1 }).success).toBe(false);
  });
});

describe('metadata', () => {
  it('accepts merchant key/value pairs', () => {
    expect(MetadataSchema.safeParse({ orderId: 'order-10422' }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(MetadataSchema.safeParse({}).success).toBe(true);
  });

  it('rejects more than thirty-two entries', () => {
    const oversized: Record<string, string> = {};
    for (let index = 0; index < 33; index += 1) {
      oversized[`key${index}`] = `value-${index}`;
    }
    expect(MetadataSchema.safeParse(oversized).success).toBe(false);
  });

  it('rejects an oversized value', () => {
    expect(MetadataSchema.safeParse({ note: 'x'.repeat(513) }).success).toBe(false);
  });

  it('rejects a nested object, so metadata cannot smuggle structure', () => {
    expect(MetadataSchema.safeParse({ nested: { deep: 'value' } }).success).toBe(false);
  });
});

describe('create payment request', () => {
  const valid = { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00' };

  it('accepts the minimum viable request', () => {
    expect(CreatePaymentRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts optional merchant fields', () => {
    const result = CreatePaymentRequestSchema.safeParse({
      ...valid,
      callbackUrl: 'https://merchant.example.com/webhooks/cryptopay',
      merchantReference: 'order-10422',
      metadata: { cartIdentifier: 'c_88213' },
      expiresInSeconds: 1800,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    { description: 'an unknown network', patch: { network: 'ethereum-mainnet' } },
    { description: 'an amount as a number', patch: { amount: 25 } },
    { description: 'a negative amount', patch: { amount: '-25.00' } },
    { description: 'a non-web callback url', patch: { callbackUrl: 'ftp://example.com/hook' } },
    { description: 'a malformed callback url', patch: { callbackUrl: 'not-a-url' } },
    { description: 'an expiry below one minute', patch: { expiresInSeconds: 59 } },
    { description: 'an expiry beyond a day', patch: { expiresInSeconds: 86_401 } },
  ])('rejects $description', ({ patch }) => {
    expect(CreatePaymentRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  // The callbackUrl is re-validated against the full SSRF policy before every delivery attempt;
  // the schema only enforces shape.
  it('accepts an https callback url at the schema layer', () => {
    const result = CreatePaymentRequestSchema.safeParse({
      ...valid,
      callbackUrl: 'https://example.com/hook',
    });
    expect(result.success).toBe(true);
  });
});

/**
 * The schema checks the shape and nothing else.
 *
 * Requiring https, a fully qualified hostname and no internal suffix are all real rules, and they
 * live in the server's destination policy rather than here, because a development deployment may
 * name one exact private destination it is permitted to reach and a browser-safe schema cannot know
 * which. Keeping one implementation is what stops the two disagreeing; the server applies it when
 * the payment is created and again before every delivery attempt.
 */
describe('the shape of a callback url', () => {
  it('accepts an https merchant endpoint', () => {
    expect(
      CallbackUrlSchema.safeParse('https://merchant.example.com/webhooks/cryptopay').success,
    ).toBe(true);
  });

  it.each([
    { description: 'a non-web scheme', candidate: 'ftp://merchant.example.com/hook' },
    { description: 'a javascript url', candidate: 'javascript:alert(1)' },
    {
      description: 'embedded credentials',
      candidate: 'https://user:password@merchant.example.com/h',
    },
    { description: 'a bare IPv4 literal', candidate: 'https://169.254.169.254/hook' },
    { description: 'a bracketed IPv6 literal', candidate: 'https://[::1]/hook' },
    { description: 'text that is not a url', candidate: 'not-a-url' },
    { description: 'an empty string', candidate: '' },
  ])('rejects $description', ({ candidate }) => {
    expect(CallbackUrlSchema.safeParse(candidate).success).toBe(false);
  });

  /**
   * Accepted by the shape check and refused by the server. Asserting that here is what keeps the
   * split honest: these are not permitted, they are simply decided somewhere that knows the
   * deployment.
   */
  it.each([
    'http://merchant.example.com/hook',
    'https://localhost/hook',
    'https://buildserver.internal/hook',
    'https://printer.local/hook',
  ])('leaves %s for the server to decide', (candidate) => {
    expect(CallbackUrlSchema.safeParse(candidate).success).toBe(true);
  });

  // WHATWG parsing normalises the whole IPv4 encoding family before any check runs, which is why
  // no custom decoder is written. Each of these arrives at the checks as 127.0.0.1.
  it.each([
    { description: 'decimal', candidate: 'https://2130706433/hook' },
    { description: 'octal', candidate: 'https://0177.0.0.1/hook' },
    { description: 'short form', candidate: 'https://127.1/hook' },
  ])('rejects loopback written in $description form', ({ candidate }) => {
    expect(CallbackUrlSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects a url beyond the length limit', () => {
    const oversized = `https://merchant.example.com/${'a'.repeat(2100)}`;
    expect(CallbackUrlSchema.safeParse(oversized).success).toBe(false);
  });

  it('explains why it refused, so a merchant can fix it', () => {
    const result = CallbackUrlSchema.safeParse('ftp://merchant.example.com/hook');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('http');
  });
});

describe('list payments query', () => {
  it('defaults the page size', () => {
    const result = ListPaymentsQuerySchema.parse({});
    expect(result.limit).toBe(25);
  });

  it('coerces a query-string limit', () => {
    expect(ListPaymentsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the page size', () => {
    expect(ListPaymentsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('rejects a cursor that is not a payment identifier', () => {
    expect(ListPaymentsQuerySchema.safeParse({ startingAfter: 'whd_01K4QW' }).success).toBe(false);
  });
});

describe('the public checkout view', () => {
  // These fields are absent from the type rather than stripped by a presenter, so no future change
  // can leak them by forgetting to call something.
  it.each(['metadata', 'callbackUrl', 'merchantReference', 'identifier', 'checkoutUrl'])(
    'has no %s field',
    (field) => {
      expect(Object.keys(CheckoutSchema.shape)).not.toContain(field);
    },
  );

  it('exposes what a customer needs to pay', () => {
    const fields = Object.keys(CheckoutSchema.shape);
    for (const required of [
      'receivingAccount',
      'requestedAmount',
      'asset',
      'chainIdentifier',
      'confirmations',
      'requiredConfirmations',
      'expiresAt',
    ]) {
      expect(fields).toContain(required);
    }
  });
});

describe('no contract can express key material', () => {
  const FORBIDDEN = [
    'allocationReference',
    'derivationIndex',
    'derivationPath',
    'privateKey',
    'mnemonic',
    'masterSeed',
    'secretDigest',
    'signingSecret',
  ];

  it.each([
    { name: 'Payment', schema: PaymentSchema },
    { name: 'Checkout', schema: CheckoutSchema },
  ])('$name declares no sensitive field', ({ schema }) => {
    const fields = Object.keys(schema.shape);
    for (const forbidden of FORBIDDEN) {
      expect(fields).not.toContain(forbidden);
    }
  });
});

describe('transaction hint', () => {
  it('accepts a transaction hash', () => {
    expect(
      TransactionHintRequestSchema.safeParse({ transactionReference: `0x${'a'.repeat(64)}` })
        .success,
    ).toBe(true);
  });

  it('rejects a checksummed or truncated hash', () => {
    expect(
      TransactionHintRequestSchema.safeParse({ transactionReference: `0x${'A'.repeat(64)}` })
        .success,
    ).toBe(false);
    expect(
      TransactionHintRequestSchema.safeParse({ transactionReference: `0x${'a'.repeat(63)}` })
        .success,
    ).toBe(false);
  });
});

describe('problem details', () => {
  it('accepts an RFC 9457 body', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: 'https://cryptopay.dev/problems/invalid-payment-transition',
      title: 'Invalid payment transition',
      status: 409,
      detail: 'A completed payment cannot move to pending.',
      code: 'invalid_payment_transition',
      requestId: 'req_01K4QW',
    });
    expect(result.success).toBe(true);
  });

  it('requires a machine-readable code, because clients must not branch on prose', () => {
    expect(
      ProblemDetailsSchema.safeParse({
        type: 'about:blank',
        title: 'Oops',
        status: 500,
        detail: 'something failed',
        requestId: 'req_01K4QW',
      }).success,
    ).toBe(false);
  });

  it('rejects a status outside the error range', () => {
    const base = {
      type: 'about:blank',
      title: 'x',
      detail: 'x',
      code: 'x',
      requestId: 'r',
    };
    expect(ProblemDetailsSchema.safeParse({ ...base, status: 200 }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base, status: 600 }).success).toBe(false);
  });
});
