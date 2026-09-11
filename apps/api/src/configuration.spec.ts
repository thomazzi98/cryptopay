import { describe, expect, it } from 'vitest';

import {
  callbackSsrfPolicy,
  ConfigurationError,
  type EnvironmentSource,
  loadConfiguration,
  spendCeilingFor,
  walletRpcUrlFor,
} from './configuration.js';

const REQUIRED: EnvironmentSource = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://cryptopay:cryptopay@127.0.0.1:5432/cryptopay',
  API_KEY_PEPPER: 'a'.repeat(32),
  WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
};

function environment(overrides: EnvironmentSource = {}): EnvironmentSource {
  return { ...REQUIRED, ...overrides };
}

function load(overrides: EnvironmentSource = {}) {
  return loadConfiguration(environment(overrides));
}

const loadWithOversizedPort = () => load({ PORT: '70000' });

const loadProductionWithPrivateAllowlist = () =>
  loadConfiguration({
    ...REQUIRED,
    NODE_ENV: 'production',
    CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: '127.0.0.1:4001',
  });

describe('loadConfiguration', () => {
  it('applies defaults for everything optional', () => {
    const configuration = loadConfiguration(environment());
    expect(configuration.host).toBe('0.0.0.0');
    expect(configuration.port).toBe(3001);
    expect(configuration.logLevel).toBe('info');
    expect(configuration.callbackPrivateDestinationAllowlist).toStrictEqual([]);
  });

  it('is frozen, so nothing can mutate configuration after startup', () => {
    const configuration = load();
    expect(Object.isFrozen(configuration)).toBe(true);
  });

  it('coerces a port supplied as a string, because every environment variable is one', () => {
    expect(loadConfiguration(environment({ PORT: '8080' })).port).toBe(8080);
  });

  it.each([
    { description: 'a missing database url', variables: { DATABASE_URL: undefined } },
    {
      description: 'a database url for another engine',
      variables: { DATABASE_URL: 'mysql://x/y' },
    },
    { description: 'a short api key pepper', variables: { API_KEY_PEPPER: 'too-short' } },
    { description: 'a missing wallet key', variables: { WALLET_KEY_ENCRYPTION_KEY: undefined } },
    {
      description: 'a wallet key of the wrong size',
      variables: { WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') },
    },
    { description: 'a port above the valid range', variables: { PORT: '70000' } },
    { description: 'a port that is not a number', variables: { PORT: 'http' } },
    { description: 'an unknown log level', variables: { LOG_LEVEL: 'chatty' } },
    { description: 'an unknown node environment', variables: { NODE_ENV: 'staging' } },
    { description: 'an empty host', variables: { HOST: '' } },
  ])('refuses to start with $description', ({ variables }) => {
    expect(() => loadConfiguration(environment(variables))).toThrow(ConfigurationError);
  });

  it('names the offending variable, so the failure is actionable', () => {
    expect(loadWithOversizedPort).toThrow(/port/i);
  });
});

describe('the callback private destination allowlist', () => {
  it('is empty when unset', () => {
    expect(loadConfiguration(environment()).callbackPrivateDestinationAllowlist).toStrictEqual([]);
  });

  it('parses a comma separated list and trims each entry', () => {
    const configuration = loadConfiguration(
      environment({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: 'demo-receiver:4001, 127.0.0.1:4001' }),
    );
    expect(configuration.callbackPrivateDestinationAllowlist).toStrictEqual([
      'demo-receiver:4001',
      '127.0.0.1:4001',
    ]);
  });

  it.each([
    { description: 'a bare hostname with no port', entry: 'demo-receiver' },
    { description: 'a full URL', entry: 'http://demo-receiver:4001' },
    { description: 'a path', entry: 'demo-receiver:4001/callbacks' },
  ])('rejects $description', ({ entry }) => {
    expect(() =>
      loadConfiguration(environment({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: entry })),
    ).toThrow(ConfigurationError);
  });

  /**
   * The security control this milestone exists to prove. A deployment that allows webhooks to reach
   * a private address must not be able to start in production, whatever else is configured.
   */
  it('refuses to start in production with a non-empty allowlist', () => {
    expect(loadProductionWithPrivateAllowlist).toThrow(ConfigurationError);
    expect(loadProductionWithPrivateAllowlist).toThrow(/NODE_ENV=production/);
  });

  it('starts in production when the allowlist is empty', () => {
    expect(() => loadConfiguration({ ...REQUIRED, NODE_ENV: 'production' })).not.toThrow();
  });

  it('allows the same list outside production, where the demo receiver lives', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      NODE_ENV: 'development',
      CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: '127.0.0.1:4001',
    });
    expect(configuration.callbackPrivateDestinationAllowlist).toHaveLength(1);
  });

  it('caps the list, so it cannot become a general-purpose bypass', () => {
    const oversized = Array.from({ length: 9 }, (host, index) => `host${index}.test:4001`).join(
      ',',
    );
    expect(() =>
      loadConfiguration(environment({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: oversized })),
    ).toThrow(ConfigurationError);
  });
});

/**
 * The testnet signing key belongs to a standalone validation script, not to the service. Keeping it
 * out of the parsed configuration means no configuration dump, no error report and no debug log can
 * contain it, whatever else goes wrong.
 */
