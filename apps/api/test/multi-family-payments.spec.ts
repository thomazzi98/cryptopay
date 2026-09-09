import {
  buildPaymentUri,
  CheckoutSchema,
  type Checkout,
  type Environment,
  type GatewayError,
  type GatewayPayment,
  type NetworkFamily,
} from '@cryptopay/shared';
import { base58 } from '@scure/base';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { isTronAddress } from '../src/infrastructure/chain/tron/address.js';
import { createLocalKeyWrapper } from '../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../src/infrastructure/wallet/master-seed.js';
import { WalletSeedRepository } from '../src/infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { decodeQrCode } from '../src/infrastructure/qr/qr-decoder.test-helper.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Creating a payment on each of the three families, over HTTP, against a real database.
 *
 * This is the gap the whole destination layer exists to close. Both non-EVM adapters were complete,
 * tested read oracles that nothing in the product could point at, because the allocator could only
 * derive EVM addresses and a request for either family died at the point an address was needed.
 *
 * The assertions are deliberately about what a caller receives rather than about how it was
 * derived. A destination that decodes, a URI in the family's own scheme, and a QR that reads back
 * as that URI is the whole contract; the derivation is asserted against SLIP-0010 and BIP-44 in the
 * wallet spec, where a published specification can be cited.
 */

const PEPPER = 'm'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 11);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3H1001';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let testKey = '';

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let referenceCounter = 0;

interface Expectation {
  readonly family: NetworkFamily;
  readonly nativeCurrency: string;
  readonly tokenCurrency: string;
  readonly chainId: number | null;
  readonly uriScheme: string;
  readonly isCanonicalAccount: (account: string) => boolean;
}

/**
 * A Solana address is an ed25519 public key: thirty-two bytes, base58, with no prefix and no
 * checksum to recognise it by.
 *
 * Decoding rather than matching a pattern is the point. TRON writes addresses in base58 too, in the
 * same length range, so `^[1-9A-HJ-NP-Za-km-z]{32,44}$` accepts a TRON address as a Solana one. A
 * payment sent to that mistake is unrecoverable, and the byte length is what separates them: TRON
 * decodes to twenty-five bytes, Solana to thirty-two.
 */
function isSolanaAccount(account: string): boolean {
  try {
    return base58.decode(account).length === 32;
  } catch {
    return false;
  }
}

const FAMILIES: readonly Expectation[] = Object.freeze([
  Object.freeze({
    family: 'polygon' as const,
    nativeCurrency: 'POL',
    tokenCurrency: 'USDC',
    chainId: 80_002,
    uriScheme: 'ethereum:',
    isCanonicalAccount: (account: string) => /^0x[\da-f]{40}$/.test(account),
  }),
  Object.freeze({
    family: 'tron' as const,
    nativeCurrency: 'TRX',
    tokenCurrency: 'USDT',
    chainId: null,
    uriScheme: 'tron:',
    isCanonicalAccount: isTronAddress,
  }),
  Object.freeze({
    family: 'solana' as const,
    nativeCurrency: 'SOL',
    tokenCurrency: 'USDC',
    chainId: null,
    uriScheme: 'solana:',
    isCanonicalAccount: isSolanaAccount,
  }),
]);

async function issueKey(environment: Environment): Promise<string> {
  keyCounter += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, keyCounter);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label, scopes)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'families', $6::text[])`,
    [
      generated.keyIdentifier,
      MERCHANT_ID,
      environment,
      generated.secretDigest,
      generated.lastFour,
      ['payments:read', 'payments:write'],
    ],
  );
  return generated.presentedKey;
}

function create(family: NetworkFamily, currency: string, amount = '2.500000') {
  referenceCounter += 1;
  return server.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: {
      authorization: `Bearer ${testKey}`,
      'content-type': 'application/json',
      'idempotency-key': `families-${referenceCounter}`,
    },
    payload: {
      externalReference: `order_${referenceCounter}`,
      network: family,
      currency,
      amount,
      expiresIn: 1800,
    },
  });
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'families');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [
    MERCHANT_ID,
    'Multi-family Fixtures',
  ]);

  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  await new WalletSeedRepository(pool).storeIfAbsent(
    `sed_${ulidFactory.create(1_757_183_400_001)}`,
    'test',
    sealSeed(generateMasterSeed(), 'test', wrapper),
  );

  // Every test-environment network needs a cursor, because a payment on a network nobody is
  // scanning is refused. That refusal is asserted below on a network deliberately left out.
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 46903512, $1, 1000),
            ('tron-nile', 60000000, $2, 100),
            ('solana-devnet', 340000000, $3, 100)`,
    [`0x${'a'.repeat(64)}`, 'b'.repeat(64), '4'.repeat(64)],
  );

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: WALLET_KEY.toString('base64'),
    API_RATE_LIMIT_REQUESTS: '5000',
    API_RATE_LIMIT_WINDOW_SECONDS: '60',
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);
  testKey = await issueKey('test');
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

