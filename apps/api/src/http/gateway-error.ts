import type { GatewayError } from '@cryptopay/shared';

import { ApplicationError, PROBLEM_CATALOG, type ProblemCode } from './problem-details.js';

/**
 * The error shape the gateway surface returns, rendered from the same catalogue and the same
 * `ApplicationError` that `/v1` renders as RFC 9457. One place raises each failure; two render it.
 *
 * What is deliberately absent is the point of the file. No stack trace, no driver message, no class
 * name, no table name, no endpoint URL, no configuration. An integrator gets a stable code, a
 * sentence, and a request identifier that leads to the log line holding everything else.
 */

export const GATEWAY_ERROR_CONTENT_TYPE = 'application/json';

/** The generic name for each catalogue entry, used when a failure has nothing finer to say. */
const DEFAULT_CODES: Readonly<Record<ProblemCode, string>> = Object.freeze({
  validation_failed: 'VALIDATION_FAILED',
  malformed_request: 'MALFORMED_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  resource_not_found: 'RESOURCE_NOT_FOUND',
  method_not_allowed: 'METHOD_NOT_ALLOWED',
  rate_limited: 'RATE_LIMITED',
  internal_error: 'INTERNAL_ERROR',
  service_unavailable: 'SERVICE_UNAVAILABLE',
});

/**
 * Field-level issues are folded into the sentence rather than given a second shape. The envelope
 * has one slot for a message, and inventing a parallel structure that only this surface returns is
 * how a documented contract stops matching what is sent.
 */
function composeMessage(error: ApplicationError): string {
  if (error.issues.length === 0) {
    return error.detail;
  }
  const described = error.issues
    .map((issue) => `${issue.path === '' ? 'body' : issue.path}: ${issue.message}`)
    .join('; ');
  return `${error.detail} (${described})`;
}

export interface RenderedGatewayError {
  readonly status: number;
  readonly body: GatewayError;
}

export function toGatewayError(error: ApplicationError, requestId: string): RenderedGatewayError {
  return {
    status: PROBLEM_CATALOG[error.code].status,
    body: {
      error: {
        code: error.gatewayCode ?? DEFAULT_CODES[error.code],
        message: composeMessage(error),
        requestId,
      },
    },
  };
}

/**
 * An unexpected throw. The message is fixed text: whatever actually failed is in the log under this
 * request identifier, and repeating it here is how a database error reaches a customer's browser.
 */
export function toUnexpectedGatewayError(requestId: string): RenderedGatewayError {
  return {
    status: PROBLEM_CATALOG.internal_error.status,
    body: {
      error: {
        code: DEFAULT_CODES.internal_error,
        message:
          'The request could not be completed. Quote the request identifier when reporting it.',
        requestId,
      },
    },
  };
}

/** Routes under this prefix answer in the gateway envelope; everything else answers in problem+json. */
const GATEWAY_PATH_PREFIX = '/api/v1';

export function isGatewayRequest(url: string): boolean {
  if (url === GATEWAY_PATH_PREFIX) {
    return true;
  }
  return url.startsWith(`${GATEWAY_PATH_PREFIX}/`);
}

/**
 * The failures payment creation can report, named for what an integrator has to do about them
 * rather than for where they were raised.
 */
export const GATEWAY_CODES = Object.freeze({
  invalidPaymentAmount: 'INVALID_PAYMENT_AMOUNT',
  unsupportedCurrency: 'UNSUPPORTED_CURRENCY',
  unsupportedNetwork: 'UNSUPPORTED_NETWORK',
  networkNotPermitted: 'NETWORK_NOT_PERMITTED',
  networkUnavailable: 'NETWORK_UNAVAILABLE',
  invalidCallbackUrl: 'INVALID_CALLBACK_URL',
  duplicateExternalReference: 'DUPLICATE_EXTERNAL_REFERENCE',
  paymentNotFound: 'PAYMENT_NOT_FOUND',
  paymentNotCancellable: 'PAYMENT_NOT_CANCELLABLE',
  idempotencyKeyRequired: 'IDEMPOTENCY_KEY_REQUIRED',
  idempotencyKeyConflict: 'IDEMPOTENCY_KEY_CONFLICT',
  idempotencyKeyInUse: 'IDEMPOTENCY_KEY_IN_USE',
});

export function gatewayError(
  code: ProblemCode,
  gatewayCode: string,
  detail: string,
): ApplicationError {
  return new ApplicationError(code, detail, [], gatewayCode);
}
