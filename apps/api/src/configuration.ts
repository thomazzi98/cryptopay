import {
  parseAmountToBaseUnits,
  POLYGON_NATIVE_CURRENCY_DECIMALS,
  type NetworkIdentifier,
} from '@cryptopay/shared';
import { z } from 'zod';

/**
 * Configuration is parsed exactly once, at the composition root, and the frozen result is injected.
 * Nothing else reads `process.env`, so there is no place where a wrong value can be picked up later
 * in a code path that signs mainnet transactions.
 *
 * Where a combination is unsafe rather than merely wrong, the process refuses to start. A service
 * that boots into an insecure configuration and logs a warning is a service that runs insecurely,
 * because nobody reads the warning.
 */

const HOST_AND_PORT_PATTERN = /^[a-z\d.-]+:\d{1,5}$/;

/**
 * An unset variable and one set to nothing mean the same thing here.
 *
 * Compose passes every declared variable through, so an optional setting left blank in `.env` arrives
 * as an empty string rather than as absent. Without this, a blank line refuses the whole process with
 * "Invalid URL", which reads as a bad value rather than as no value.
 */
function optionalText(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

const ConfigurationSchema = z
  .object({
    nodeEnvironment: z.enum(['development', 'test', 'production']).default('development'),
    host: z.string().min(1).default('0.0.0.0'),
    port: z.coerce.number().int().min(1).max(65_535).default(3001),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    databaseUrl: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a PostgreSQL connection string',
      }),

    /**
     * Peppers the API key digests. A database copy alone then does not permit offline verification
     * of a stolen key list, because the pepper lives only in the process environment.
     */
    apiKeyPepper: z.string().min(32, 'API_KEY_PEPPER must be at least 32 characters'),

    /** Where the hosted checkout is served from. Payment responses build their checkoutUrl on it. */
    publicCheckoutBaseUrl: z.url().default('http://localhost:3000/pay'),

    /** The base URL the generated OpenAPI document advertises, so a generated client points at it. */
    publicApiBaseUrl: z.url().default('http://localhost:3001'),

    /**
     * Wraps the data key that encrypts each environment's master seed. Whoever can read this value
     * can unwrap every unswept deposit key, which is the largest honest limitation of the current
     * design and is documented rather than disguised.
     */
    walletKeyEncryptionKey: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'WALLET_KEY_ENCRYPTION_KEY must be 32 bytes encoded as base64',
      }),

    /**
     * RPC endpoints per network, in preference order. A network with no endpoint is simply not
     * watched, which is why payment creation refuses a network that has no cursor: accepting money on
     * a chain nothing is scanning would leave the customer's transfer unobserved indefinitely.
     *
     * More than one endpoint buys two things. The first is a fallback transport that moves on when an
     * endpoint is rate limited or lying about being healthy. The second is the finality quorum: the
     * endpoints after the first second the finality opinion, and a payment requiring the finality tag
     * cannot complete without one of them agreeing.
     */
    polygonMainnetRpcUrls: z.array(z.url()).max(8).default([]),
    polygonAmoyRpcUrls: z.array(z.url()).max(8).default([]),
    localAnvilRpcUrls: z.array(z.url()).max(8).default([]),

    /**
     * The token a local development chain deployed. Every other network's asset list is a frozen
     * constant, because a token address that can be set at runtime is a way to redirect what a
     * payment credits; a development chain genuinely redeploys on every start.
     */
    /**
     * A keyless RPC URL per network, safe to hand to a wallet.
     *
     * Separate from the scanning endpoints on purpose. Those may carry a provider key in the path,
     * and `GET /v1/networks` is read by browsers and by other people's servers, so returning one
     * would publish it. A network with no entry here reports a null URL rather than a guess.
     */
    polygonMainnetWalletRpcUrl: z.url().optional(),
    polygonAmoyWalletRpcUrl: z.url().optional(),
    localAnvilWalletRpcUrl: z.url().optional(),

    localAnvilUsdcAddress: z
      .string()
      .regex(/^0x[\da-f]{40}$/, 'Expected a lowercase 0x-prefixed address')
      .optional(),

    /**
     * Whether this deployment may sign and broadcast at all.
     *
     * Off by default, and deliberately a separate switch from having RPC endpoints configured. A
     * deployment that scans and notifies is useful on its own; one that can also move money is a
     * different risk profile, and turning it on should be a decision somebody made rather than a
     * consequence of filling in a URL.
     */
    settlementEnabled: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /**
     * The most native currency each network may ever spend, as a decimal string in whole units.
     *
     * This bounds the blast radius of a bug or a compromise by amount, which nothing else in the
     * system does. An empty value means no ceiling, which is refused in production below: an
     * unbounded signer in production is a decision nobody should be able to make by leaving a
     * variable blank.
     */
    polygonMainnetSpendCeiling: z.string().optional(),
    polygonAmoySpendCeiling: z.string().optional(),
    localAnvilSpendCeiling: z.string().optional(),

    settlementPollIntervalMilliseconds: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(15_000),
    settlementMaximumAttempts: z.coerce.number().int().min(1).max(20).default(5),
    settlementRetryBackoffSeconds: z.coerce.number().int().min(10).max(86_400).default(300),

    scannerPollIntervalMilliseconds: z.coerce.number().int().min(100).max(60_000).default(4000),
    /**
     * How long a scanner lease survives without renewal. Long enough that an ordinary pause does not
     * cause a handover, short enough that a wedged process is replaced before a customer notices.
     */
    scannerLeaseSeconds: z.coerce.number().int().min(5).max(300).default(30),

    /**
     * Explicit `host:port` destinations that bypass only the private-address check when delivering a
     * callback, so the bundled demo receiver can be reached during development.
     *
     * There is deliberately no boolean like ALLOW_LOCALHOST_CALLBACKS. A boolean is one character
     * from a breach and reads as harmless in a diff; an explicit destination list does not. Two
     * independent conditions must both hold before an entry applies, and they are controlled by
     * different people: the deployment must not be production (operations), and the payment must be
     * in the test environment (the merchant's choice of API key).
     */
    callbackPrivateDestinationAllowlist: z
      .array(z.string().regex(HOST_AND_PORT_PATTERN, 'Expected host:port'))
      .max(8)
      .default([]),
  })
  .superRefine((configuration, context) => {
    for (const [field, value] of [
      ['polygonMainnetSpendCeiling', configuration.polygonMainnetSpendCeiling],
      ['polygonAmoySpendCeiling', configuration.polygonAmoySpendCeiling],
      ['localAnvilSpendCeiling', configuration.localAnvilSpendCeiling],
    ] as const) {
      if (value === undefined) {
        continue;
      }
      try {
        parseAmountToBaseUnits(value, POLYGON_NATIVE_CURRENCY_DECIMALS);
      } catch {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `Expected a decimal amount of native currency, for example "0.5". Received "${value}".`,
        });
      }
    }

    // A signer with no ceiling is a signer with no upper bound on what a bug can spend. Development
    // may run without one; production may not, and the process refuses rather than warns.
    if (
      configuration.nodeEnvironment === 'production' &&
      configuration.settlementEnabled &&
      configuration.polygonMainnetSpendCeiling === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['polygonMainnetSpendCeiling'],
        message:
          'POLYGON_MAINNET_SPEND_CEILING must be set when settlement is enabled in production. Refusing to start a signer with no upper bound on what it can spend.',
      });
    }

    if (
      configuration.nodeEnvironment === 'production' &&
      configuration.callbackPrivateDestinationAllowlist.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['callbackPrivateDestinationAllowlist'],
        message:
          'CALLBACK_PRIVATE_DESTINATION_ALLOWLIST must be empty when NODE_ENV=production. Refusing to start rather than allowing a production webhook to reach a private address.',
      });
    }
  });

