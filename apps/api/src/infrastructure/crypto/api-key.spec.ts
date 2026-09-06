import { describe, expect, it } from 'vitest';

import { UlidFactory } from '../system/ulid.js';
import { apiKeySecretMatches, digestApiKeySecret, generateApiKey, parseApiKey } from './api-key.js';

const PEPPER = 'a-server-held-pepper-value';
const FIXED_TIME = 1_757_183_400_000;

function generate(environment: 'test' | 'live' = 'test') {
  return generateApiKey(environment, PEPPER, new UlidFactory(), FIXED_TIME);
}

describe('generateApiKey', () => {
  it('names the environment in the key itself', () => {
    expect(generate('test').presentedKey.startsWith('cp_test_')).toBe(true);
    expect(generate('live').presentedKey.startsWith('cp_live_')).toBe(true);
  });

  it('produces a key that parses back to the same identifier and environment', () => {
    const generated = generate('live');
    const parsed = parseApiKey(generated.presentedKey);
    expect(parsed?.environment).toBe('live');
    expect(parsed?.keyIdentifier).toBe(generated.keyIdentifier);
  });

  it('stores a 32 byte digest rather than the secret', () => {
    const generated = generate();
    expect(generated.secretDigest).toHaveLength(32);
    const parsed = parseApiKey(generated.presentedKey);
    expect(generated.secretDigest.toString('hex')).not.toContain(parsed?.secret ?? '');
  });

  it('records only the last four characters for display', () => {
    const generated = generate();
    const parsed = parseApiKey(generated.presentedKey);
    expect(generated.lastFour).toHaveLength(4);
    expect(parsed?.secret.endsWith(generated.lastFour)).toBe(true);
  });

  it('never repeats a secret', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generate().presentedKey));
    expect(secrets.size).toBe(200);
  });
});

describe('parseApiKey', () => {
  it.each([
    { description: 'an unknown environment', candidate: 'cp_stage_01K4QW6ZR2M8X4T7YQ0C3D5B9N_abc' },
    { description: 'a missing prefix', candidate: 'test_01K4QW6ZR2M8X4T7YQ0C3D5B9N_abc' },
    { description: 'a lowercase identifier', candidate: 'cp_test_01k4qw6zr2m8x4t7yq0c3d5b9n_abc' },
    { description: 'a truncated identifier', candidate: 'cp_test_01K4QW_abc' },
    { description: 'a missing secret', candidate: 'cp_test_01K4QW6ZR2M8X4T7YQ0C3D5B9N' },
    { description: 'an empty string', candidate: '' },
    { description: 'only whitespace', candidate: ' '.repeat(3) },
  ])('rejects $description', ({ candidate }) => {
    expect(parseApiKey(candidate)).toBeNull();
  });

  it('tolerates surrounding whitespace from a copy and paste', () => {
    const generated = generate();
    expect(parseApiKey(`  ${generated.presentedKey}\n`)).not.toBeNull();
  });

  // A secret is base64url, whose alphabet includes the underscore that separates the key's parts.
  // Parsing is anchored on the fixed-length identifier so that a secret containing one still parses.
  it('parses a secret that contains the separator character', () => {
    const generated = generate();
    const parsed = parseApiKey(generated.presentedKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.secret).toHaveLength(43);
  });
});

describe('apiKeySecretMatches', () => {
  it('accepts the secret it was generated from', () => {
    const generated = generate();
    const parsed = parseApiKey(generated.presentedKey);
    expect(apiKeySecretMatches(parsed?.secret ?? '', generated.secretDigest, PEPPER)).toBe(true);
  });

  it('rejects a different secret', () => {
    const generated = generate();
    expect(apiKeySecretMatches('not-the-secret', generated.secretDigest, PEPPER)).toBe(false);
  });

  it('rejects the right secret under a different pepper', () => {
    const generated = generate();
    const parsed = parseApiKey(generated.presentedKey);
    expect(apiKeySecretMatches(parsed?.secret ?? '', generated.secretDigest, 'other-pepper')).toBe(
      false,
    );
  });

  // timingSafeEqual throws on a length mismatch, and a thrown exception is itself a timing signal.
  it('returns false rather than throwing when the digest length differs', () => {
    expect(apiKeySecretMatches('secret', Buffer.alloc(8), PEPPER)).toBe(false);
  });

  it('rejects an empty secret', () => {
    const generated = generate();
    expect(apiKeySecretMatches('', generated.secretDigest, PEPPER)).toBe(false);
  });
});

describe('digestApiKeySecret', () => {
  it('is deterministic for one secret and pepper', () => {
    expect(digestApiKeySecret('abc', PEPPER)).toStrictEqual(digestApiKeySecret('abc', PEPPER));
  });

  it('changes completely when the pepper changes', () => {
    expect(digestApiKeySecret('abc', PEPPER)).not.toStrictEqual(digestApiKeySecret('abc', 'other'));
  });
});
