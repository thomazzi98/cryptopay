import { describe, expect, it } from 'vitest';

import {
  callbackSsrfPolicy,
  ConfigurationError,
  type EnvironmentSource,
  loadConfiguration,
} from './configuration.js';

const REQUIRED: EnvironmentSource = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://cryptopay:cryptopay@127.0.0.1:5432/cryptopay',
  API_KEY_PEPPER: 'a'.repeat(32),
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

describe('callbackSsrfPolicy', () => {
  it('reports strict when nothing is allowlisted', () => {
    expect(callbackSsrfPolicy(load())).toBe('strict');
  });

  it('reports relaxed when a destination is allowlisted, so readiness can surface it', () => {
    const configuration = load({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: '127.0.0.1:4001' });
    expect(callbackSsrfPolicy(configuration)).toBe('relaxed');
  });
});
