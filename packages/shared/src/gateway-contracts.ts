import { z } from 'zod';

import { CallbackUrlSchema, MetadataSchema, NetworkFamilySchema } from './api-contracts.js';
import { PUBLIC_PAYMENT_STATES } from './public-payment-state.js';

/**
 * The contract an external payment gateway integrates against.
 *
 * Component names carry a Gateway prefix because one OpenAPI document describes both surfaces, and
 * `/v1` already publishes a Payment and a PaymentStatus that mean something different here.
 *
 * Deliberately a separate surface from `/v1` rather than a rename of it. The two answer different
 * questions: `/v1` serves a dashboard that wants the whole truth about a payment, including the
 * transfers that were orphaned and the exact internal status; this one serves an orchestrator that
 * wants to know what to tell a customer and when to release goods. Aliasing them would have forced
 * one shape to serve both and made every future change to either a breaking change to the other.
 *
 * Three rules hold throughout:
 *
 * - Amounts are decimal strings. A JSON number is a double, and a double cannot hold 18 decimals.
 * - A network is named by family, never by deployment. The caller says `polygon`; which Polygon
 *   network that means is decided by the API key's environment, so a test key cannot reach mainnet.
 * - Nothing derived from key material, and no persistence shape, is expressible here.
 */

const DECIMAL_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * What an API key is permitted to do. Reading payments and creating them are different powers, and
 * a key pasted into a reporting dashboard should not be able to take money.
 */
export const API_KEY_SCOPES = Object.freeze(['payments:read', 'payments:write'] as const);

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * A currency is a name this system publishes, never an address a caller invents. The pattern is
 * what makes that structural: a contract address cannot be spelled in it, so the "clients may not
 * name a token" rule is enforced at the edge of the system rather than deeper in.
 */
export const GatewayCurrencySchema = z
  .string()
  .regex(/^[A-Z\d]{2,10}$/)
  .meta({
    id: 'GatewayCurrency',
    description:
      'A logical currency this deployment supports, such as USDC, USDT, POL, TRX or SOL. Contract and mint addresses are never accepted here; the server resolves the currency to an asset itself.',
    example: 'USDC',
  });

export const PublicPaymentStateSchema = z
  .enum(PUBLIC_PAYMENT_STATES as unknown as [string, ...string[]])
  .meta({
    id: 'GatewayPaymentState',
    description:
      'The payment lifecycle. PAID covers an exact payment and an overpayment alike, so read amountReceived beside it; FAILED covers an underpayment, where the money is real but never reached the acceptance band.',
  });

export const CreateGatewayPaymentRequestSchema = z
  .object({
    externalReference: z.string().min(1).max(255).meta({
      description:
        'The caller identifier for this payment, echoed on the payment and on every webhook.',
      example: 'order_12345',
    }),
    network: NetworkFamilySchema.meta({
      description:
        'The chain family. Which deployment of it is used follows from the API key environment, so a test key cannot create a mainnet payment.',
      example: 'polygon',
    }),
    currency: GatewayCurrencySchema,
    amount: z.string().regex(DECIMAL_AMOUNT_PATTERN).meta({
      description:
        'Decimal amount as a string. Refused rather than rounded if it carries more precision than the currency holds.',
      example: '25.00',
    }),
    callbackUrl: CallbackUrlSchema.nullish(),
    expiresIn: z.number().int().min(60).max(86_400).nullish().meta({
      description: 'Seconds until the payment expires. The merchant default applies when omitted.',
      example: 1800,
    }),
    metadata: MetadataSchema.nullish(),
  })
  .meta({ id: 'CreateGatewayPaymentRequest' });

/**
 * Where the money should be sent. An abstraction rather than a bare address because the three
 * families do not agree on what identifies a destination: a memo is part of the destination on a
 * chain that has one, and is absent rather than empty on a chain that does not.
 */
export const PaymentDestinationSchema = z
  .object({
    address: z.string().meta({
      description:
        'The destination account, in that network own canonical form. EVM addresses are lowercase; TRON and Solana addresses are base58 and case sensitive, so compare them byte for byte.',
    }),
    memo: z.string().nullable().meta({
      description:
        'A reference the payer wallet carries back, on the families that have a field for one. Null where the family has none.',
    }),
  })
  .meta({ id: 'GatewayPaymentDestination' });

