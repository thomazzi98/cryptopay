import type {
  ChainProgress,
  ChainTransferReference,
  LedgerHeader,
  LedgerPosition,
  NetworkIdentifier,
  ObservedTransfer,
} from '@cryptopay/shared';

/**
 * The read oracle for a blockchain.
 *
 * Everything here speaks ledger vocabulary with opaque string identifiers. There is no transaction
 * hash, no log index, no ABI and no chain id in this file, because those are EVM spellings of ideas
 * every chain has under a different name. Keeping them out is what makes a second chain an adapter
 * rather than a rewrite, and a lint rule enforces it in the layers above.
 *
 * Reading and writing are separate ports on purpose: this one never touches key material, so no
 * amount of misuse of the scanning path can sign anything.
 */

export type LedgerPositionLookup =
  | { readonly kind: 'present'; readonly header: LedgerHeader }
  /**
   * The height exists but produced no block. Free on an EVM chain, where every height has one, and
   * load-bearing on Solana, where a leader can fail to produce and the slot is legitimately empty.
   * Without this arm the ancestry check reads a healthy chain as a reorg and halts the scanner.
   */
  | { readonly kind: 'skipped' }
  /** Below the first height this node still retains. */
  | { readonly kind: 'absent' };

export type TransferReconciliation =
  | { readonly kind: 'present'; readonly position: LedgerPosition }
  | { readonly kind: 'orphaned' }
  /** The provider could not answer. Leave the row alone and ask again next tick. */
  | { readonly kind: 'indeterminate' };

export type FinalityConfirmation = 'confirmed' | 'contradicted' | 'unavailable';

/** The one chain-shaped failure the port declares, because the caller must respond by shrinking. */
export class LedgerRangeTooWideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerRangeTooWideError';
  }
}

export class LedgerIdentityMismatchError extends Error {
  constructor(expected: number, observed: number) {
    super(`The endpoint reported chain ${observed} where ${expected} was configured`);
    this.name = 'LedgerIdentityMismatchError';
  }
}

export interface TransferScanRequest {
  readonly fromHeight: bigint;
  readonly toHeight: bigint;
  readonly watchedAccounts: readonly string[];
  readonly assetReferences: readonly string[];
  /**
   * How many trailing headers of the window the caller needs, counted back from `toHeight`.
   *
   * Fork resolution walks a stored header chain, so the chain must not have gaps inside the depth a
   * reorg can reach. It may have gaps beyond it, and catching up across a million idle blocks would
   * otherwise cost a request per block for headers nothing will ever consult.
   */
  readonly headerDepth: number;
}

export interface TransferScanResult {
  readonly scannedThrough: LedgerHeader;
  /** The trailing headers of the scanned range, which is what makes fork resolution possible later. */
  readonly headers: readonly LedgerHeader[];
  readonly transfers: readonly ObservedTransfer[];
}

export interface ChainGateway {
  readonly networkIdentifier: NetworkIdentifier;
  readonly supportsFinalityTag: boolean;

  /**
   * Confirms the endpoint really is the chain that was configured. Called at startup and before a
   * network is marked ready, because an endpoint quietly serving a different chain would have every
   * payment fail validation for reasons that look like anything but a misconfiguration.
   */
  assertLedgerIdentity(): Promise<void>;

  readChainProgress(): Promise<ChainProgress>;

  /**
   * A second, independently operated provider's opinion on whether a height is final. Requested
   * only on ticks where a payment is otherwise ready to complete, so the cost is roughly one extra
   * call per completed payment rather than one per poll.
   */
  confirmFinalizedHeight(height: bigint): Promise<FinalityConfirmation>;

  readPositionAtHeight(height: bigint): Promise<LedgerPositionLookup>;

  scanIncomingTransfers(request: TransferScanRequest): Promise<TransferScanResult>;

  /**
   * Re-checks that a transfer recorded earlier is still on the canonical chain. This is the only
   * reorg-safe question to ask, and the answer must never be inferred from a cached receipt.
   */
  reconcileTransfer(
    reference: ChainTransferReference,
    expected: LedgerPosition,
  ): Promise<TransferReconciliation>;

  readAssetBalance(account: string, assetReference: string): Promise<bigint>;

  readNativeBalance(account: string): Promise<bigint>;
}
