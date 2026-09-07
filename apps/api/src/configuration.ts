import type { NetworkIdentifier } from '@cryptopay/shared';
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
    localAnvilUsdcAddress: z
      .string()
      .regex(/^0x[\da-f]{40}$/, 'Expected a lowercase 0x-prefixed address')
      .optional(),

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
    publicCheckoutBaseUrl: source.PUBLIC_CHECKOUT_BASE_URL,
    walletKeyEncryptionKey: source.WALLET_KEY_ENCRYPTION_KEY,
    polygonMainnetRpcUrls: parseCommaSeparated(source.POLYGON_MAINNET_RPC_URLS),
    polygonAmoyRpcUrls: parseCommaSeparated(source.POLYGON_AMOY_RPC_URLS),
    localAnvilRpcUrls: parseCommaSeparated(source.LOCAL_ANVIL_RPC_URLS),
    localAnvilUsdcAddress: source.LOCAL_ANVIL_USDC_ADDRESS,
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

/** Whether callbacks may currently reach an allowlisted private destination at all. */
export function callbackSsrfPolicy(configuration: Configuration): 'strict' | 'relaxed' {
  if (configuration.callbackPrivateDestinationAllowlist.length === 0) {
    return 'strict';
  }
  return 'relaxed';
}
