import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  fingerprintRequest,
  IdempotencyRepository,
  type ReservationOutcome,
} from '../src/infrastructure/persistence/idempotency.repository.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Idempotency is what stops a retried or duplicated request creating a second payment. These tests
 * drive the concurrent path directly, because the sequential path is the one that already works in
 * every naive implementation.
 */

let pool: Pool;
let dropDatabase: () => Promise<void>;
let repository: IdempotencyRepository;

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const OTHER_MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9P';
const BODY = '{"amount":"25.00","network":"polygon-amoy"}';

function reservationFor(key: string, body = BODY) {
  return {
    merchantId: MERCHANT_ID,
    environment: 'test' as const,
    idempotencyKey: key,
    method: 'POST',
    path: '/v1/payments',
    body,
  };
}

/**
 * The token the reservation was granted under. Every write to a reservation needs it, which is the
 * whole point: a request that lost its lock cannot write over the winner's work.
 */
const ownerTokens = new Map<string, string>();

async function reserve(key: string, body = BODY) {
  const outcome = await repository.reserve(reservationFor(key, body));
  if (outcome.kind === 'reserved') {
    ownerTokens.set(key, outcome.ownerToken);
  }
  return outcome;
}

async function completeReservation(key: string, status: number, body: string): Promise<void> {
  const client = await pool.connect();
  try {
    await repository.complete(
      client,
      MERCHANT_ID,
      'test',
      key,
      ownerTokens.get(key) ?? '',
      status,
      body,
    );
  } finally {
    client.release();
  }
}

async function expireLock(key: string): Promise<void> {
  await pool.query(
    "UPDATE idempotency_keys SET lock_expires_at = now() - interval '1 second' WHERE idempotency_key = $1",
    [key],
  );
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'idempotency');
  pool = isolated.pool;
  dropDatabase = isolated.drop;
  repository = new IdempotencyRepository(pool);

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)', [
    MERCHANT_ID,
    'Northwind Supplies',
    OTHER_MERCHANT_ID,
    'Someone Else',
  ]);
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  await pool.query('DELETE FROM idempotency_keys');
});

describe('reserving a key', () => {
  it('reserves a key that has never been seen', async () => {
    const retried = await reserve('key-1');
    expect(retried.kind).toBe('reserved');
  });

  it('reports a live reservation as in progress rather than letting it proceed', async () => {
    await reserve('key-1');
    const second = await reserve('key-1');

    expect(second.kind).toBe('in_progress');
    expect(second).toHaveProperty('retryAfterSeconds', expect.any(Number));
  });

  /**
   * The property the whole design exists for. Without a reservation phase, every one of these
   * requests would find no stored response and proceed to allocate an address.
   */
  it('admits exactly one of fifty simultaneous requests', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => repository.reserve(reservationFor('stampede'))),
    );

    const reserved = outcomes.filter((outcome) => outcome.kind === 'reserved');
    const rejected = outcomes.filter((outcome) => outcome.kind === 'in_progress');

    expect(reserved).toHaveLength(1);
    expect(rejected).toHaveLength(49);
  });

  it('keeps the same key independent across merchants', async () => {
    await reserve('shared-key');
    const otherMerchant = await repository.reserve({
      ...reservationFor('shared-key'),
      merchantId: OTHER_MERCHANT_ID,
    });
    expect(otherMerchant.kind).toBe('reserved');
  });

  it('treats different keys as unrelated', async () => {
    await reserve('key-1');
    const unrelated = await reserve('key-2');
    expect(unrelated.kind).toBe('reserved');
  });
});

describe('replaying a completed request', () => {
  it('returns the stored response rather than running the work again', async () => {
    await reserve('key-1');
    await completeReservation('key-1', 201, '{"identifier":"pay_01K4QW"}');

    const replay = await reserve('key-1');
    expect(replay).toStrictEqual({
      kind: 'replay',
      status: 201,
      body: '{"identifier":"pay_01K4QW"}',
    });
  });

  it('replays the same response every time', async () => {
    await reserve('key-1');
    await completeReservation('key-1', 201, '{"identifier":"pay_01K4QW"}');

    const replays = await Promise.all(
      Array.from({ length: 10 }, () => repository.reserve(reservationFor('key-1'))),
    );
    for (const replay of replays) {
      expect(replay).toStrictEqual({
        kind: 'replay',
        status: 201,
        body: '{"identifier":"pay_01K4QW"}',
      });
    }
  });

  // A completed reservation must never be reclaimed, however long ago it was written, or a retry a
  // day later would create a second payment.
  it('never reclaims a completed reservation even after its lock has expired', async () => {
    await reserve('key-1');
    await completeReservation('key-1', 201, '{"identifier":"pay_01K4QW"}');
    await expireLock('key-1');

    const outcome = await reserve('key-1');
    expect(outcome.kind).toBe('replay');
  });
});

