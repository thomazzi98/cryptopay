/**
 * The vocabulary the payment domain uses to talk about any blockchain.
 *
 * Every identifier here is an opaque string. On an EVM chain a transfer reference is a transaction
 * hash and an event index is a log index; on Solana they are a signature and a token-balance-delta
 * index; on Tron a txid. The domain never needs to know which, and nothing in this file may narrow
 * to a chain-specific shape such as viem's `0x${string}`.
 */

export type NetworkIdentifier =
  'polygon-mainnet' | 'polygon-amoy' | 'local-anvil' | 'tron-mainnet' | 'tron-nile';

export type Environment = 'live' | 'test';

export const NETWORK_IDENTIFIERS: readonly NetworkIdentifier[] = Object.freeze([
  'polygon-mainnet',
  'polygon-amoy',
  'local-anvil',
  'tron-mainnet',
  'tron-nile',
]);

export const ENVIRONMENTS: readonly Environment[] = Object.freeze(['live', 'test']);

export function isNetworkIdentifier(value: string): value is NetworkIdentifier {
  return (NETWORK_IDENTIFIERS as readonly string[]).includes(value);
}

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** A point in a ledger's history: how far along, and which one it was. */
export interface LedgerPosition {
  readonly height: bigint;
  readonly reference: string;
}

/**
 * A position plus the position it built on. Storing the parent is what lets a reorg be resolved by
 * walking backwards through observed history rather than guessing a depth.
 */
export interface LedgerHeader {
  readonly position: LedgerPosition;
  readonly parentReference: string;
}

/** Identifies one value movement within one ledger transaction. */
export interface ChainTransferReference {
  readonly transactionReference: string;
  readonly eventIndex: number;
}

/**
 * A transferable asset. `reference` is the identity: a lowercased contract address on an EVM chain,
 * a mint address on Solana. `symbol` is display only and must never be compared, because bridged
 * USDC.e reports the byte-identical symbol "USDC" as native USDC.
 */
export interface AssetDescriptor {
  readonly networkIdentifier: NetworkIdentifier;
  readonly reference: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** A value movement observed on chain, as read back from the ledger rather than reported by a client. */
export interface ObservedTransfer {
  readonly reference: ChainTransferReference;
  readonly position: LedgerPosition;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly assetReference: string;
  readonly amountInBaseUnits: bigint;
}

/**
 * How far a ledger has advanced. `finalizedHeight` is null on chains that expose no finality tag,
 * which is a capability difference rather than an error; the finality policy handles both.
 */
export interface ChainProgress {
  readonly tip: LedgerPosition;
  readonly finalizedHeight: bigint | null;
  readonly observedAtMilliseconds: number;
}

export function positionsAreEqual(left: LedgerPosition, right: LedgerPosition): boolean {
  return left.height === right.height && left.reference === right.reference;
}

export function transferReferencesAreEqual(
  left: ChainTransferReference,
  right: ChainTransferReference,
): boolean {
  return (
    left.transactionReference === right.transactionReference && left.eventIndex === right.eventIndex
  );
}

/**
 * The canonical key for a transfer. Used as the database uniqueness key that makes rescanning a
 * block range a no-op, which is what turns at-least-once scanning into exactly-once crediting.
 */
export function transferReferenceKey(reference: ChainTransferReference): string {
  return `${reference.transactionReference}:${reference.eventIndex}`;
}
