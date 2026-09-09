/**
 * When to try a callback again, and when to stop.
 *
 * The schedule is a table rather than a formula. A formula is compact and impossible to reason about
 * at three in the morning: nobody can say from `2 ** attempt * 30` when the ninth attempt lands, and
 * nobody notices when a change moves the tenth past the ceiling. A table is read directly, and a test
 * asserts the total against the documented figure.
 *
 * Classification is by status code alone. Parsing a response body to decide whether to retry means a
 * merchant's error page wording changes their retry behaviour.
 */

export type AttemptOutcome = 'delivered' | 'retryable' | 'permanent' | 'blocked' | 'timeout';

export interface RetryPolicy {
  /** Seconds to wait before attempt n+1, indexed from the attempt that just failed. */
  readonly delaysInSeconds: readonly number[];
  /** Nothing is retried past this age, whatever the schedule says. */
  readonly maximumAgeInSeconds: number;
  /** A `4xx` other than 429 usually means the endpoint will never accept this, so it gives up early. */
  readonly clientErrorAttemptCeiling: number;
}

/**
 * Sixteen attempts spanning roughly 44 hours: dense at first, because most failures are a restart
 * that lasts seconds, then sparse, because an endpoint still down after six hours is down for the
 * day and hammering it helps nobody. The 72-hour ceiling is a backstop above the schedule rather
 * than a target it reaches, so extending the table cannot quietly turn into a week of retries.
 */
export const LIVE_RETRY_POLICY: RetryPolicy = Object.freeze({
  delaysInSeconds: Object.freeze([
    5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14_400, 21_600, 28_800, 36_000, 43_200,
  ]),
  maximumAgeInSeconds: 259_200,
  clientErrorAttemptCeiling: 8,
});

/** Six attempts across about twenty-two minutes, so a test can watch a delivery give up. */
export const TEST_RETRY_POLICY: RetryPolicy = Object.freeze({
  delaysInSeconds: Object.freeze([1, 5, 30, 120, 600]),
  maximumAgeInSeconds: 3600,
  clientErrorAttemptCeiling: 4,
});

/**
 * A redirect is permanent, and is never followed.
 *
 * Following one would let anyone who can influence a merchant's DNS or hosting bounce a signed
 * request carrying payment data to an address the SSRF policy already refused. The merchant is told
 * to update the URL instead.
 */
export function classifyResponseStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) {
    return 'delivered';
  }
  if (status >= 300 && status < 400) {
    return 'permanent';
  }
  return 'retryable';
}

export interface RetryDecision {
  readonly kind: 'retry' | 'abandon';
  readonly delayInSeconds: number;
  readonly reason: string;
}

export interface RetryInput {
  readonly policy: RetryPolicy;
  readonly outcome: AttemptOutcome;
  /** The attempt that has just completed, counted from one. */
  readonly attemptNumber: number;
  readonly responseStatus: number | null;
  /** Seconds the endpoint asked to be left alone for, if it said. */
  readonly retryAfterSeconds: number | null;
  readonly ageInSeconds: number;
  /** From the injected random source, so a schedule is reproducible under test. */
  readonly jitterFactor: number;
}

const MINIMUM_JITTER = 0.8;
const MAXIMUM_JITTER = 1.2;

function clampJitter(factor: number): number {
  return Math.min(MAXIMUM_JITTER, Math.max(MINIMUM_JITTER, factor));
}

export function decideRetry(input: RetryInput): RetryDecision {
  if (input.outcome === 'delivered') {
    return { kind: 'abandon', delayInSeconds: 0, reason: 'the callback was delivered' };
  }
  if (input.outcome === 'permanent') {
    return {
      kind: 'abandon',
      delayInSeconds: 0,
      reason: 'the destination answered in a way that will not change on a retry',
    };
  }
  if (input.outcome === 'blocked') {
    return {
      kind: 'abandon',
      delayInSeconds: 0,
      reason: 'the destination is not one this system is allowed to reach',
    };
  }

  if (input.ageInSeconds >= input.policy.maximumAgeInSeconds) {
    return { kind: 'abandon', delayInSeconds: 0, reason: 'the callback is older than the ceiling' };
  }
  if (input.attemptNumber > input.policy.delaysInSeconds.length) {
    return { kind: 'abandon', delayInSeconds: 0, reason: 'every scheduled attempt has been spent' };
  }

  const status = input.responseStatus;
  const isClientError = status !== null && status >= 400 && status < 500 && status !== 429;
  if (isClientError && input.attemptNumber >= input.policy.clientErrorAttemptCeiling) {
    return {
      kind: 'abandon',
      delayInSeconds: 0,
      reason: 'the destination keeps rejecting the request as malformed',
    };
  }

  const scheduled = input.policy.delaysInSeconds[input.attemptNumber - 1] ?? 0;
  const jittered = Math.round(scheduled * clampJitter(input.jitterFactor));

  // An endpoint that asked for more time gets it, up to the age ceiling and no further. A receiver
  // naming a Retry-After of a year is not honoured into next year: the schedule already bounds how
  // long an event may be chased, and a header a stranger controls must not be able to park a
  // delivery past the point where it would have been abandoned anyway.
  if (status === 429 && input.retryAfterSeconds !== null) {
    const remainingLife = Math.max(0, input.policy.maximumAgeInSeconds - input.ageInSeconds);
    const honoured = Math.min(input.retryAfterSeconds, remainingLife);
    return {
      kind: 'retry',
      delayInSeconds: Math.max(jittered, honoured),
      reason: 'the destination asked to be retried later',
    };
  }

  return { kind: 'retry', delayInSeconds: jittered, reason: 'scheduled retry' };
}

/** The documented total, derived from the table rather than written beside it where it can rot. */
export function totalScheduleSeconds(policy: RetryPolicy): number {
  let total = 0;
  for (const delay of policy.delaysInSeconds) {
    total += delay;
  }
  return total;
}
