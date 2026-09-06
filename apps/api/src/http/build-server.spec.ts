import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfiguration, type EnvironmentSource } from '../configuration.js';
import { MerchantRepository } from '../infrastructure/persistence/merchant.repository.js';
import { buildServer } from './build-server.js';
import type { ApplicationServer } from './server-types.js';
import { PROBLEM_CATALOG, PROBLEM_CONTENT_TYPE } from './problem-details.js';

const REQUIRED_ENVIRONMENT = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://cryptopay:cryptopay@127.0.0.1:5432/cryptopay',
  API_KEY_PEPPER: 'a'.repeat(32),
};

function createServer(variables: EnvironmentSource = {}): ApplicationServer {
  const configuration = loadConfiguration({ ...REQUIRED_ENVIRONMENT, ...variables });
  const logger = pino({ level: 'silent' });
  // These specs exercise routes that never reach the database; a pool is created but not connected
  // to, which is what makes them fast unit tests rather than integration tests.
  const merchantRepository = new MerchantRepository(undefined as never);
  return buildServer({ configuration, logger, merchantRepository });
}

describe('the HTTP server', () => {
  let server: ApplicationServer;

  beforeEach(() => {
    server = createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('reports liveness without touching any dependency', async () => {
    const response = await server.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ status: 'ok' });
  });

  it('reports readiness with a per-component breakdown', async () => {
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      callbackSsrfPolicy: string;
      components: { name: string; status: string }[];
    }>();
    expect(body.status).toBe('ok');
    expect(body.callbackSsrfPolicy).toBe('strict');
    expect(body.components.map((component) => component.name)).toContain('configuration');
  });

  it('surfaces a relaxed SSRF policy in readiness, so it cannot go unnoticed', async () => {
    const relaxed = createServer({ CALLBACK_PRIVATE_DESTINATION_ALLOWLIST: '127.0.0.1:4001' });
    const response = await relaxed.inject({ method: 'GET', url: '/readyz' });
    expect(response.json<{ callbackSsrfPolicy: string }>().callbackSsrfPolicy).toBe('relaxed');
    await relaxed.close();
  });
});

describe('request identifiers', () => {
  let server: ApplicationServer;

  beforeEach(() => {
    server = createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns a request identifier on every response', async () => {
    const response = await server.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('echoes a caller-supplied identifier so a trace spans both sides', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'req-from-caller' },
    });
    expect(response.headers['x-request-id']).toBe('req-from-caller');
  });

  it('generates its own when the supplied one is unusable', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'x'.repeat(200) },
    });
    expect(response.headers['x-request-id']).not.toBe('x'.repeat(200));
  });

  it('gives two requests different identifiers', async () => {
    const first = await server.inject({ method: 'GET', url: '/healthz' });
    const second = await server.inject({ method: 'GET', url: '/healthz' });
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('error responses', () => {
  let server: ApplicationServer;

  beforeEach(() => {
    server = createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('answers an unknown route with RFC 9457 problem details', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);

    const problem = response.json<{ code: string; requestId: string; status: number }>();
    expect(problem.code).toBe('resource_not_found');
    expect(problem.status).toBe(404);
    expect(problem.requestId).toBe(response.headers['x-request-id']);
  });

  it('rejects a malformed JSON body without leaking a parser stack', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/nothing-here',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain('at Object.');
    expect(response.body).not.toContain('node_modules');
  });

  it('carries a machine-readable code that a client can branch on', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/nothing-here' });
    const problem = response.json<{ code: string; type: string }>();
    expect(Object.keys(PROBLEM_CATALOG)).toContain(problem.code);
    expect(problem.type).toContain('resource-not-found');
  });
});

describe('the problem catalogue', () => {
  it('gives every code a status in the error range and a title', () => {
    for (const [code, entry] of Object.entries(PROBLEM_CATALOG)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[a-z_]+$/);
    }
  });
});
