import { documentedOperations } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { assertRoutesMatchDocument, type RegisteredRoute } from './openapi.js';

/**
 * The drift check is what makes the document trustworthy, so the check itself is what needs proving:
 * a check that silently passes on everything is worse than none, because it is believed.
 */

function everyDocumentedRoute(): RegisteredRoute[] {
  return documentedOperations().map((operation) => ({
    method: operation.method.toUpperCase(),
    url: operation.path.replaceAll(/\{(?<parameter>[^}]+)\}/gu, ':$<parameter>'),
  }));
}

describe('assertRoutesMatchDocument', () => {
  it('accepts a server that serves exactly what is documented', () => {
    expect(() => {
      assertRoutesMatchDocument(everyDocumentedRoute());
    }).not.toThrow();
  });

  it('rejects a route nobody documented', () => {
    const routes = [...everyDocumentedRoute(), { method: 'POST', url: '/v1/payments/:id/refund' }];
    expect(() => {
      assertRoutesMatchDocument(routes);
    }).toThrow(/POST \/v1\/payments\/:id\/refund is served but not in the OpenAPI document/u);
  });

  it('rejects an endpoint that is documented but not served', () => {
    const routes = everyDocumentedRoute().filter((route) => route.url !== '/v1/payments');
    expect(() => {
      assertRoutesMatchDocument(routes);
    }).toThrow(/\/v1\/payments is documented but not served/u);
  });

  it('rejects a documented path served under a different method', () => {
    const routes = everyDocumentedRoute().map((route) =>
      route.url === '/v1/networks' ? { method: 'POST', url: route.url } : route,
    );
    expect(() => {
      assertRoutesMatchDocument(routes);
    }).toThrow(/GET \/v1\/networks is documented but not served/u);
  });

  it('ignores the HEAD and OPTIONS routes the router adds by itself', () => {
    const routes = [
      ...everyDocumentedRoute(),
      { method: 'HEAD', url: '/v1/payments' },
      { method: 'OPTIONS', url: '/v1/payments' },
    ];
    expect(() => {
      assertRoutesMatchDocument(routes);
    }).not.toThrow();
  });

  it('reads a multi-method registration as each of its methods', () => {
    const routes = everyDocumentedRoute().filter((route) => route.url !== '/healthz');
    expect(() => {
      assertRoutesMatchDocument([...routes, { method: 'GET', url: '/healthz' }]);
    }).not.toThrow();
  });
});