describe('detecting a reused key', () => {
  // Answering with the first request's response would be worse than an error: the caller would
  // believe the second, different payment exists.
  it('rejects the same key with a different body', async () => {
    await reserve('key-1');
    const mismatch = await reserve('key-1', '{"amount":"99.00"}');
    expect(mismatch).toStrictEqual({ kind: 'fingerprint_mismatch' });
  });

  it('rejects a reused key even after the first request completed', async () => {
    await reserve('key-1');
    await completeReservation('key-1', 201, '{"identifier":"pay_01K4QW"}');

    const mismatch = await reserve('key-1', '{"amount":"99.00"}');
    expect(mismatch).toStrictEqual({ kind: 'fingerprint_mismatch' });
  });

  it('rejects the same body sent to a different path', async () => {
    await reserve('key-1');
    const mismatch = await repository.reserve({
      ...reservationFor('key-1'),
      path: '/v1/payments/pay_01K4QW/cancel',
    });
    expect(mismatch).toStrictEqual({ kind: 'fingerprint_mismatch' });
  });

  it('rejects the same body sent with a different method', async () => {
    await reserve('key-1');
    const mismatch = await repository.reserve({ ...reservationFor('key-1'), method: 'PATCH' });
    expect(mismatch).toStrictEqual({ kind: 'fingerprint_mismatch' });
  });

  it('does not reclaim an expired reservation whose body has changed', async () => {
    await reserve('key-1');
    await expireLock('key-1');

    const mismatch = await reserve('key-1', '{"amount":"99.00"}');
    expect(mismatch).toStrictEqual({ kind: 'fingerprint_mismatch' });
  });
});

describe('recovering an abandoned reservation', () => {
  // A process that dies mid-request must not make the key unusable, since retrying is exactly the
  // case idempotency exists to serve.
  it('lets an identical request take over once the lock has expired', async () => {
    await reserve('key-1');
    await expireLock('key-1');

    const retried = await reserve('key-1');
    expect(retried.kind).toBe('reserved');
  });

  it('admits exactly one of many requests racing to take over', async () => {
    await reserve('key-1');
    await expireLock('key-1');

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => repository.reserve(reservationFor('key-1'))),
    );
    expect(
      outcomes.filter((outcome: ReservationOutcome) => outcome.kind === 'reserved'),
    ).toHaveLength(1);
  });

  it('releases a reservation whose request failed, so a retry need not wait', async () => {
    await reserve('key-1');
    await repository.abandon(MERCHANT_ID, 'test', 'key-1', ownerTokens.get('key-1') ?? '');

    const retried = await reserve('key-1');
    expect(retried.kind).toBe('reserved');
  });

  it('refuses to release a completed reservation', async () => {
    await reserve('key-1');
    await completeReservation('key-1', 201, '{"identifier":"pay_01K4QW"}');
    await repository.abandon(MERCHANT_ID, 'test', 'key-1', ownerTokens.get('key-1') ?? '');

    const outcome = await reserve('key-1');
    expect(outcome.kind).toBe('replay');
  });
});

describe('retention', () => {
  it('purges only records past their retention window', async () => {
    await reserve('fresh');
    await reserve('stale');
    await pool.query(
      "UPDATE idempotency_keys SET expires_at = now() - interval '1 hour' WHERE idempotency_key = 'stale'",
    );

    expect(await repository.purgeExpired()).toBe(1);

    const remaining = await pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM idempotency_keys',
    );
    expect(remaining.rows.map((row) => row.idempotency_key)).toStrictEqual(['fresh']);
  });
});

