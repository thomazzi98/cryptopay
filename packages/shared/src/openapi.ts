import { z } from 'zod';

import { PaymentSchema } from './api-contracts.js';

/**
 * The OpenAPI document, generated from the same zod schemas the server validates with.
 *
 * This is the integration contract. Another system — a merchant's backend, or another payment
 * gateway placing CryptoPay behind its own checkout — reads this document, generates a client, and
 * is done. It is generated rather than written because a hand-written document drifts: the field a
 * release renames stays in the documentation until someone reports it, and by then an integrator has
 * shipped against a shape that no longer exists.
 *
 * Two things are checked rather than assumed. Every schema referenced by an operation must exist as
 * a component, and every operation must correspond to a route the server actually serves — the API
 * asserts the second at boot, so a documented endpoint that nobody implemented cannot be deployed.
 */

type JsonSchema = Record<string, unknown>;

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

export interface DocumentedOperation {
  readonly method: HttpMethod;
  /** OpenAPI style, with braces: `/v1/payments/{paymentId}`. */
  readonly path: string;
}

interface ParameterDefinition {
  readonly name: string;
  readonly location: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchema;
}

interface ResponseDefinition {
  readonly status: number;
  readonly description: string;
  /** A component id. Absent for a response with no body. */
  readonly schema?: string;
}

interface OperationDefinition extends DocumentedOperation {
  readonly operationId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly authenticated: boolean;
  readonly parameters?: readonly ParameterDefinition[];
  readonly requestBody?: string;
  readonly responses: readonly ResponseDefinition[];
}

export interface OpenApiOptions {
  /** The base URL the document advertises, so a generated client points somewhere real. */
  readonly serverUrl: string;
}

/**
 * Schemas a caller sends rather than receives, converted in input mode.
 *
 * The distinction is not cosmetic: a field with a default is optional in a request and always
 * present in a response, and a document that describes the response shape as the request shape tells
 * an integrator that a field they may omit is mandatory.
 */
const REQUEST_SCHEMA_IDS: ReadonlySet<string> = new Set([
  'CreatePaymentRequest',
  'TransactionHintRequest',
  'SetPayoutDestinationRequest',
  'ListPaymentsQuery',
  'ListWebhookDeliveriesQuery',
]);

