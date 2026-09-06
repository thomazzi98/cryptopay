import { z } from 'zod';

import { NETWORK_IDENTIFIERS } from './ledger-primitives.js';
import { PAYMENT_STATUSES } from './payment-status.js';

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
const LOWERCASE_ADDRESS_PATTERN = /^0x[\da-f]{40}$/;
const TRANSACTION_REFERENCE_PATTERN = /^0x[\da-f]{64}$/;

const IPV4_HOSTNAME_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES = ['.internal', '.local', '.home.arpa', '.localhost'];
const MAXIMUM_CALLBACK_URL_LENGTH = 2048;

/**
 * The static layer of the callback URL policy: everything decidable from the URL text alone, so a
 * merchant is told at registration time rather than after a failed delivery.
 *
 * Parsing is delegated entirely to WHATWG `new URL()` and only its parsed components are inspected.
 * That single step normalises the whole IPv4 encoding family, so `0177.0.0.1`, `127.1` and
 * `2130706433` all arrive here as `127.0.0.1`. Hand-rolled decoders are where bypasses live.
 *
 * This is not the whole defence. DNS resolution against the denied-range table, pinning the
 * resolved address for the connection, refusing redirects, and network containment of the delivery
 * worker are enforced server-side before every attempt.
 */
function refineCallbackUrl(value: string, context: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Must be a valid absolute URL' });
    return;
  }

  if (parsed.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Callback URLs must use https' });
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
  if (!hostname.includes('.')) {
    context.addIssue({
      code: 'custom',
      message: 'Callback URLs must use a fully qualified hostname',
    });
  }
  if (INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    context.addIssue({
      code: 'custom',
      message: 'Callback URLs must not target an internal hostname',
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
      'HTTPS endpoint that receives signed webhooks. Re-validated against the full SSRF policy, including DNS resolution, before every delivery attempt.',
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

export const EnvironmentSchema = z
  .enum(['live', 'test'])
  .meta({ description: 'Environment the payment belongs to. Determined by the API key used.' });

export const PaymentStatusSchema = z
  .enum(PAYMENT_STATUSES as unknown as [string, ...string[]])
  .meta({ description: 'Lifecycle status. See docs/state-machine.md for the transition table.' });

export const AccountSchema = z.string().regex(LOWERCASE_ADDRESS_PATTERN).meta({
  description: 'A blockchain account, always lowercase. Checksum it for display, never to compare.',
  example: '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d',
});

export const TransactionReferenceSchema = z
  .string()
  .regex(TRANSACTION_REFERENCE_PATTERN)
  .meta({ description: 'Transaction hash on an EVM network' });

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
    reference: z
      .string()
      .meta({ description: 'Contract address on an EVM network. This is the token identity.' }),
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
    sourceAccount: AccountSchema,
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

export const SettlementStatusSchema = z
  .enum(['not_started', 'funding_gas', 'sweeping', 'settled', 'failed'])
  .meta({
    description:
      'Sweeping the received funds. Orthogonal to payment status, so a settlement failure can never corrupt a completed payment.',
  });

export const PaymentSchema = z
  .object({
    identifier: PaymentIdentifierSchema,
    status: PaymentStatusSchema,
    statusVersion: z.number().int().min(0).meta({
      description: 'Increments on every applied change. Use it to discard out-of-order webhooks.',
    }),
    environment: EnvironmentSchema,
    network: NetworkIdentifierSchema,
    chainIdentifier: z.number().int().positive(),
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
    settlementStatus: SettlementStatusSchema,
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
    chainIdentifier: z.number().int().positive(),
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
    chainIdentifier: z.number().int().positive(),
    displayName: z.string(),
    environment: EnvironmentSchema,
    nativeCurrency: z.object({ symbol: z.string(), decimals: z.number().int() }),
    requiredConfirmations: z.number().int().min(0),
    measuredBlockIntervalMilliseconds: z.number().int().positive().nullable(),
    assets: z.array(AssetSchema),
    explorerBaseUrl: z.string(),
    walletRpcUrl: z.url().nullable().meta({
      description:
        'A keyless RPC URL safe to hand a wallet for wallet_addEthereumChain. Provider-keyed URLs are never returned.',
    }),
  })
  .meta({ id: 'NetworkDescriptor' });

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
export type Amount = z.infer<typeof AmountSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type CallbackUrl = z.infer<typeof CallbackUrlSchema>;