describe('secrets the running service never loads', () => {
  const PLANTED = 'planted-value-that-must-never-reach-the-configuration-object';

  it('ignores the testnet private key even when it is present in the environment', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      AMOY_TESTNET_PRIVATE_KEY: PLANTED,
    });
    expect(JSON.stringify(configuration)).not.toContain(PLANTED);
  });

  it('ignores the testnet receiving address too', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      AMOY_TESTNET_WALLET_ADDRESS_THAT_WILL_RECEIVE_MONEY: PLANTED,
    });
    expect(JSON.stringify(configuration)).not.toContain(PLANTED);
  });

  it('declares no field whose name suggests signing material', () => {
    const fields = Object.keys(loadConfiguration(environment()));
    for (const field of fields) {
      expect(field.toLowerCase()).not.toContain('privatekey');
      expect(field.toLowerCase()).not.toContain('mnemonic');
      expect(field.toLowerCase()).not.toContain('seed');
    }
  });
});

describe('callbackSsrfPolicy', () => {
  it('reports strict when nothing is allowlisted', () => {
    expect(callbackSsrfPolicy(load())).toBe('strict');
  });

  it('reports relaxed when a destination is allowlisted, so readiness can surface it', () => {
    const configuration = load({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: '127.0.0.1:4001' });
    expect(callbackSsrfPolicy(configuration)).toBe('relaxed');
  });
});

/**
 * Compose passes every variable it declares, so an optional setting left blank in `.env` arrives as
 * an empty string. Refusing to start on one is a false alarm that reads like a bad value.
 */
describe('optional settings left blank', () => {
  it('treats an empty wallet RPC URL as unset', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      POLYGON_MAINNET_WALLET_RPC_URL: '',
      POLYGON_AMOY_WALLET_RPC_URL: ' '.repeat(3),
    });
    expect(walletRpcUrlFor(configuration, 'polygon-mainnet')).toBeNull();
    expect(walletRpcUrlFor(configuration, 'polygon-amoy')).toBeNull();
  });

  it('falls back to the default base URLs rather than refusing on a blank one', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      PUBLIC_API_BASE_URL: '',
      PUBLIC_CHECKOUT_BASE_URL: '',
    });
    expect(configuration.publicApiBaseUrl).toBe('http://localhost:3001');
    expect(configuration.publicCheckoutBaseUrl).toBe('http://localhost:3000/pay');
  });

  it('still returns a configured wallet RPC URL', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      POLYGON_AMOY_WALLET_RPC_URL: 'https://rpc-amoy.polygon.technology',
    });
    expect(walletRpcUrlFor(configuration, 'polygon-amoy')).toBe(
      'https://rpc-amoy.polygon.technology',
    );
  });

  it('refuses a wallet RPC URL that is set to something that is not a URL', () => {
    expect(() =>
      loadConfiguration({ ...REQUIRED, POLYGON_AMOY_WALLET_RPC_URL: 'not-a-url' }),
    ).toThrow(ConfigurationError);
  });
});

/**
 * Settlement is the only part of this system that can spend, so the configuration that governs it
 * is checked the same way the SSRF combination is: the process refuses rather than warns.
 */
describe('settlement configuration', () => {
  it('is off unless it is turned on', () => {
    expect(load().settlementEnabled).toBe(false);
    expect(load({ SETTLEMENT_ENABLED: 'true' }).settlementEnabled).toBe(true);
  });

  it('reads a ceiling in whole units and reports it in base units', () => {
    const configuration = load({ POLYGON_MAINNET_SPEND_CEILING: '0.5' });
    expect(spendCeilingFor(configuration, 'polygon-mainnet')).toBe(500_000_000_000_000_000n);
  });

  it('reports no ceiling for a network that has none', () => {
    expect(spendCeilingFor(load(), 'polygon-amoy')).toBeNull();
  });

  it('refuses a ceiling that is not an amount', () => {
    expect(() => load({ POLYGON_MAINNET_SPEND_CEILING: 'half a POL' })).toThrow(ConfigurationError);
  });

  /**
   * The combination that matters. A production deployment that can sign and has no upper bound on
   * what it can spend must not start, because the failure it guards against is unbounded.
   */
  it('refuses to start a production signer with no ceiling', () => {
    expect(() =>
      loadConfiguration({
        ...REQUIRED,
        NODE_ENV: 'production',
        SETTLEMENT_ENABLED: 'true',
      }),
    ).toThrow(ConfigurationError);
  });

  it('starts a production signer that has a ceiling', () => {
    const configuration = loadConfiguration({
      ...REQUIRED,
      NODE_ENV: 'production',
      SETTLEMENT_ENABLED: 'true',
      POLYGON_MAINNET_SPEND_CEILING: '0.5',
    });
    expect(configuration.settlementEnabled).toBe(true);
  });

  it('allows development to run a signer without one', () => {
    expect(load({ SETTLEMENT_ENABLED: 'true' }).settlementEnabled).toBe(true);
  });
});

describe('preferring local development networks', () => {
  it('is off unless asked for in so many words', () => {
    expect(loadConfiguration(environment()).preferLocalDevelopmentNetworks).toBe(false);
    expect(
      loadConfiguration(environment({ PREFER_LOCAL_DEVELOPMENT_NETWORKS: 'yes' }))
        .preferLocalDevelopmentNetworks,
    ).toBe(false);
    expect(
      loadConfiguration(environment({ PREFER_LOCAL_DEVELOPMENT_NETWORKS: 'true' }))
        .preferLocalDevelopmentNetworks,
    ).toBe(true);
  });

  it('refuses to start in production when set, exactly as the allowlist does', () => {
    expect(loadProductionPreferringLocalNetworks).toThrow(ConfigurationError);
    expect(loadProductionPreferringLocalNetworks).toThrow(/NODE_ENV=production/);
  });
});

function loadProductionPreferringLocalNetworks() {
  return loadConfiguration({
    ...REQUIRED,
    NODE_ENV: 'production',
    PREFER_LOCAL_DEVELOPMENT_NETWORKS: 'true',
  });
}