export const GatewayExplorerSchema = z
  .object({
    address: z.url().nullable(),
    transaction: z.url().nullable(),
  })
  .meta({
    id: 'GatewayExplorer',
    description:
      'Links a person can open. The transaction link is null until at least one transfer has been observed.',
  });

export const GatewayTransactionSchema = z
  .object({
    reference: z.string().meta({
      description:
        'How the chain names this transaction: a hash on Polygon, a transaction id on TRON, a signature on Solana.',
    }),
    amount: z.string().regex(DECIMAL_AMOUNT_PATTERN),
    status: z.enum(['DETECTED', 'CONFIRMING', 'CONFIRMED', 'ORPHANED', 'REJECTED']).meta({
      description:
        'ORPHANED means a reorganisation removed this transaction after it was seen. It is reported rather than deleted, because a merchant who was told about it needs to be told it is gone.',
    }),
    confirmations: z.number().int().min(0),
    explorerUrl: z.url().nullable(),
    observedAt: z.iso.datetime(),
  })
  .meta({ id: 'GatewayPaymentTransaction' });

export const GatewayPaymentSchema = z
  .object({
    id: z.string().meta({ example: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N' }),
    externalReference: z.string().nullable(),
    status: PublicPaymentStateSchema,
    network: NetworkFamilySchema,
    chainId: z.number().int().positive().nullable().meta({
      description:
        'The EVM chain id, or null on a family that does not identify itself with a number.',
    }),
    currency: GatewayCurrencySchema,
    amount: z.string().regex(DECIMAL_AMOUNT_PATTERN).meta({
      description: 'What was asked for.',
    }),
    amountReceived: z.string().regex(DECIMAL_AMOUNT_PATTERN).meta({
      description:
        'What has actually arrived and survived reorganisation. Read this beside PAID: an overpayment is also PAID.',
    }),
    paymentDestination: PaymentDestinationSchema,
    paymentUri: z.string().nullable().meta({
      description:
        'The request a wallet understands, in whatever standard the network uses. Null only where the network declares it cannot express one.',
    }),
    qrCode: z.string().nullable().meta({
      description: 'The payment URI as a scannable PNG data URI. Null wherever paymentUri is null.',
      example: 'data:image/png;base64,...',
    }),
    /**
     * Named as a reason rather than a code the caller must switch on. There is exactly one value
     * today and inventing a taxonomy for a set of size one is how unusable enums are born.
     */
    failureReason: z.enum(['insufficient_amount']).nullable(),
    explorer: GatewayExplorerSchema,
    transactions: z.array(GatewayTransactionSchema).meta({
      description:
        'Every chain transaction seen against this payment. One payment can have many: partial payments, a top-up, a duplicate, or a late arrival.',
    }),
    metadata: MetadataSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    paidAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GatewayPayment' });

/** The status endpoint answers the one question a poller asks, without the payload around it. */
export const GatewayPaymentStatusSchema = z
  .object({
    id: z.string(),
    status: PublicPaymentStateSchema,
    amount: z.string().regex(DECIMAL_AMOUNT_PATTERN),
    amountReceived: z.string().regex(DECIMAL_AMOUNT_PATTERN),
    confirmations: z.number().int().min(0),
    requiredConfirmations: z.number().int().min(0),
    failureReason: z.enum(['insufficient_amount']).nullable(),
    expiresAt: z.iso.datetime(),
    paidAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GatewayPaymentStatus' });

/**
 * Every error, in one shape. The code is the stable part an integration branches on; the message is
 * for a person reading a log and may be reworded at any time. Nothing else is present: a stack
 * trace, a driver message or an internal class name would leak table names and file paths, and the
 * request identifier is the way back to the log line that has all of it.
 */
export const GatewayErrorSchema = z
  .object({
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z\d_]*$/),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .meta({ id: 'GatewayError' });

export type CreateGatewayPaymentRequest = z.infer<typeof CreateGatewayPaymentRequestSchema>;
export type GatewayPayment = z.infer<typeof GatewayPaymentSchema>;
export type GatewayPaymentStatus = z.infer<typeof GatewayPaymentStatusSchema>;
export type GatewayTransaction = z.infer<typeof GatewayTransactionSchema>;
export type GatewayError = z.infer<typeof GatewayErrorSchema>;