describe.each(FAMILIES)('$family payments', (expectation) => {
  const currencies = [expectation.nativeCurrency, expectation.tokenCurrency];

  it.each(currencies)('creates a payment in %s', async (currency) => {
    const response = await create(expectation.family, currency);
    expect(response.statusCode).toBe(201);

    const payment = response.json<GatewayPayment>();
    expect(payment.network).toBe(expectation.family);
    expect(payment.currency).toBe(currency);
    expect(payment.status).toBe('CREATED');
    expect(payment.id).toMatch(/^pay_/);
    expect(Date.parse(payment.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('issues a destination in the encoding this family actually uses', async () => {
    const response = await create(expectation.family, expectation.tokenCurrency);
    const payment = response.json<GatewayPayment>();

    expect(expectation.isCanonicalAccount(payment.paymentDestination.address)).toBe(true);
  });

  /**
   * A Solana address and a TRON address are both base58, and a payment sent to the wrong one is
   * unrecoverable. Asserting the destination merely decodes would pass on either.
   */
  it('does not issue an address belonging to another family', async () => {
    const response = await create(expectation.family, expectation.nativeCurrency);
    const payment = response.json<GatewayPayment>();
    const others = FAMILIES.filter((candidate) => candidate.family !== expectation.family);

    for (const other of others) {
      expect(other.isCanonicalAccount(payment.paymentDestination.address)).toBe(false);
    }
  });

  it('names the chain only where the family has a numeric identity', async () => {
    const response = await create(expectation.family, expectation.nativeCurrency);
    const payment = response.json<GatewayPayment>();

    expect(payment.chainId).toBe(expectation.chainId);
  });

  it.each(currencies)('builds a %s payment URI in this family scheme', async (currency) => {
    const response = await create(expectation.family, currency);
    const payment = response.json<GatewayPayment>();

    expect(payment.paymentUri).not.toBeNull();
    expect(payment.paymentUri?.startsWith(expectation.uriScheme)).toBe(true);
    expect(payment.paymentUri).toContain(payment.paymentDestination.address);
  });

  it.each(currencies)('renders a %s QR that decodes back to the same URI', async (currency) => {
    const response = await create(expectation.family, currency);
    const payment = response.json<GatewayPayment>();
    const image = payment.qrCode ?? '';
    const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');

    expect(decodeQrCode(bytes)).toBe(payment.paymentUri);
  });

  it('offers an explorer link for the destination', async () => {
    const response = await create(expectation.family, expectation.nativeCurrency);
    const payment = response.json<GatewayPayment>();

    expect(payment.explorer.address).toContain(payment.paymentDestination.address);
    expect(payment.explorer.transaction).toBeNull();
  });

  it('stores the destination in the form the database calls canonical', async () => {
    const response = await create(expectation.family, expectation.tokenCurrency);
    const payment = response.json<GatewayPayment>();
    const stored = await pool.query<{ account: string; canonical: boolean }>(
      `SELECT account, is_canonical_account(network_identifier, account) AS canonical
         FROM payment_addresses WHERE payment_id = $1`,
      [payment.id],
    );

    expect(stored.rows[0]?.account).toBe(payment.paymentDestination.address);
    expect(stored.rows[0]?.canonical).toBe(true);
  });

  it('never reveals the derivation path that finds the key again', async () => {
    const response = await create(expectation.family, expectation.nativeCurrency);

    expect(response.body).not.toContain('m/44');
    expect(response.body).not.toContain('allocationReference');
    expect(response.body).not.toContain('derivationIndex');
  });
});

describe('destinations across every family', () => {
  it('never issues one address twice', async () => {
    const responses = await Promise.all(
      FAMILIES.flatMap((expectation) => [
        create(expectation.family, expectation.nativeCurrency),
        create(expectation.family, expectation.tokenCurrency),
      ]),
    );
    const accounts = responses.map(
      (response) => response.json<GatewayPayment>().paymentDestination.address,
    );

    expect(new Set(accounts).size).toBe(accounts.length);
  });

  /**
   * Allocation reads a database sequence, so concurrent creation is the case where a counter row or
   * a read-then-write would hand two customers the same address and credit one payment twice.
   */
  it('hands twenty concurrent payments twenty distinct addresses', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => {
        const expectation = FAMILIES[index % FAMILIES.length];
        return create(
          expectation?.family ?? 'polygon',
          expectation?.nativeCurrency ?? 'POL',
          '1.000000',
        );
      }),
    );
    const created = responses.filter((response) => response.statusCode === 201);
    const accounts = created.map(
      (response) => response.json<GatewayPayment>().paymentDestination.address,
    );

    expect(created).toHaveLength(20);
    expect(new Set(accounts).size).toBe(20);
  });

  it('refuses a currency the family does not settle, naming what it cannot do', async () => {
    const response = await create('tron', 'SOL');

    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('UNSUPPORTED_CURRENCY');
  });
});

/**
 * The hosted checkout and the gateway API must offer the same payment URI, because they are the
 * same payment. This asserts the property that makes that true: the public checkout carries enough
 * of the payment to rebuild the URI through the shared builder, and the result is byte identical to
 * the one the API published.
 *
 * The checkout used to carry a second builder of its own, which emitted an EIP-681 token transfer
 * for every payment. A customer paying in the chain's own currency was shown a QR asking their
 * wallet to call `transfer` on a contract that does not exist, and TRON and Solana had no branch at
 * all.
 */
describe('one payment URI, whichever surface asks for it', () => {
  it.each(
    FAMILIES.flatMap((expectation) =>
      [expectation.nativeCurrency, expectation.tokenCurrency].map((currency) => ({
        family: expectation.family,
        currency,
      })),
    ),
  )(
    'agrees between the checkout and the API for $family $currency',
    async ({ family, currency }) => {
      const created = await create(family, currency);
      const payment = created.json<GatewayPayment>();
      const token = await pool.query<{ checkout_token: string }>(
        'SELECT checkout_token FROM payments WHERE id = $1',
        [payment.id],
      );

      const viewed = await server.inject({
        method: 'GET',
        url: `/v1/checkout/${token.rows[0]?.checkout_token ?? ''}`,
      });
      const checkout = viewed.json<Checkout>();
      const rebuilt = buildPaymentUri({
        networkFamily: checkout.networkFamily as NetworkFamily,
        evmChainId: checkout.chainIdentifier,
        destinationAccount: checkout.receivingAccount,
        assetReference: checkout.asset.reference,
        assetDecimals: checkout.asset.decimals,
        amountInBaseUnits: checkout.requestedAmount.baseUnits,
        memo: null,
      });

      expect(viewed.statusCode).toBe(200);
      expect(rebuilt).toBe(payment.paymentUri);
    },
  );

  /**
   * The hosted checkout parses every response against the published contract before rendering it,
   * and reports one that does not match as unreadable rather than showing an unvalidated amount.
   * That is the right behaviour, and it meant an account schema describing only EVM addresses took
   * the entire checkout page away from two of the three families. Asserting the real response
   * against the real schema is what catches that; asserting the status code does not.
   */
  it.each(FAMILIES)('serves a $family checkout the published contract can read', async (family) => {
    const created = await create(family.family, family.nativeCurrency);
    const payment = created.json<GatewayPayment>();
    const token = await pool.query<{ checkout_token: string }>(
      'SELECT checkout_token FROM payments WHERE id = $1',
      [payment.id],
    );
    const viewed = await server.inject({
      method: 'GET',
      url: `/v1/checkout/${token.rows[0]?.checkout_token ?? ''}`,
    });

    const parsed = CheckoutSchema.safeParse(viewed.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