export type Configuration = z.infer<typeof ConfigurationSchema>;

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export type EnvironmentSource = Record<string, string | undefined>;

export function loadConfiguration(source: EnvironmentSource): Configuration {
  const result = ConfigurationSchema.safeParse({
    nodeEnvironment: source.NODE_ENV,
    host: source.HOST,
    port: source.PORT,
    logLevel: source.LOG_LEVEL,
    databaseUrl: source.DATABASE_URL,
    apiKeyPepper: source.API_KEY_PEPPER,
    publicCheckoutBaseUrl: optionalText(source.PUBLIC_CHECKOUT_BASE_URL),
    publicApiBaseUrl: optionalText(source.PUBLIC_API_BASE_URL),
    walletKeyEncryptionKey: source.WALLET_KEY_ENCRYPTION_KEY,
    polygonMainnetRpcUrls: parseCommaSeparated(source.POLYGON_MAINNET_RPC_URLS),
    polygonAmoyRpcUrls: parseCommaSeparated(source.POLYGON_AMOY_RPC_URLS),
    localAnvilRpcUrls: parseCommaSeparated(source.LOCAL_ANVIL_RPC_URLS),
    polygonMainnetWalletRpcUrl: optionalText(source.POLYGON_MAINNET_WALLET_RPC_URL),
    polygonAmoyWalletRpcUrl: optionalText(source.POLYGON_AMOY_WALLET_RPC_URL),
    localAnvilWalletRpcUrl: optionalText(source.LOCAL_ANVIL_WALLET_RPC_URL),
    localAnvilUsdcAddress: optionalText(source.LOCAL_ANVIL_USDC_ADDRESS),
    settlementEnabled: optionalText(source.SETTLEMENT_ENABLED),
    polygonMainnetSpendCeiling: optionalText(source.POLYGON_MAINNET_SPEND_CEILING),
    polygonAmoySpendCeiling: optionalText(source.POLYGON_AMOY_SPEND_CEILING),
    localAnvilSpendCeiling: optionalText(source.LOCAL_ANVIL_SPEND_CEILING),
    settlementPollIntervalMilliseconds: source.SETTLEMENT_POLL_INTERVAL_MILLISECONDS,
    settlementMaximumAttempts: source.SETTLEMENT_MAXIMUM_ATTEMPTS,
    settlementRetryBackoffSeconds: source.SETTLEMENT_RETRY_BACKOFF_SECONDS,
    scannerPollIntervalMilliseconds: source.SCANNER_POLL_INTERVAL_MILLISECONDS,
    scannerLeaseSeconds: source.SCANNER_LEASE_SECONDS,
    callbackPrivateDestinationAllowlist: parseCommaSeparated(
      source.CALLBACK_PRIVATE_DESTINATION_ALLOWLIST,
    ),
  });

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigurationError(issues);
  }

  return Object.freeze(result.data);
}

