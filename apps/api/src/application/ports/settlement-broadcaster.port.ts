import type { LedgerPosition, NetworkIdentifier } from '@cryptopay/shared';

/**
 * The write path to a blockchain, kept separate from the read path on purpose.
 *
 * `ChainGateway` is an oracle: it can answer questions and it holds no key material, so no amount of
 * misuse of the scanning code can move money. This port is the only thing in the system that can,
 * and everything about its shape follows from that.
 *
 * Estimating and broadcasting are separate calls rather than one. Between them the caller claims a
 * sequence number under a database lock and checks the spend ceiling, and both of those have to
 * happen after the cost is known and before anything is signed. A single `send` would make that
 * ordering impossible to enforce.
 *
 * The vocabulary is deliberately not EVM's. `sequenceNumber` is what an EVM chain calls a nonce and
 * what Solana derives from a recent blockhash; `feeParameters` is opaque here and holds the gas
 * limit and the two EIP-1559 prices in the adapter. The layers above reason about money and
 * ordering, which every chain has, and never about gas, which not every chain does.
 */

/** Which key signs. The caller names a role; only the adapter ever holds the key it resolves to. */
export type SigningRole =
  | { readonly kind: 'treasury' }
  /** A payment's own deposit address, derived from the sealed seed for the duration of one signature. */
  | { readonly kind: 'deposit'; readonly derivationIndex: number };

export interface FeeEstimate {
  /**
   * The most this transfer can cost in native base units, excluding the value being sent. The spend
   * ceiling reasons on this figure, so it must be an upper bound rather than an expectation.
   */
  readonly maximumFeeInNativeUnits: bigint;
  /**
   * Chain-specific fee fields, round-tripped into the broadcast and stored exactly as produced.
   * Storing them means a transaction can be replaced later with the same parameters and a higher
   * price, and that an operator can see what was actually asked for.
   */
  readonly feeParameters: Readonly<Record<string, string>>;
}

export type EstimateOutcome =
  | { readonly kind: 'estimated'; readonly estimate: FeeEstimate }
  /**
   * The chain says this call would fail. Distinct from `unavailable` because the answers are
   * opposite: this one must never be retried unchanged, and the other one must be.
   */
  | { readonly kind: 'would_revert'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type SignOutcome =
  | {
      readonly kind: 'signed';
      /** Known before anything is sent, which is the whole point of signing separately. */
      readonly transactionReference: string;
      /** Chain-specific signed bytes, submitted as they are and never rebuilt from parts. */
      readonly signedPayload: string;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export type SubmitResult =
  | { readonly kind: 'accepted' }
  /**
   * The endpoint answered, and the answer was no. Nothing reached the mempool, so the sequence
   * number is free again.
   */
  | { readonly kind: 'rejected'; readonly reason: string }
  /**
   * No answer. The transaction may or may not be in the mempool, and there is no way to tell from
   * here. The caller must already have recorded the reference before calling, and must resolve this
   * by asking the chain rather than by sending anything again.
   */
  | { readonly kind: 'indeterminate'; readonly reason: string };

export type BroadcastReconciliation =
  /** Not mined yet, and the account has not moved past this sequence number. */
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'mined';
      readonly position: LedgerPosition;
      readonly succeeded: boolean;
      readonly computeUsed: bigint;
      readonly feePaidInNativeUnits: bigint;
    }
  /**
   * The account's sequence has advanced past this transaction and this transaction is not on chain.
   * Something else took the slot, so this one can never be mined and the caller is free to plan
   * again. This is the only answer that makes a retry safe, and it is why a retry asks the chain
   * rather than assuming.
   */
  | { readonly kind: 'superseded' }
  /** No endpoint could answer. Change nothing and ask again; assuming either way risks a double send. */
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface AssetTransferRequest {
  readonly signingRole: SigningRole;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly assetReference: string;
  readonly amount: bigint;
}

export interface NativeTransferRequest {
  readonly signingRole: SigningRole;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly amountInNativeUnits: bigint;
}

export interface SettlementBroadcaster {
  readonly networkIdentifier: NetworkIdentifier;
  /** The account that funds gas. Exposed so the caller can read its balance and claim its sequence. */
  readonly treasuryAccount: string;

  /**
   * Confirms the endpoint is the chain that was configured, before anything is signed. A signature
   * is valid on every EVM chain at once, so broadcasting to an endpoint that quietly serves a
   * different one is how a testnet transaction becomes a mainnet transaction.
   */
  assertLedgerIdentity(): Promise<void>;

  estimateAssetTransfer(request: AssetTransferRequest): Promise<EstimateOutcome>;
  estimateNativeTransfer(request: NativeTransferRequest): Promise<EstimateOutcome>;

  /**
   * Signing and submitting are separate because the reference has to be knowable before anything is
   * sent. A submission that times out may still be in the mempool; without the reference recorded
   * first there is nothing to ask the chain about later, and the only remaining options are to send
   * again and risk paying twice, or to abandon funds.
   *
   * Signing is deterministic. Re-signing the identical request with the identical sequence number
   * and fee parameters produces the identical reference, so recovery after a crash between signing
   * and recording does not create a second transaction.
   */
  signAssetTransfer(
    request: AssetTransferRequest,
    sequenceNumber: number,
    estimate: FeeEstimate,
  ): Promise<SignOutcome>;

  signNativeTransfer(
    request: NativeTransferRequest,
    sequenceNumber: number,
    estimate: FeeEstimate,
  ): Promise<SignOutcome>;

  submit(signedPayload: string): Promise<SubmitResult>;

  reconcileBroadcast(
    transactionReference: string,
    sourceAccount: string,
    sequenceNumber: number,
  ): Promise<BroadcastReconciliation>;

  /** The chain's own count for an account, which is the authority the local allocator defers to. */
  readAccountSequence(account: string): Promise<number>;

  readNativeBalance(account: string): Promise<bigint>;

  readAssetBalance(account: string, assetReference: string): Promise<bigint>;
}