describe('fingerprintRequest', () => {
  it('is stable for identical input', () => {
    expect(fingerprintRequest('POST', '/v1/payments', BODY)).toStrictEqual(
      fingerprintRequest('POST', '/v1/payments', BODY),
    );
  });

  it('separates inputs that differ only in field order', () => {
    expect(fingerprintRequest('POST', '/v1/payments', '{"a":1,"b":2}')).not.toStrictEqual(
      fingerprintRequest('POST', '/v1/payments', '{"b":2,"a":1}'),
    );
  });

  it('produces a full 32 byte digest, which the column requires', () => {
    expect(fingerprintRequest('POST', '/v1/payments', BODY)).toHaveLength(32);
  });
});

/**
 * A merchant holds a test key and a live key, and the obvious idempotency key is their own order
 * number. Without the environment in the key, `order-10422` from one environment reserved the row
 * `order-10422` from the other, and the second request was refused for twenty-four hours over a
 * collision the caller could neither see nor avoid.
 */
describe('the same key in both environments', () => {
  it('reserves independently', async () => {
    const test = await repository.reserve(reservationFor('order-10422'));
    const live = await repository.reserve({
      ...reservationFor('order-10422'),
      environment: 'live',
    });

    expect(test.kind).toBe('reserved');
    expect(live.kind).toBe('reserved');
  });

  it('replays each environment its own response', async () => {
    const test = await repository.reserve(reservationFor('order-1'));
    const live = await repository.reserve({ ...reservationFor('order-1'), environment: 'live' });
    if (test.kind !== 'reserved' || live.kind !== 'reserved') {
      throw new Error('both reservations should have been granted');
    }

    const client = await pool.connect();
    try {
      await repository.complete(
        client,
        MERCHANT_ID,
        'test',
        'order-1',
        test.ownerToken,
        201,
        '{"id":"test"}',
      );
      await repository.complete(
        client,
        MERCHANT_ID,
        'live',
        'order-1',
        live.ownerToken,
        201,
        '{"id":"live"}',
      );
    } finally {
      client.release();
    }

    const replayedTest = await repository.reserve(reservationFor('order-1'));
    const replayedLive = await repository.reserve({
      ...reservationFor('order-1'),
      environment: 'live',
    });

    expect(replayedTest).toMatchObject({ kind: 'replay', body: '{"id":"test"}' });
    expect(replayedLive).toMatchObject({ kind: 'replay', body: '{"id":"live"}' });
  });
});

/**
 * The window between a lock expiring and the original request finishing.
 *
 * The lock exists so a dead process cannot wedge a key forever, which means a slow request can lose
 * its reservation to a retry while it is still working. Without an owner, both requests wrote their
 * response over the same row: one Idempotency-Key, two payments, two deposit addresses, and a
 * customer able to pay either of them.
 */
describe('a reservation taken over mid-request', () => {
  it('refuses the response of the request that lost the lock', async () => {
    const first = await repository.reserve(reservationFor('key-1'));
    if (first.kind !== 'reserved') {
      throw new Error('the first reservation should have been granted');
    }

    await expireLock('key-1');
    const second = await repository.reserve(reservationFor('key-1'));
    if (second.kind !== 'reserved') {
      throw new Error('the takeover should have been granted');
    }

    const client = await pool.connect();
    try {
      const loser = await repository.complete(
        client,
        MERCHANT_ID,
        'test',
        'key-1',
        first.ownerToken,
        201,
        '{"id":"first"}',
      );
      const winner = await repository.complete(
        client,
        MERCHANT_ID,
        'test',
        'key-1',
        second.ownerToken,
        201,
        '{"id":"second"}',
      );
      expect(loser).toBe(false);
      expect(winner).toBe(true);
    } finally {
      client.release();
    }

    const replayed = await repository.reserve(reservationFor('key-1'));
    expect(replayed).toMatchObject({ kind: 'replay', body: '{"id":"second"}' });
  });

  it('refuses to let the loser release the winner reservation', async () => {
    const first = await repository.reserve(reservationFor('key-1'));
    if (first.kind !== 'reserved') {
      throw new Error('the first reservation should have been granted');
    }
    await expireLock('key-1');
    await repository.reserve(reservationFor('key-1'));

    await repository.abandon(MERCHANT_ID, 'test', 'key-1', first.ownerToken);

    // Still held by the winner, so a third request is told to wait rather than being let through.
    const third = await repository.reserve(reservationFor('key-1'));
    expect(third.kind).toBe('in_progress');
  });
});