const IDENTIFIER_PARAMETER = (name: string, description: string): ParameterDefinition => ({
  name,
  location: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const LIMIT_PARAMETER: ParameterDefinition = {
  name: 'limit',
  location: 'query',
  required: false,
  description: 'Page size. Defaults to 25.',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
};

const problem = (status: number, description: string): ResponseDefinition => ({
  status,
  description,
  schema: 'ProblemDetails',
});

const UNAUTHORIZED = problem(401, 'The API key is missing, unknown, or retired.');
const NOT_FOUND = problem(
  404,
  'No such resource for this key. Another merchant resource answers 404 rather than 403, because 403 would confirm the identifier exists.',
);
const VALIDATION_FAILED = problem(422, 'The request is well formed but cannot be accepted.');

const OPERATIONS: readonly OperationDefinition[] = [
  {
    method: 'get',
    path: '/healthz',
    operationId: 'checkLiveness',
    tag: 'Operations',
    summary: 'Liveness probe',
    description:
      'Answers whether the process is alive and touches nothing else, so a slow database cannot trigger a restart storm.',
    authenticated: false,
    responses: [{ status: 200, description: 'The process is alive.', schema: 'HealthReport' }],
  },
  {
    method: 'get',
    path: '/readyz',
    operationId: 'checkReadiness',
    tag: 'Operations',
    summary: 'Readiness probe',
    description:
      'Reports each dependency separately. A halted network is degraded rather than failed, because the API can still answer.',
    authenticated: false,
    responses: [
      { status: 200, description: 'Ready, possibly degraded.', schema: 'ReadinessReport' },
      { status: 503, description: 'Not ready for traffic.', schema: 'ReadinessReport' },
    ],
  },
  {
    method: 'get',
    path: '/openapi.json',
    operationId: 'getOpenApiDocument',
    tag: 'Operations',
    summary: 'This document',
    description:
      'The machine-readable contract, generated from the schemas the server validates with.',
    authenticated: false,
    responses: [{ status: 200, description: 'The OpenAPI 3.1 document.' }],
  },
  {
    method: 'get',
    path: '/v1/merchants/me',
    operationId: 'getAuthenticatedMerchant',
    tag: 'Merchants',
    summary: 'The merchant this key belongs to',
    description:
      'Also the cheapest way to verify a key and discover which environment it operates in, since the environment is a property of the key rather than of the request.',
    authenticated: true,
    responses: [{ status: 200, description: 'The merchant.', schema: 'Merchant' }, UNAUTHORIZED],
  },
  {
    method: 'get',
    path: '/v1/networks',
    operationId: 'listNetworks',
    tag: 'Networks',
    summary: 'Networks and assets this key can create payments on',
    description:
      'Discovery, so an integrator does not hardcode chain identifiers, contract addresses or confirmation counts. A network absent here is not being scanned by this deployment and payment creation on it is refused.',
    authenticated: true,
    responses: [
      { status: 200, description: 'The networks available to this key.', schema: 'NetworkList' },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'post',
    path: '/v1/payments',
    operationId: 'createPayment',
    tag: 'Payments',
    summary: 'Create a payment',
    description:
      'Allocates an address used by this payment alone and starts watching for it. The Idempotency-Key header is required: a retried request returns the original payment with an idempotency-replayed header rather than allocating a second address.',
    authenticated: true,
    parameters: [
      {
        name: 'Idempotency-Key',
        location: 'header',
        required: true,
        description:
          'Any unique string up to 255 characters. Reusing one with a different body is rejected rather than silently creating a second payment.',
        schema: { type: 'string', maxLength: 255 },
      },
    ],
    requestBody: 'CreatePaymentRequest',
    responses: [
      { status: 201, description: 'The payment was created.', schema: 'Payment' },
      UNAUTHORIZED,
      VALIDATION_FAILED,
      problem(
        429,
        'An identical request is already in flight. Honour Retry-After and retry; the eventual answer is the same payment.',
      ),
      problem(503, 'This environment cannot currently issue payment addresses.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/payments',
    operationId: 'listPayments',
    tag: 'Payments',
    summary: 'List payments',
    description:
      'Cursor paginated and newest first. Pass the nextCursor of a page as startingAfter to continue; an offset would skip or repeat rows as new payments arrive.',
    authenticated: true,
    parameters: [
      {
        name: 'status',
        location: 'query',
        required: false,
        description: 'Only payments in this status.',
        schema: { $ref: '#/components/schemas/PaymentStatus' },
      },
      {
        name: 'network',
        location: 'query',
        required: false,
        description: 'Only payments on this network.',
        schema: { type: 'string' },
      },
      {
        name: 'merchantReference',
        location: 'query',
        required: false,
        description: 'Exact match on the reference supplied at creation.',
        schema: { type: 'string', maxLength: 255 },
      },
      {
        name: 'createdAfter',
        location: 'query',
        required: false,
        description: 'ISO 8601 timestamp, exclusive.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'createdBefore',
        location: 'query',
        required: false,
        description: 'ISO 8601 timestamp, exclusive.',
        schema: { type: 'string', format: 'date-time' },
      },
      LIMIT_PARAMETER,
      {
        name: 'startingAfter',
        location: 'query',
        required: false,
        description: 'The nextCursor of the previous page.',
        schema: { type: 'string' },
      },
    ],
    responses: [
      { status: 200, description: 'One page of payments.', schema: 'PaymentList' },
      UNAUTHORIZED,
      VALIDATION_FAILED,
    ],
  },
  {
    method: 'get',
    path: '/v1/payments/{paymentId}',
    operationId: 'getPayment',
    tag: 'Payments',
    summary: 'Retrieve a payment',
    description:
      'The same resource a webhook carries, so polling and callbacks can never disagree about what a payment looks like.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The payment.', schema: 'Payment' },
      UNAUTHORIZED,
      NOT_FOUND,
    ],
  },
  {
    method: 'get',
    path: '/v1/payments/{paymentId}/transfers',
    operationId: 'listPaymentTransfers',
    tag: 'Payments',
    summary: 'Every transfer seen for a payment',
    description:
      'Including transfers of the wrong asset and transfers a reorg withdrew. Nothing is filtered out, because a customer whose money moved needs that to be visible.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The transfers.', schema: 'PaymentTransferList' },
      UNAUTHORIZED,
      NOT_FOUND,
    ],
  },
  {
    method: 'get',
    path: '/v1/payments/{paymentId}/timeline',
    operationId: 'getPaymentTimeline',
    tag: 'Payments',
    summary: 'The audit trail of a payment',
    description:
      'Every status change as it was written, in order, with the trigger that caused it.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The status changes.', schema: 'PaymentTimeline' },
      UNAUTHORIZED,
      NOT_FOUND,
    ],
  },
  {
    method: 'get',
    path: '/v1/payments/{paymentId}/deliveries',
    operationId: 'listPaymentDeliveries',
    tag: 'Payments',
    summary: 'Webhook deliveries for a payment',
    description: 'What was sent, what happened, and what is still queued.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The deliveries.', schema: 'PaymentDeliveryList' },
      UNAUTHORIZED,
      NOT_FOUND,
    ],
  },
  {
    method: 'post',
    path: '/v1/payments/{paymentId}/cancel',
    operationId: 'cancelPayment',
    tag: 'Payments',
    summary: 'Cancel a payment',
    description:
      'Permitted only while nothing has been credited: cancelling a funded payment would strand the customer money. Cancelling an already cancelled payment succeeds and changes nothing.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The cancelled payment.', schema: 'Payment' },
      UNAUTHORIZED,
      NOT_FOUND,
      problem(422, 'The payment has received funds or has already finished.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/settlements',
    operationId: 'listSettlements',
    tag: 'Settlement',
    summary: 'Where the money went',
    description:
      'One settlement per payment, with every transaction this system signed to move it and what each cost. Newest first.',
    authenticated: true,
    responses: [
      { status: 200, description: 'The settlements.', schema: 'SettlementList' },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'get',
    path: '/v1/payments/{paymentId}/settlement',
    operationId: 'getPaymentSettlement',
    tag: 'Settlement',
    summary: 'The settlement for one payment',
    description:
      'A payment has at most one settlement, ever. That is a unique key in the database rather than a rule in the code, and it is what makes paying a merchant twice for one payment impossible.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('paymentId', 'Identifier of the payment.')],
    responses: [
      { status: 200, description: 'The settlement.', schema: 'Settlement' },
      UNAUTHORIZED,
      problem(404, 'No settlement exists for that payment yet.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/treasury',
    operationId: 'getTreasury',
    tag: 'Settlement',
    summary: 'What this deployment can spend, and what it has spent',
    description:
      'The account that pays for gas, the balance it was last seen holding, and the spend ceiling. The ceiling is enforced before anything is signed, not reported afterwards: a settlement that would cross it fails rather than broadcasting.',
    authenticated: true,
    responses: [
      { status: 200, description: 'One report per network.', schema: 'TreasuryReportList' },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'get',
    path: '/v1/payout-destinations',
    operationId: 'listPayoutDestinations',
    tag: 'Settlement',
    summary: 'Where settled funds are sent',
    description: 'One destination per network. A network with none configured is never swept.',
    authenticated: true,
    responses: [
      { status: 200, description: 'The destinations.', schema: 'PayoutDestinationList' },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'put',
    path: '/v1/payout-destinations/{network}',
    operationId: 'setPayoutDestination',
    tag: 'Settlement',
    summary: 'Set where settled funds are sent',
    description:
      'Per network, deliberately. An address you control on one chain is not necessarily yours on another, and defaulting one network from another is how funds reach an account nobody can open.',
    authenticated: true,
    parameters: [
      IDENTIFIER_PARAMETER('network', 'The network identifier, for example polygon-mainnet.'),
    ],
    requestBody: 'SetPayoutDestinationRequest',
    responses: [
      { status: 200, description: 'The destination now in force.', schema: 'PayoutDestination' },
      UNAUTHORIZED,
      problem(422, 'Unknown network, an address that is not lowercase, or the wrong environment.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/webhooks/deliveries',
    operationId: 'listWebhookDeliveries',
    tag: 'Webhooks',
    summary: 'List webhook deliveries',
    description: 'Cursor paginated, newest first, across every payment.',
    authenticated: true,
    parameters: [
      {
        name: 'status',
        location: 'query',
        required: false,
        description: 'Only deliveries in this status.',
        schema: { $ref: '#/components/schemas/WebhookDeliveryStatus' },
      },
      {
        name: 'paymentIdentifier',
        location: 'query',
        required: false,
        description: 'Only deliveries for this payment.',
        schema: { type: 'string' },
      },
      LIMIT_PARAMETER,
      {
        name: 'startingAfter',
        location: 'query',
        required: false,
        description: 'The nextCursor of the previous page.',
        schema: { type: 'string' },
      },
    ],
    responses: [
      { status: 200, description: 'One page of deliveries.', schema: 'WebhookDeliveryList' },
      UNAUTHORIZED,
      VALIDATION_FAILED,
    ],
  },
  {
    method: 'get',
    path: '/v1/webhooks/deliveries/{deliveryId}',
    operationId: 'getWebhookDelivery',
    tag: 'Webhooks',
    summary: 'Retrieve a delivery with every attempt',
    description:
      'Each attempt records the address the request was pinned to and the first bytes of the response, which is what makes a failing endpoint diagnosable without guessing.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('deliveryId', 'Identifier of the delivery.')],
    responses: [
      { status: 200, description: 'The delivery.', schema: 'WebhookDelivery' },
      UNAUTHORIZED,
      NOT_FOUND,
    ],
  },
  {
    method: 'post',
    path: '/v1/webhooks/deliveries/{deliveryId}/redeliver',
    operationId: 'redeliverWebhook',
    tag: 'Webhooks',
    summary: 'Send a delivery again',
    description:
      'Permitted for a delivery that already succeeded, not only a failed one: a merchant whose own transaction rolled back needs the event again and knows that better than we do. The webhook-id is unchanged, so a merchant deduplicating on it will recognise the repeat.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('deliveryId', 'Identifier of the delivery.')],
    responses: [
      { status: 202, description: 'The delivery is queued again.', schema: 'WebhookDelivery' },
      UNAUTHORIZED,
      NOT_FOUND,
      problem(422, 'An attempt is in flight right now.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/webhooks/secrets',
    operationId: 'listWebhookSecrets',
    tag: 'Webhooks',
    summary: 'The active signing secrets',
    description: 'Only the hint is returned. The secret itself is shown once, at creation.',
    authenticated: true,
    responses: [
      { status: 200, description: 'The active secrets.', schema: 'WebhookSecretList' },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'post',
    path: '/v1/webhooks/secrets',
    operationId: 'createWebhookSecret',
    tag: 'Webhooks',
    summary: 'Begin a secret rotation',
    description:
      'Adds a secret rather than replacing one. Both sign during the overlap, so an endpoint that has not been updated yet keeps verifying; retire the old one when your endpoint accepts the new.',
    authenticated: true,
    responses: [
      {
        status: 201,
        description: 'The new secret, returned in full exactly once.',
        schema: 'WebhookSecret',
      },
      UNAUTHORIZED,
    ],
  },
  {
    method: 'delete',
    path: '/v1/webhooks/secrets/{secretId}',
    operationId: 'retireWebhookSecret',
    tag: 'Webhooks',
    summary: 'Retire a signing secret',
    description:
      'Refused for the last remaining secret: a merchant with none would receive callbacks nobody can verify, which is worse than a stale secret that still works.',
    authenticated: true,
    parameters: [IDENTIFIER_PARAMETER('secretId', 'Identifier of the secret.')],
    responses: [
      { status: 204, description: 'The secret is retired.' },
      UNAUTHORIZED,
      problem(422, 'Unknown, already retired, or the only secret left.'),
    ],
  },
  {
    method: 'get',
    path: '/v1/checkout/{checkoutToken}',
    operationId: 'getCheckout',
    tag: 'Checkout',
    summary: 'The public view of a payment',
    description:
      'Served without authentication, for the page the customer sees. A deliberately separate resource rather than a filtered payment, so a merchant-only field is absent from the type rather than stripped by a presenter someone can forget to call.',
    authenticated: false,
    parameters: [
      IDENTIFIER_PARAMETER('checkoutToken', 'The opaque token from the payment checkoutUrl.'),
    ],
    responses: [
      { status: 200, description: 'The checkout.', schema: 'Checkout' },
      problem(404, 'No such checkout token.'),
    ],
  },
  {
    method: 'post',
    path: '/v1/checkout/{checkoutToken}/transaction-hint',
    operationId: 'submitTransactionHint',
    tag: 'Checkout',
    summary: 'Tell the backend where to look first',
    description:
      'A latency optimisation and nothing else. The hint schedules a scan; the amount, asset, recipient and confirmation count are always re-derived from the chain, so a fabricated hash changes no outcome and a customer who closes the browser after signing is still paid.',
    authenticated: false,
    parameters: [
      IDENTIFIER_PARAMETER('checkoutToken', 'The opaque token from the payment checkoutUrl.'),
    ],
    requestBody: 'TransactionHintRequest',
    responses: [
      { status: 202, description: 'The hint was accepted.' },
      problem(404, 'No such checkout token.'),
      problem(422, 'The transaction reference is not well formed.'),
    ],
  },
];

/**
 * The component schemas, converted from the registry the contracts populate.
 *
 * `$schema` and `$id` are stripped: they are correct for a standalone JSON Schema document and noise
 * inside an OpenAPI components block, where the location in the document is the identity.
 */
function componentSchemas(): Record<string, JsonSchema> {
  // The contracts register themselves in zod's global registry through `.meta({ id })`. Reading one
  // back is what proves the module was loaded before this ran, rather than producing an empty
  // document that would look like a contract with no types in it.
  const anchor = z.globalRegistry.get(PaymentSchema)?.id;
  if (anchor !== 'Payment') {
    throw new Error('The API contracts are not registered, so no OpenAPI document can be built.');
  }

  const convert = (io: 'input' | 'output') =>
    z.toJSONSchema(z.globalRegistry, {
      target: 'draft-2020-12',
      io,
      uri: (id) => `#/components/schemas/${id}`,
    }).schemas as Record<string, JsonSchema>;

  const outputs = convert('output');
  const inputs = convert('input');

  const components: Record<string, JsonSchema> = {};
  for (const [id, schema] of Object.entries(outputs)) {
    const component = { ...(REQUEST_SCHEMA_IDS.has(id) ? (inputs[id] ?? schema) : schema) };
    delete component.$schema;
    delete component.$id;
    components[id] = component;
  }
  return components;
}

function buildParameters(operation: OperationDefinition): readonly JsonSchema[] {
  return (operation.parameters ?? []).map((parameter) => ({
    name: parameter.name,
    in: parameter.location,
    required: parameter.required,
    description: parameter.description,
    schema: parameter.schema,
  }));
}

function buildResponses(operation: OperationDefinition): Record<string, JsonSchema> {
  const responses: Record<string, JsonSchema> = {};
  for (const response of operation.responses) {
    const body =
      response.schema === undefined
        ? {}
        : {
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${response.schema}` },
              },
            },
          };
    responses[String(response.status)] = { description: response.description, ...body };
  }
  return responses;
}

/**
 * Every component id an operation refers to, from wherever it refers to it.
 *
 * Collected rather than checked inline so that a reference in a parameter is verified by the same
 * code as a reference in a response body. The one that goes unchecked is the one that breaks a
 * generated client.
 */
function referencedComponentIds(operation: OperationDefinition): readonly string[] {
  const fromResponses = operation.responses
    .map((response) => response.schema)
    .filter((schema): schema is string => schema !== undefined);
  const fromParameters = (operation.parameters ?? [])
    .map((parameter) => parameter.schema.$ref)
    .filter((reference): reference is string => typeof reference === 'string')
    .map((reference) => reference.replace('#/components/schemas/', ''));
  const fromBody = operation.requestBody === undefined ? [] : [operation.requestBody];
  return [...fromResponses, ...fromParameters, ...fromBody];
}

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const components = componentSchemas();
  const known = new Set(Object.keys(components));

  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    for (const identifier of referencedComponentIds(operation)) {
      if (!known.has(identifier)) {
        throw new Error(
          `Operation ${operation.operationId} refers to a schema that does not exist: ${identifier}`,
        );
      }
    }

    const entry = (paths[operation.path] ??= {});
    entry[operation.method] = {
      operationId: operation.operationId,
      summary: operation.summary,
      description: operation.description,
      tags: [operation.tag],
      security: operation.authenticated ? [{ merchantApiKey: [] }] : [],
      ...(operation.parameters !== undefined && { parameters: buildParameters(operation) }),
      ...(operation.requestBody !== undefined && {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${operation.requestBody}` },
            },
          },
        },
      }),
      responses: buildResponses(operation),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'CryptoPay API',
      version: '1.0.0',
      summary:
        'Accept stablecoin payments and be told, by an independent observer, when they land.',
      description:
        'Every amount travels as two decimal strings, `baseUnits` and `display`, and never as a JSON number: a JSON parser that reads 25000000 into a double is correct today and silently wrong the moment an asset has 18 decimals.\n\nAddresses are lowercase everywhere in this API. Checksum them for display, never to compare.\n\nA payment is credited by scanning the chain, not by anything a browser reports, so a customer who closes the tab the instant after signing is still paid and a fabricated transaction hash changes nothing.\n\nCallbacks are signed as Standard Webhooks, so `svix` or `standardwebhooks` verifies them off the shelf. See `docs/webhooks.md` for the verification code.',
      license: { name: 'MIT' },
    },
    servers: [{ url: options.serverUrl }],
    tags: [
      { name: 'Payments', description: 'Creating, reading and cancelling payments.' },
      { name: 'Webhooks', description: 'Deliveries, redelivery, and signing secrets.' },
      { name: 'Checkout', description: 'The unauthenticated surface the customer page uses.' },
      { name: 'Networks', description: 'What this deployment can accept, as data.' },
      { name: 'Settlement', description: 'Moving credited funds to a merchant payout account.' },
      { name: 'Merchants', description: 'The merchant behind the API key.' },
      { name: 'Operations', description: 'Probes and this document.' },
    ],
    components: {
      schemas: components,
      securitySchemes: {
        merchantApiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A merchant API key, sent as `Authorization: Bearer cp_test_...`. The key carries the environment: a test key cannot create or read a live payment, and the API refuses rather than silently scoping the request.',
        },
      },
    },
    paths,
  };
}

/** Every operation the document declares. The API asserts at boot that it serves exactly these. */
export function documentedOperations(): readonly DocumentedOperation[] {
  return OPERATIONS.map((operation) => ({ method: operation.method, path: operation.path }));
}