/**
 * The endpoints configured for each network, and nothing about which are healthy. A network with an
 * empty list is not watched at all.
 */
export function rpcUrlsFor(
  configuration: Configuration,
  network: NetworkIdentifier,
): readonly string[] {
  const byNetwork: Record<NetworkIdentifier, readonly string[]> = {
    'polygon-mainnet': configuration.polygonMainnetRpcUrls,
    'polygon-amoy': configuration.polygonAmoyRpcUrls,
    'local-anvil': configuration.localAnvilRpcUrls,
  };
  return byNetwork[network];
}

/**
 * The most native currency this network may spend, in base units, or null when unbounded.
 *
 * Configured in whole units because that is how an operator thinks about a budget, and converted
 * once, here, so no caller has to remember how many decimals the native currency has.
 */
export function spendCeilingFor(
  configuration: Configuration,
  network: NetworkIdentifier,
): bigint | null {
  const byNetwork: Record<NetworkIdentifier, string | undefined> = {
    'polygon-mainnet': configuration.polygonMainnetSpendCeiling,
    'polygon-amoy': configuration.polygonAmoySpendCeiling,
    'local-anvil': configuration.localAnvilSpendCeiling,
  };
  const configured = byNetwork[network];
  if (configured === undefined) {
    return null;
  }
  return parseAmountToBaseUnits(configured, POLYGON_NATIVE_CURRENCY_DECIMALS);
}

/**
 * The keyless RPC URL a wallet may be handed for this network, or null when none is configured.
 *
 * Deliberately never falls back to a scanning endpoint: those may carry a provider key, and this
 * value is published to anyone holding an API key.
 */
export function walletRpcUrlFor(
  configuration: Configuration,
  network: NetworkIdentifier,
): string | null {
  const byNetwork: Record<NetworkIdentifier, string | undefined> = {
    'polygon-mainnet': configuration.polygonMainnetWalletRpcUrl,
    'polygon-amoy': configuration.polygonAmoyWalletRpcUrl,
    'local-anvil': configuration.localAnvilWalletRpcUrl,
  };
  return byNetwork[network] ?? null;
}

/** Whether callbacks may currently reach an allowlisted private destination at all. */
export function callbackSsrfPolicy(configuration: Configuration): 'strict' | 'relaxed' {
  if (configuration.callbackPrivateDestinationAllowlist.length === 0) {
    return 'strict';
  }
  return 'relaxed';
}
