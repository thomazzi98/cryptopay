import { z } from 'zod';

import { NETWORK_IDENTIFIERS } from './ledger-primitives.js';
import { CAPABILITY_NAMES, NETWORK_FAMILIES } from './network-descriptor.js';
import { PAYMENT_STATUSES } from './payment-status.js';
import { SETTLEMENT_STATUSES } from './settlement-status.js';

/**
 * The API contract, declared once. The server validates requests with these schemas, the OpenAPI
 * document is generated from them, and the dashboard's integration page renders examples from the
 * same source. A documented endpoint that the implementation does not honour is therefore not
 * expressible.
 *
 * Two rules run through every schema here:
 *
 * - **An amount is never a JSON number.** Every monetary value travels as two decimal strings,
 *   `baseUnits` and `display`. A JSON parser that reads 25000000 into a double is fine today and
 *   wrong the moment an asset has 18 decimals, and the failure is silent.
 * - **Nothing derived from key material is expressible.** There is no field for a derivation path,
 *   a derivation index or a private key, so no presenter can leak one by accident.
 */

const ULID_PATTERN = /^[\dABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const BASE_UNITS_PATTERN = /^\d+$/;
const DECIMAL_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
/**
 * An account on any supported family, and a transaction named the way its own chain names it.
 *
 * These were EVM-only, which made the contract unable to describe two thirds of the networks the
 * product settles on. The hosted checkout parses every response against this contract, so a TRON or
 * Solana payment was reported to the customer as a checkout the page could not read.
 *
 * A wire schema asserts plausibility across the families; exactness per network belongs to the
 * database CHECK and to `canonicaliseAccount`, both of which know which chain they are looking at
 * and neither of which a caller can bypass.
 */
const ACCOUNT_PATTERN = /^(?:0x[\da-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const TRANSACTION_REFERENCE_PATTERN = /^(?:0x[\da-f]{64}|[\da-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

const IPV4_HOSTNAME_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAXIMUM_CALLBACK_URL_LENGTH = 2048;

/**
 * The shape of a callback URL, and only the shape.
 *
 * Everything decidable from the text alone and true under every configuration lives here: it parses,
 * it is a web URL, it carries no credentials, and it names a host rather than an address. Parsing is
 * delegated entirely to WHATWG `new URL()` and only its parsed components are inspected, which
 * normalises the whole IPv4 encoding family in one step, so `0177.0.0.1`, `127.1` and `2130706433`
 * all arrive here as `127.0.0.1`. Hand-rolled decoders are where bypasses live.
 *
 * What is deliberately NOT here: requiring https, requiring a fully qualified hostname, and refusing
 * internal suffixes. Those depend on the deployment, because a development deployment may name one
 * exact private destination it is allowed to reach, and a schema in a browser-safe package cannot
 * know which. The server applies them through the destination policy at creation time and again
 * before every delivery attempt, so a merchant is still told immediately and the rule has one
 * implementation rather than two that can disagree.
 */
function refineCallbackUrl(value: string, context: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Must be a valid absolute URL' });
    return;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    context.addIssue({ code: 'custom', message: 'Callback URLs must be http or https' });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    context.addIssue({
      code: 'custom',
      message: 'Callback URLs must not embed credentials',
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') || IPV4_HOSTNAME_PATTERN.test(hostname)) {
    context.addIssue({
      code: 'custom',
      message: 'Callback URLs must name a host, not an IP address',
    });
  }
}

export const CallbackUrlSchema = z
  .string()
  .max(MAXIMUM_CALLBACK_URL_LENGTH)
  .superRefine(refineCallbackUrl)
  .meta({
    id: 'CallbackUrl',
    description:
      'Endpoint that receives signed webhooks. In any deployment you would use, this must be https on port 443 with a fully qualified hostname; the server enforces that, together with DNS resolution against the denied ranges and pinning of the resolved address, when the payment is created and again before every delivery attempt.',
    example: 'https://merchant.example.com/webhooks/cryptopay',
  });

function prefixedIdentifier(prefix: string, description: string) {
  return z
    .string()
    .refine(
      (value) =>
        value.startsWith(`${prefix}_`) && ULID_PATTERN.test(value.slice(prefix.length + 1)),
      { message: `Must be a ${prefix}_ identifier followed by a ULID` },
    )
    .meta({ description, example: `${prefix}_01K4QW6ZR2M8X4T7YQ0C3D5B9N` });
}

export const PaymentIdentifierSchema = prefixedIdentifier('pay', 'Identifier of a payment');
export const WebhookEndpointIdentifierSchema = prefixedIdentifier(
  'whe',
  'Identifier of a webhook endpoint',
);
export const WebhookDeliveryIdentifierSchema = prefixedIdentifier(
  'whd',
  'Identifier of a webhook delivery',
);

export const NetworkIdentifierSchema = z
  .enum(NETWORK_IDENTIFIERS as unknown as [string, ...string[]])
  .meta({ description: 'The blockchain network a payment settles on' });

export const NetworkFamilySchema = z
  .enum(NETWORK_FAMILIES as unknown as [string, ...string[]])
  .meta({ description: 'The chain family a network belongs to' });

/**
 * Every flag is false on at least one network and drives a refusal a test exercises. A capability
 * that is true everywhere documents nothing, and one that is true where the code cannot honour it
 * is exactly the faked functionality the contract must never advertise.
 */
export const NetworkCapabilitiesSchema = z
  .object({
    supportsNativePayments: z.boolean(),
    supportsTokenPayments: z.boolean(),
    supportsPaymentUri: z.boolean(),
    supportsEventMonitoring: z.boolean(),
    supportsFinalityTracking: z.boolean(),
    supportsMemo: z.boolean(),
    supportsSettlement: z.boolean(),
  })
  .meta({ id: 'NetworkCapabilities' });

export const EnvironmentSchema = z
  .enum(['live', 'test'])
  .meta({ description: 'Environment the payment belongs to. Determined by the API key used.' });

export const PaymentStatusSchema = z
  .enum(PAYMENT_STATUSES as unknown as [string, ...string[]])
  .meta({
    id: 'PaymentStatus',
    description: 'Lifecycle status. See docs/state-machine.md for the transition table.',
  });

export const AccountSchema = z.string().regex(ACCOUNT_PATTERN).meta({
  description:
    'A blockchain account, written the way its own chain writes one. EVM addresses are lowercase hex and should be checksummed for display, never to compare. TRON and Solana addresses are base58 and case significant: lowercasing one produces a different string that nobody holds a key for.',
  example: '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d',
});

export const TransactionReferenceSchema = z.string().regex(TRANSACTION_REFERENCE_PATTERN).meta({
  description:
    'How the chain names this transaction. Polygon calls it a transaction hash and prefixes it with 0x; TRON calls it a transaction id and writes the same thirty-two bytes bare; Solana calls it a signature and writes sixty-four bytes in base58. They are not the same thing under three names, so the field is named for what it does rather than for what one chain calls it.',
});

export const BlockHeightSchema = z
  .string()
  .regex(BASE_UNITS_PATTERN)
  .meta({ description: 'Block height as a decimal string, because it can exceed a safe integer' });

/**
 * Both representations of the same amount always travel together. The checkout client asserts that
 * parseUnits(display, decimals) equals baseUnits and refuses to open a wallet if they disagree,
 * which is what makes a tampered response harmless rather than expensive.
 */
export const AmountSchema = z
  .object({
    baseUnits: z.string().regex(BASE_UNITS_PATTERN).meta({ example: '25000000' }),
    display: z.string().regex(DECIMAL_AMOUNT_PATTERN).meta({ example: '25.000000' }),
  })
  .meta({ id: 'Amount', description: 'A monetary amount, never expressed as a JSON number' });

export const AssetSchema = z
  .object({
    reference: z.string().meta({
      description:
        "What identifies the asset, and the only thing ever compared to decide what a transfer paid. A contract address on Polygon or TRON, a mint address on Solana, or the literal string 'native' when the payment is in the chain's own currency and there is no contract to name. Never the symbol: more than one contract reports the same one.",
    }),
    symbol: z.string().meta({
      description:
        'Display only. Bridged USDC.e reports the identical symbol, so never compare it.',
      example: 'USDC',
    }),
    decimals: z.number().int().min(0).max(36).meta({ example: 6 }),
  })
  .meta({ id: 'Asset' });

export const MetadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 32, {
    message: 'At most 32 metadata entries are allowed',
  })
  .meta({
    id: 'Metadata',
    description: 'Merchant-supplied key/value pairs, echoed back on every payment and webhook',
    example: { orderId: 'order-10422' },
  });

export const TransferClassificationSchema = z.enum([
  'credited',
  'late',
  'unexpected',
  'wrong_asset',
]);

export const TransferObservationSchema = z.enum(['observed', 'finalized', 'orphaned']);

export const PaymentTransferSchema = z
  .object({
    transactionReference: TransactionReferenceSchema,
    eventIndex: z.number().int().min(0),
    blockHeight: BlockHeightSchema,
    blockReference: z.string(),
    sourceAccount: AccountSchema.nullable().meta({
      description:
        'The account the value came from, where the chain names one. Null where it does not: a Solana transaction may debit several accounts, so there is no single sender to report and reporting one would be a guess.',
    }),
    amount: AmountSchema,
    classification: TransferClassificationSchema,
    observation: TransferObservationSchema,
    explorerUrl: z.url().nullable(),
    observedAt: z.iso.datetime(),
  })
  .meta({
    id: 'PaymentTransfer',
    description:
      'A value movement read back from the chain. Orphaned transfers are reported, never hidden.',
  });

export const PaymentStatusChangeSchema = z
  .object({
    fromStatus: PaymentStatusSchema.nullable(),
    toStatus: PaymentStatusSchema,
    trigger: z.string(),
    statusVersion: z.number().int().min(0),
    occurredAt: z.iso.datetime(),
  })
  .meta({ id: 'PaymentStatusChange' });

export const PaymentSchema = z
  .object({
    identifier: PaymentIdentifierSchema,
    status: PaymentStatusSchema,
    statusVersion: z.number().int().min(0).meta({
      description: 'Increments on every applied change. Use it to discard out-of-order webhooks.',
    }),
    environment: EnvironmentSchema,
    network: NetworkIdentifierSchema,
    chainIdentifier: z.number().int().positive().nullable().meta({
      description:
        'The EVM chain id, or null on a network whose family has no numeric chain identity. TRON and Solana identify themselves by a genesis or first-block reference instead.',
    }),
    asset: AssetSchema,
    requestedAmount: AmountSchema,
    creditedAmount: AmountSchema,
    acceptanceBand: z.object({
      minimumBaseUnits: z.string().regex(BASE_UNITS_PATTERN),
      maximumBaseUnits: z.string().regex(BASE_UNITS_PATTERN),
    }),
    receivingAccount: AccountSchema.meta({
      description: 'The address allocated to this payment alone',
    }),
    confirmations: z.number().int().min(0),
    requiredConfirmations: z.number().int().min(0),
    finalityConfirmed: z.boolean().meta({
      description:
        'Whether the settling block is covered by the chain finality tag. Distinct from the confirmation count and reported separately.',
    }),
    settlingBlockHeight: BlockHeightSchema.nullable(),
    merchantReference: z.string().max(255).nullable(),
    callbackUrl: CallbackUrlSchema.nullable(),
    metadata: MetadataSchema,
    checkoutUrl: z.url(),
    explorerAccountUrl: z.url().nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    transfers: z.array(PaymentTransferSchema),
  })
  .meta({ id: 'Payment' });

export const CreatePaymentRequestSchema = z
  .object({
    network: NetworkIdentifierSchema,
    assetSymbol: z.string().min(1).max(16).meta({ example: 'USDC' }),
    amount: z.string().regex(DECIMAL_AMOUNT_PATTERN).meta({
      description:
        'Decimal amount as a string. Rejected rather than rounded if it carries more precision than the asset holds.',
      example: '25.00',
    }),
    callbackUrl: CallbackUrlSchema.nullish(),
    merchantReference: z.string().max(255).nullish(),
    metadata: MetadataSchema.nullish(),
    expiresInSeconds: z.number().int().min(60).max(86_400).nullish(),
  })
  .meta({ id: 'CreatePaymentRequest' });

export const ListPaymentsQuerySchema = z
  .object({
    status: PaymentStatusSchema.optional(),
    network: NetworkIdentifierSchema.optional(),
    merchantReference: z.string().max(255).optional(),
    createdAfter: z.iso.datetime().optional(),
    createdBefore: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    startingAfter: PaymentIdentifierSchema.optional(),
  })
  .meta({ id: 'ListPaymentsQuery' });

export const PaymentListSchema = z
  .object({
    data: z.array(PaymentSchema),
    hasMore: z.boolean(),
    nextCursor: PaymentIdentifierSchema.nullable(),
  })
  .meta({ id: 'PaymentList' });

/**
 * The public checkout view. Deliberately a separate schema rather than a subset of PaymentSchema:
 * this response is served without authentication, so the fields a merchant may see must be absent
 * from the type rather than stripped by a presenter that someone can forget to call.
 */
export const CheckoutSchema = z
  .object({
    status: PaymentStatusSchema,
    network: NetworkIdentifierSchema,
    networkFamily: NetworkFamilySchema.meta({
      description:
        'Which payment URI standard this network answers to. Stated rather than inferred from the network name, so the checkout draws EIP-681, Solana Pay or the TRON convention without carrying a table of its own.',
    }),
    chainIdentifier: z.number().int().positive().nullable().meta({
      description:
        'The EVM chain id, or null on a network whose family has no numeric chain identity. TRON and Solana identify themselves by a genesis or first-block reference instead.',
    }),
    networkDisplayName: z.string(),
    environment: EnvironmentSchema,
    asset: AssetSchema,
    requestedAmount: AmountSchema,
    creditedAmount: AmountSchema,
    receivingAccount: AccountSchema,
    confirmations: z.number().int().min(0),
    requiredConfirmations: z.number().int().min(0),
    finalityConfirmed: z.boolean(),
    merchantDisplayName: z.string(),
    expiresAt: z.iso.datetime(),
    explorerAccountUrl: z.url().nullable(),
    transfers: z.array(PaymentTransferSchema),
  })
  .meta({ id: 'Checkout' });

export const TransactionHintRequestSchema = z
  .object({ transactionReference: TransactionReferenceSchema })
  .meta({
    id: 'TransactionHintRequest',
    description:
      'A latency optimisation only. The hint schedules a scan of that block; the amount, asset, recipient and confirmations are always re-derived from the chain, so a fabricated hash changes nothing.',
  });

export const WebhookDeliveryStatusSchema = z
  .enum(['pending', 'in_flight', 'delivered', 'failed', 'abandoned'])
  .meta({ id: 'WebhookDeliveryStatus' });

export const WebhookAttemptOutcomeSchema = z
  .enum(['delivered', 'retryable', 'permanent', 'blocked', 'timeout'])
  .meta({ id: 'WebhookAttemptOutcome' });

export const WebhookAttemptSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    outcome: WebhookAttemptOutcomeSchema,
    responseStatus: z.number().int().nullable(),
    /** The address the request was pinned to. A different one next attempt is worth investigating. */
    resolvedAddress: z.string().nullable(),
    responseSnippet: z.string().nullable(),
    durationMilliseconds: z.number().int().min(0),
    failureReason: z.string().nullable(),
    /** True when a development allowlist entry is what permitted this attempt, never applied silently. */
    usedPrivateAllowlist: z.boolean(),
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookAttempt' });

export const WebhookDeliverySchema = z
  .object({
    identifier: WebhookDeliveryIdentifierSchema,
    paymentIdentifier: PaymentIdentifierSchema,
    eventType: z.string(),
    destinationUrl: z.string(),
    status: WebhookDeliveryStatusSchema,
    attemptCount: z.number().int().min(0),
    nextAttemptAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    lastFailure: z.string().nullable(),
    createdAt: z.iso.datetime(),
    attempts: z.array(WebhookAttemptSchema),
  })
  .meta({
    id: 'WebhookDelivery',
    description:
      'One notification of one payment event. The identifier is also the webhook-id header, and it never changes across retries or a redelivery, so a merchant can deduplicate on it.',
  });

export const WebhookDeliveryListSchema = z
  .object({
    data: z.array(WebhookDeliverySchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'WebhookDeliveryList' });

export const ListWebhookDeliveriesQuerySchema = z
  .object({
    status: WebhookDeliveryStatusSchema.optional(),
    paymentIdentifier: PaymentIdentifierSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    startingAfter: WebhookDeliveryIdentifierSchema.optional(),
  })
  .meta({ id: 'ListWebhookDeliveriesQuery' });

export const WebhookSecretSchema = z
  .object({
    identifier: z.string(),
    /** Shown once, at creation. Afterwards only the prefix is ever returned. */
    secret: z.string().nullable(),
    hint: z.string(),
    createdAt: z.iso.datetime(),
    retiredAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: 'WebhookSecret',
    description:
      'A signing secret. Rotation is by overlap: both secrets sign during the grace period, so an endpoint that has not been updated yet keeps verifying.',
  });

export const ValidationIssueSchema = z
  .object({ path: z.string(), message: z.string() })
  .meta({ id: 'ValidationIssue' });

/** RFC 9457 problem details. Every error response in the API uses this shape. */
export const ProblemDetailsSchema = z
  .object({
    type: z.string().meta({ example: 'https://cryptopay.dev/problems/invalid-payment-transition' }),
    title: z.string().meta({ example: 'Invalid payment transition' }),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string().optional(),
    code: z.string().meta({
      description: 'Stable machine-readable slug. Safe to branch on; the title is not.',
      example: 'invalid_payment_transition',
    }),
    requestId: z.string(),
    errors: z
      .array(ValidationIssueSchema)
      .optional()
      .meta({ description: 'Field-level validation failures, when the status is 422' }),
  })
  .meta({ id: 'ProblemDetails' });

export const NetworkDescriptorSchema = z
  .object({
    network: NetworkIdentifierSchema,
    networkFamily: NetworkFamilySchema,
    ledgerIdentity: z.string().nullable().meta({
      description:
        'What the chain calls itself, compared as an opaque string when a connection is opened. Asserting it is what stops an endpoint quietly serving a different chain. Null on a local development chain, whose genesis is created when it starts and is read from the node rather than configured.',
    }),
    addressForm: z.enum(['evm-lowercase-hex', 'tron-base58check', 'solana-base58']).meta({
      description:
        'How an account is written on this network. Base58 is case sensitive, so a lowercased TRON or Solana address is a different address that nobody controls.',
    }),
    capabilities: NetworkCapabilitiesSchema,
    chainIdentifier: z.number().int().positive().nullable().meta({
      description:
        'The EVM chain id, or null on a network whose family has no numeric chain identity. TRON and Solana identify themselves by a genesis or first-block reference instead.',
    }),
    displayName: z.string(),
    environment: EnvironmentSchema,
    nativeCurrency: z.object({ symbol: z.string(), decimals: z.number().int() }),
    requiredConfirmations: z.number().int().min(0).meta({
      description:
        'How many confirmations this deployment requires. Policy, not a chain constant, and the finality tag is the authoritative gate above it.',
    }),
    requiresFinalityTag: z.boolean().meta({
      description:
        'Whether a payment on this network additionally waits for the chain finality tag to cover its settling block.',
    }),
    assets: z.array(AssetSchema).meta({
      description:
        'Every asset this deployment credits on this network, identified by contract address. An asset absent from this list is never credited, whatever symbol it reports.',
    }),
    scan: z
      .object({
        lastScannedHeight: BlockHeightSchema,
        finalizedHeight: BlockHeightSchema.nullable(),
        halted: z.boolean(),
        haltedReason: z.string().nullable(),
        updatedAt: z.iso.datetime(),
      })
      .meta({
        description:
          'Where the scanner has reached on this network. A halted network is the failure that is otherwise invisible: payments keep being created and nothing is ever detected.',
      }),
    explorerBaseUrl: z.string(),
    walletRpcUrl: z.url().nullable().meta({
      description:
        'A keyless RPC URL safe to hand a wallet for wallet_addEthereumChain. Provider-keyed URLs are never returned.',
    }),
  })
  .meta({ id: 'NetworkDescriptor' });

export const SettlementStatusSchema = z
  .enum(SETTLEMENT_STATUSES as unknown as [string, ...string[]])
  .meta({
    id: 'SettlementStatus',
    description:
      'Where the outbound half of a payment has reached. Separate from the payment status, which a failed sweep must never be able to make uncertain again.',
  });

export const ChainTransactionSchema = z
  .object({
    purpose: z.enum(['gas_funding', 'asset_sweep']).meta({
      description:
        'A deposit address holds no native currency, so it cannot pay for its own transfer. The treasury funds it first; that is gas_funding.',
    }),
    status: z.enum(['submitted', 'confirming', 'confirmed', 'reverted', 'dropped', 'replaced']),
    sourceAccount: AccountSchema,
    destinationAccount: AccountSchema,
    transactionReference: TransactionReferenceSchema,
    /** What an EVM chain calls a nonce. At most one live transaction per account may hold each. */
    sequenceNumber: z.number().int().min(0),
    valueInNativeUnits: z.string().regex(BASE_UNITS_PATTERN),
    maximumFeeInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).meta({
      description: 'The upper bound computed before signing. The spend ceiling reasons on this.',
    }),
    feePaidInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).nullable(),
    computeUsed: z.string().regex(BASE_UNITS_PATTERN).nullable().meta({
      description: 'Gas used, on an EVM chain.',
    }),
    feeParameters: z.record(z.string(), z.string()).meta({
      description:
        'The chain-specific fee fields exactly as signed. On an EVM chain: the gas limit and both EIP-1559 prices.',
    }),
    blockHeight: BlockHeightSchema.nullable(),
    explorerUrl: z.url().nullable(),
    failureReason: z.string().nullable(),
    submittedAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: 'ChainTransaction',
    description: 'One transaction this system signed and broadcast, and what became of it.',
  });

export const SettlementSchema = z
  .object({
    identifier: z.string(),
    paymentIdentifier: PaymentIdentifierSchema,
    network: NetworkIdentifierSchema,
    environment: EnvironmentSchema,
    status: SettlementStatusSchema,
    sourceAccount: AccountSchema.meta({
      description: 'The deposit address the customer paid into.',
    }),
    destinationAccount: AccountSchema.meta({ description: "The merchant's payout account." }),
    asset: AssetSchema,
    amount: AmountSchema.meta({
      description:
        'Read from the chain when the settlement was planned, not copied from the credited figure. The balance is what can actually move.',
    }),
    attemptCount: z.number().int().min(0),
    failureReason: z.string().nullable(),
    transactions: z.array(ChainTransactionSchema),
    createdAt: z.iso.datetime(),
    settledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Settlement' });

export const SettlementListSchema = z
  .object({
    data: z.array(SettlementSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'SettlementList' });

export const PayoutDestinationSchema = z
  .object({
    network: NetworkIdentifierSchema,
    environment: EnvironmentSchema,
    account: AccountSchema,
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'PayoutDestination',
    description:
      'Where settled funds are sent. Per network as well as per environment: an address you control on one chain is not necessarily yours on another.',
  });

export const PayoutDestinationListSchema = z
  .object({ data: z.array(PayoutDestinationSchema) })
  .meta({ id: 'PayoutDestinationList' });

export const SetPayoutDestinationRequestSchema = z
  .object({ account: AccountSchema })
  .meta({ id: 'SetPayoutDestinationRequest' });

export const TreasuryReportSchema = z
  .object({
    network: NetworkIdentifierSchema,
    displayName: z.string(),
    environment: EnvironmentSchema,
    account: AccountSchema.meta({
      description: 'The account that pays for gas. Fund this to let settlement run.',
    }),
    nativeCurrency: z.object({ symbol: z.string(), decimals: z.number().int() }),
    balanceInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).nullable().meta({
      description: 'Null when no endpoint could be reached, which is not the same as zero.',
    }),
    /** Null means unbounded, which the API refuses to allow in production. */
    ceilingInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).nullable(),
    committedInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).meta({
      description:
        'Everything spent or promised: receipts where there are receipts, worst cases where there are not.',
    }),
    remainingInNativeUnits: z.string().regex(BASE_UNITS_PATTERN).nullable(),
    settlementEnabled: z.boolean(),
  })
  .meta({
    id: 'TreasuryReport',
    description:
      'What this deployment can spend on a network, and what it has spent. The ceiling is enforced before signing, not reported after.',
  });

export const TreasuryReportListSchema = z
  .object({ data: z.array(TreasuryReportSchema) })
  .meta({ id: 'TreasuryReportList' });

/**
 * What a caller may hand to `POST /v1/payments`, as data.
 *
 * An integrator discovers the networks, the assets and the confirmation policy rather than
 * hardcoding them, so a deployment that adds a network becomes a value in this list rather than a
 * release on their side.
 */
export const NetworkListSchema = z
  .object({ data: z.array(NetworkDescriptorSchema) })
  .meta({ id: 'NetworkList' });

export const PaymentTransferListSchema = z
  .object({ data: z.array(PaymentTransferSchema) })
  .meta({ id: 'PaymentTransferList' });

export const PaymentTimelineSchema = z
  .object({ data: z.array(PaymentStatusChangeSchema) })
  .meta({ id: 'PaymentTimeline' });

/** The deliveries of one payment. Without the per-attempt detail, which the delivery resource has. */
export const PaymentDeliverySummarySchema = z
  .object({
    identifier: WebhookDeliveryIdentifierSchema,
    eventType: z.string(),
    destinationUrl: z.string(),
    status: WebhookDeliveryStatusSchema,
    attemptCount: z.number().int().min(0),
    deliveredAt: z.iso.datetime().nullable(),
    lastFailure: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PaymentDeliverySummary' });

export const PaymentDeliveryListSchema = z
  .object({ data: z.array(PaymentDeliverySummarySchema) })
  .meta({ id: 'PaymentDeliveryList' });

export const WebhookSecretListSchema = z
  .object({ data: z.array(WebhookSecretSchema) })
  .meta({ id: 'WebhookSecretList' });

export const HealthReportSchema = z.object({ status: z.literal('ok') }).meta({
  id: 'HealthReport',
  description: 'Liveness only. It depends on nothing else by design.',
});

export const ComponentStatusSchema = z.enum(['ok', 'degraded', 'failed']);

export const ReadinessComponentSchema = z
  .object({ name: z.string(), status: ComponentStatusSchema, detail: z.string() })
  .meta({ id: 'ReadinessComponent' });

export const ReadinessReportSchema = z
  .object({
    status: ComponentStatusSchema,
    callbackSsrfPolicy: z.enum(['strict', 'relaxed']),
    uptimeSeconds: z.number().int().min(0),
    components: z.array(ReadinessComponentSchema),
  })
  .meta({
    id: 'ReadinessReport',
    description:
      'Each dependency reported separately, so an operator sees which one is at fault. A halted network is degraded rather than failed: the API still answers.',
  });

export const MerchantSchema = z
  .object({
    identifier: z.string(),
    displayName: z.string(),
    environment: EnvironmentSchema,
    underpaymentToleranceBasisPoints: z.number().int().min(0),
    overpaymentToleranceBasisPoints: z.number().int().min(0),
    defaultPaymentLifetimeSeconds: z.number().int().positive(),
  })
  .meta({ id: 'Merchant' });

export type Payment = z.infer<typeof PaymentSchema>;
export type PaymentTransfer = z.infer<typeof PaymentTransferSchema>;
export type PaymentStatusChange = z.infer<typeof PaymentStatusChangeSchema>;
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;
export type PaymentList = z.infer<typeof PaymentListSchema>;
export type Checkout = z.infer<typeof CheckoutSchema>;
export type TransactionHintRequest = z.infer<typeof TransactionHintRequestSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type NetworkDescriptor = z.infer<typeof NetworkDescriptorSchema>;
export type Merchant = z.infer<typeof MerchantSchema>;
export type NetworkList = z.infer<typeof NetworkListSchema>;
export type Settlement = z.infer<typeof SettlementSchema>;
export type SettlementList = z.infer<typeof SettlementListSchema>;
export type ChainTransaction = z.infer<typeof ChainTransactionSchema>;
export type PayoutDestination = z.infer<typeof PayoutDestinationSchema>;
export type PayoutDestinationList = z.infer<typeof PayoutDestinationListSchema>;
export type TreasuryReport = z.infer<typeof TreasuryReportSchema>;
export type TreasuryReportList = z.infer<typeof TreasuryReportListSchema>;
export type PaymentTransferList = z.infer<typeof PaymentTransferListSchema>;
export type PaymentTimeline = z.infer<typeof PaymentTimelineSchema>;
export type PaymentDeliverySummary = z.infer<typeof PaymentDeliverySummarySchema>;
export type PaymentDeliveryList = z.infer<typeof PaymentDeliveryListSchema>;
export type WebhookSecretList = z.infer<typeof WebhookSecretListSchema>;
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;
export type WebhookDeliveryList = z.infer<typeof WebhookDeliveryListSchema>;
export type WebhookAttempt = z.infer<typeof WebhookAttemptSchema>;
export type WebhookSecret = z.infer<typeof WebhookSecretSchema>;
export type Amount = z.infer<typeof AmountSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type CallbackUrl = z.infer<typeof CallbackUrlSchema>;

/**
 * The contract and the capability record are written out separately, so this asserts at import time
 * that neither grew a flag the other does not publish. A capability the API cannot describe is one
 * an integrator cannot check before sending money.
 */
const publishedCapabilities = Object.keys(NetworkCapabilitiesSchema.shape).toSorted((left, right) =>
  left.localeCompare(right),
);
const declaredCapabilities = [...CAPABILITY_NAMES].toSorted((left, right) =>
  left.localeCompare(right),
);
if (publishedCapabilities.join(',') !== declaredCapabilities.join(',')) {
  throw new Error(
    `Network capability contract drift: published ${publishedCapabilities.join(',')} against declared ${declaredCapabilities.join(',')}`,
  );
}
