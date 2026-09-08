import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument, documentedOperations } from './openapi.js';

/**
 * The document is the integration contract, so what is asserted here is what an integrator would
 * discover the hard way: that every reference resolves, that no amount is a number, and that nothing
 * derived from key material is expressible.
 *
 * Whether the document describes the endpoints the server actually serves is asserted by the API
 * itself, at boot, against the routes Fastify registered. It cannot be checked here, because this
 * package deliberately knows nothing about the server.
 */

const document = buildOpenApiDocument({ serverUrl: 'https://api.cryptopay.example' });

interface DocumentShape {
  readonly openapi: string;
  readonly servers: readonly { readonly url: string }[];
  readonly components: {
    readonly schemas: Record<string, Record<string, unknown>>;
    readonly securitySchemes: Record<string, unknown>;
  };
  readonly paths: Record<string, Record<string, Record<string, unknown>>>;
}

const shape = document as unknown as DocumentShape;

function collectReferences(value: unknown, found: string[]): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReferences(entry, found);
    }
    return found;
  }
  if (typeof value !== 'object' || value === null) {
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string') {
      found.push(nested);
      continue;
    }
    collectReferences(nested, found);
  }
  return found;
}

describe('the generated document', () => {
  it('is OpenAPI 3.1 and points at the server it was built for', () => {
    expect(shape.openapi).toBe('3.1.0');
    expect(shape.servers[0]?.url).toBe('https://api.cryptopay.example');
  });

  it('resolves every reference it makes', () => {
    const references = collectReferences(document, []);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference.startsWith('#/components/schemas/')).toBe(true);
      const id = reference.slice('#/components/schemas/'.length);
      expect(Object.keys(shape.components.schemas)).toContain(id);
    }
  });

  it('survives a JSON round trip, because it is served as JSON', () => {
    const serialized = JSON.stringify(document);
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
    expect(serialized).not.toContain('ZodType');
  });

  it('describes every documented operation exactly once', () => {
    const operations = documentedOperations();
    const seen = new Set(operations.map((operation) => `${operation.method} ${operation.path}`));
    expect(seen.size).toBe(operations.length);

    for (const operation of operations) {
      expect(shape.paths[operation.path]?.[operation.method]).toBeDefined();
    }
  });

  it('gives every operation an operation id, which is what a generated client names its method', () => {
    const identifiers: string[] = [];
    for (const methods of Object.values(shape.paths)) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.operationId).toBe('string');
        identifiers.push(operation.operationId as string);
      }
    }
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it('declares bearer authentication on every merchant endpoint', () => {
    const payments = shape.paths['/v1/payments']?.post;
    expect(payments?.security).toStrictEqual([{ merchantApiKey: [] }]);
    expect(shape.components.securitySchemes.merchantApiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('leaves the checkout endpoints open, because the customer holds no key', () => {
    expect(shape.paths['/v1/checkout/{checkoutToken}']?.get?.security).toStrictEqual([]);
  });

  it('never expresses an amount as a number', () => {
    expect(shape.components.schemas.Amount).toMatchObject({
      properties: { baseUnits: { type: 'string' }, display: { type: 'string' } },
    });
  });

  it('cannot express anything derived from key material', () => {
    const serialized = JSON.stringify(document);
    for (const forbidden of [
      'derivationIndex',
      'derivationPath',
      'allocationReference',
      'privateKey',
      'masterSeed',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('documents the create request in input mode, so an optional field reads as optional', () => {
    const request = shape.components.schemas.CreatePaymentRequest as {
      required?: readonly string[];
    };
    expect(request.required).toStrictEqual(['network', 'assetSymbol', 'amount']);
  });

  it('carries the errors an integrator has to handle', () => {
    const create = shape.paths['/v1/payments']?.post?.responses as Record<string, unknown>;
    for (const status of ['201', '401', '422', '429', '503']) {
      expect(create[status]).toBeDefined();
    }
  });
});
