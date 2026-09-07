import { describe, expect, it } from 'vitest';

import {
  classifyResponseStatus,
  decideRetry,
  LIVE_RETRY_POLICY,
  TEST_RETRY_POLICY,
  totalScheduleSeconds,
  type AttemptOutcome,
  type RetryInput,
} from './webhook-retry.js';

/**
 * The retry policy decides how long a merchant who was briefly down has to come back before we stop
 * telling them they were paid. Getting it wrong in one direction loses the notification; in the
 * other it hammers an endpoint that is already struggling.
 */

function input(overrides: Partial<RetryInput> = {}): RetryInput {
  return {
    policy: TEST_RETRY_POLICY,
    outcome: 'retryable',
    attemptNumber: 1,
    responseStatus: 500,
    retryAfterSeconds: null,
    ageInSeconds: 0,
    jitterFactor: 1,
    ...overrides,
  };
}

describe('classifying a response', () => {
  it.each([200, 201, 202, 204, 299])('treats %i as delivered', (status) => {
    expect(classifyResponseStatus(status)).toBe('delivered');
  });

  /**
   * A redirect is never followed. Following one lets anyone who can influence a merchant's DNS or
   * hosting bounce a signed request carrying payment data to an address the SSRF policy refused.
   */
  it.each([301, 302, 307, 308])('treats %i as permanent and never follows it', (status) => {
    expect(classifyResponseStatus(status)).toBe('permanent');
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504])(
    'treats %i as retryable rather than deciding from the body',
    (status) => {
      expect(classifyResponseStatus(status)).toBe('retryable');
    },
  );
});

describe('deciding whether to try again', () => {
  it.each<AttemptOutcome>(['delivered', 'permanent', 'blocked'])(
    'stops after a %s attempt',
    (outcome) => {
      expect(decideRetry(input({ outcome })).kind).toBe('abandon');
    },
  );

  it('schedules the first retry at the first delay in the table', () => {
    const decision = decideRetry(input({ attemptNumber: 1 }));
    expect(decision).toMatchObject({ kind: 'retry', delayInSeconds: 1 });
  });

  it('walks the table forwards, never a formula', () => {
    const delays = TEST_RETRY_POLICY.delaysInSeconds.map(
      (_, index) => decideRetry(input({ attemptNumber: index + 1 })).delayInSeconds,
    );
    expect(delays).toEqual([...TEST_RETRY_POLICY.delaysInSeconds]);
  });

  it('gives up once every scheduled attempt has been spent', () => {
    const beyond = TEST_RETRY_POLICY.delaysInSeconds.length + 1;
    expect(decideRetry(input({ attemptNumber: beyond })).kind).toBe('abandon');
  });

  /**
   * The ceiling exists because a schedule can be extended by a well-meaning change that quietly
   * leaves deliveries retrying for a week. The age check does not care what the table says.
   */
  it('gives up past the age ceiling however many attempts remain', () => {
    const decision = decideRetry(
      input({ attemptNumber: 1, ageInSeconds: TEST_RETRY_POLICY.maximumAgeInSeconds }),
    );
    expect(decision).toMatchObject({ kind: 'abandon' });
    expect(decision.reason).toContain('ceiling');
  });
});

describe('jitter', () => {
  it('spreads a delay proportionally rather than by a fixed amount', () => {
    expect(decideRetry(input({ attemptNumber: 3, jitterFactor: 0.8 })).delayInSeconds).toBe(24);
    expect(decideRetry(input({ attemptNumber: 3, jitterFactor: 1.2 })).delayInSeconds).toBe(36);
  });

  /**
   * A random source is injected, and an injected source can be a stub returning anything. Clamping
   * means a bad stub, or a source that changes its range, cannot produce a negative delay or one
   * measured in days.
   */
  it('clamps a factor outside the intended range', () => {
    expect(decideRetry(input({ attemptNumber: 3, jitterFactor: -5 })).delayInSeconds).toBe(24);
    expect(decideRetry(input({ attemptNumber: 3, jitterFactor: 99 })).delayInSeconds).toBe(36);
  });
});

describe('an endpoint that asks for time', () => {
  it('honours a longer Retry-After than the schedule offers', () => {
    const decision = decideRetry(
      input({ attemptNumber: 1, responseStatus: 429, retryAfterSeconds: 120 }),
    );
    expect(decision).toMatchObject({ kind: 'retry', delayInSeconds: 120 });
  });

  it('keeps its own schedule when Retry-After is shorter', () => {
    const decision = decideRetry(
      input({ attemptNumber: 4, responseStatus: 429, retryAfterSeconds: 2 }),
    );
    expect(decision.delayInSeconds).toBe(TEST_RETRY_POLICY.delaysInSeconds[3]);
  });

  it('does not treat a rate limit as a malformed request', () => {
    const decision = decideRetry(
      input({ attemptNumber: TEST_RETRY_POLICY.clientErrorAttemptCeiling, responseStatus: 429 }),
    );
    expect(decision.kind).toBe('retry');
  });
});

describe('an endpoint that keeps rejecting the request', () => {
  /**
   * A 4xx that is not a rate limit says the request will never be accepted as it stands. Spending
   * sixteen attempts on it delays every other delivery behind it for no benefit.
   */
  it.each([400, 401, 403, 404, 422])('gives up early on repeated %i', (status) => {
    const decision = decideRetry(
      input({ attemptNumber: TEST_RETRY_POLICY.clientErrorAttemptCeiling, responseStatus: status }),
    );
    expect(decision).toMatchObject({ kind: 'abandon' });
    expect(decision.reason).toContain('malformed');
  });

  it('still retries a server error at the same attempt number', () => {
    const decision = decideRetry(
      input({ attemptNumber: TEST_RETRY_POLICY.clientErrorAttemptCeiling, responseStatus: 503 }),
    );
    expect(decision.kind).toBe('retry');
  });

  it('retries a transport failure that produced no status at all', () => {
    const decision = decideRetry(input({ outcome: 'timeout', responseStatus: null }));
    expect(decision.kind).toBe('retry');
  });
});

describe('the shipped schedules', () => {
  it('spans roughly 44 hours across 16 live attempts', () => {
    expect(LIVE_RETRY_POLICY.delaysInSeconds).toHaveLength(15);
    const hours = totalScheduleSeconds(LIVE_RETRY_POLICY) / 3600;
    expect(hours).toBeGreaterThan(43);
    expect(hours).toBeLessThan(45);
  });

  it('never schedules past its own age ceiling', () => {
    expect(totalScheduleSeconds(LIVE_RETRY_POLICY)).toBeLessThan(
      LIVE_RETRY_POLICY.maximumAgeInSeconds,
    );
    expect(totalScheduleSeconds(TEST_RETRY_POLICY)).toBeLessThan(
      TEST_RETRY_POLICY.maximumAgeInSeconds,
    );
  });

  it('increases monotonically, so a later attempt is never sooner than an earlier one', () => {
    for (const policy of [LIVE_RETRY_POLICY, TEST_RETRY_POLICY]) {
      const delays = policy.delaysInSeconds;
      for (let index = 1; index < delays.length; index += 1) {
        expect(delays[index] ?? 0).toBeGreaterThanOrEqual(delays[index - 1] ?? 0);
      }
    }
  });

  it('finishes a test schedule inside about twenty-two minutes', () => {
    expect(totalScheduleSeconds(TEST_RETRY_POLICY)).toBeLessThan(1500);
  });
});
