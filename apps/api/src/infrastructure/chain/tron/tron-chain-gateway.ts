import {
  ERC20_TRANSFER_EVENT_TOPIC,
  type ChainProgress,
  type ChainTransferReference,
  type LedgerHeader,
  type LedgerPosition,
  type NetworkIdentifier,
  type ObservedTransfer,
} from '@cryptopay/shared';

import {
  LedgerIdentityMismatchError,
  LedgerRangeTooWideError,
  type ChainGateway,
  type FinalityConfirmation,
  type LedgerPositionLookup,
  type TransferReconciliation,
  type TransferScanRequest,
  type TransferScanResult,
} from '../../../application/ports/chain-gateway.port.js';
import { NATIVE_ASSET_REFERENCE } from '../token-registry.js';
import { encodeTronAddress, tronAddressFromLogValue } from './address.js';
import {
  TronTransportError,
  type TronBlock,
  type TronBlockHeader,
  type TronEventLog,
  type TronNode,
} from './tron-client.js';

/**
 * TRON as a read oracle, in the same ledger vocabulary the payment engine speaks.
 *
 * Three things differ from the EVM adapter in ways that are not cosmetic.
 *
 * The chain names itself with its genesis block identifier rather than a number, which is why the
 * port compares ledger identity as an opaque string. Asserting it is what stops a Nile endpoint
 * being used where mainnet was configured.
 *
 * Finality is published rather than inferred. The solidified head is the block two thirds of the
 * super representatives have confirmed, so `finalizedHeight` is a fact TRON states rather than a
 * count this system chose.
 *
 * A native transfer and a TRC-20 transfer arrive through completely different responses: one is a
 * TransferContract in the block body, the other a Transfer event in the transaction info. Both are
 * read, and each is read only when something is actually watching for it.
 */

/**
 * The same Transfer event signature the EVM adapter matches on, derived from the shared constant
 * rather than written out again. TRON reports topics without the 0x prefix, and that difference is
 * the only thing this line encodes.
 */
const TRANSFER_EVENT_TOPIC = ERC20_TRANSFER_EVENT_TOPIC.slice(2);

const TRANSFER_CONTRACT_TYPE = 'TransferContract';

/**
 * TRON has no log filter, so a scan reads whole blocks. Every block costs one request for its body
 * and, when a token is watched, one more for its events, so the window is bounded far below the EVM
 * adapter's. Blocks are three seconds apart, so two hundred blocks is ten minutes of catch-up per
 * tick, which is faster than the chain produces them.
 */
const MAXIMUM_SCAN_BLOCKS = 200;

export interface TronChainGatewayOptions {
  readonly networkIdentifier: NetworkIdentifier;
  readonly node: TronNode;
  /** The genesis block identifier this network must report. */
  readonly expectedLedgerIdentity: string;
}

/**
 * TRON reports its genesis identity as bare hex; this repository writes every hash with an 0x
 * prefix, partly by convention and partly because a bare sixty-four character hex constant is
 * indistinguishable from a private key to any scanner. Both sides are normalised so the comparison
 * is about the chain rather than about how the value was spelled.
 */
function normaliseIdentity(identity: string): string {
  const lowercase = identity.toLowerCase();
  return lowercase.startsWith('0x') ? lowercase.slice(2) : lowercase;
}

function toPosition(header: TronBlockHeader): LedgerPosition {
  return { height: BigInt(header.number), reference: header.blockId };
}

function toLedgerHeader(header: TronBlockHeader): LedgerHeader {
  return { position: toPosition(header), parentReference: header.parentHash };
}

/**
 * A TRC-20 Transfer, or nothing.
 *
 * The recipient is read from the topic and converted with TRON's own address rule, not the EVM one.
 * TronGrid reports log values as bare twenty byte hex with the 0x41 prefix stripped, so reading them
 * as EVM addresses produces well-formed identities that belong to nobody, and a payment matched
 * against one is never credited.
 */
function decodeTokenTransfer(
  log: TronEventLog,
  watchedAccounts: ReadonlySet<string>,
  watchedAssets: ReadonlySet<string>,
): { readonly account: string; readonly source: string; readonly amount: bigint } | null {
  if (!log.succeeded || log.topics[0] !== TRANSFER_EVENT_TOPIC || log.topics.length < 3) {
    return null;
  }
  const contract = tronAddressFromLogValue(log.contractAddressHex);
  if (!watchedAssets.has(contract)) {
    return null;
  }
  const recipient = tronAddressFromLogValue(log.topics[2] ?? '');
  if (!watchedAccounts.has(recipient)) {
    return null;
  }
  const amount = log.data === '' ? 0n : BigInt(`0x${log.data}`);
  if (amount <= 0n) {
    return null;
  }
  return { account: recipient, source: tronAddressFromLogValue(log.topics[1] ?? ''), amount };
}

export class TronChainGateway implements ChainGateway {
  private readonly node: TronNode;
  private readonly expectedLedgerIdentity: string;

  readonly networkIdentifier: NetworkIdentifier;
  /** The solidified head is a published finality tag, so TRON needs no confirmation count to stand in. */
  readonly supportsFinalityTag = true;

  constructor(options: TronChainGatewayOptions) {
    this.networkIdentifier = options.networkIdentifier;
    this.node = options.node;
    this.expectedLedgerIdentity = normaliseIdentity(options.expectedLedgerIdentity);
  }

  async assertLedgerIdentity(): Promise<void> {
    const observed = normaliseIdentity(await this.node.readGenesisIdentity());
    if (observed !== this.expectedLedgerIdentity) {
      throw new LedgerIdentityMismatchError(this.expectedLedgerIdentity, observed);
    }
  }

  async readChainProgress(): Promise<ChainProgress> {
    const [head, solidified] = await Promise.all([
      this.node.readHead(),
      this.node.readSolidifiedHead(),
    ]);
    return {
      tip: toPosition(head),
      finalizedHeight: BigInt(solidified.number),
      observedAtMilliseconds: head.timestamp,
    };
  }

  /**
   * TRON publishes one solidified head for the whole chain, so a second opinion is a second read of
   * the same fact rather than a second provider's view of it. Reported honestly as such: the value
   * confirms or contradicts, and a request that fails says so instead of guessing.
   */
  async confirmFinalizedHeight(height: bigint): Promise<FinalityConfirmation> {
    try {
      const solidified = await this.node.readSolidifiedHead();
      return BigInt(solidified.number) >= height ? 'confirmed' : 'contradicted';
    } catch {
      return 'unavailable';
    }
  }

  async readPositionAtHeight(height: bigint): Promise<LedgerPositionLookup> {
    try {
      const block = await this.node.readBlock(Number(height));
      if (block === null) {
        // TRON keeps full history on an archive node, so an unanswered height is above the head
        // rather than pruned below it. Either way there is nothing to compare against.
        return { kind: 'absent' };
      }
      return { kind: 'present', header: toLedgerHeader(block.header) };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'the endpoint did not answer',
      };
    }
  }

  async scanIncomingTransfers(request: TransferScanRequest): Promise<TransferScanResult> {
    const fromHeight = Number(request.fromHeight);
    const toHeight = Number(request.toHeight);
    if (toHeight - fromHeight + 1 > MAXIMUM_SCAN_BLOCKS) {
      throw new LedgerRangeTooWideError(
        `TRON reads whole blocks, so a scan covers at most ${MAXIMUM_SCAN_BLOCKS} of them`,
      );
    }

    const watchedAccounts = new Set(request.watchedAccounts);
    const watchedAssets = new Set(
      request.assetReferences.filter((reference) => reference !== NATIVE_ASSET_REFERENCE),
    );
    const nativeIsWatched = request.assetReferences.includes(NATIVE_ASSET_REFERENCE);

    const blocks = await this.node.readBlockRange(fromHeight, toHeight);
    if (blocks.length === 0) {
      throw new TronTransportError(`no block was returned for ${fromHeight}..${toHeight}`);
    }

    const transfers: ObservedTransfer[] = [];
    for (const block of blocks) {
      if (nativeIsWatched) {
        transfers.push(...this.readNativeTransfers(block, watchedAccounts));
      }
      // One request per block, and only where a token is actually being watched. A deployment
      // taking native payments alone never pays for event reads at all.
      if (watchedAssets.size > 0) {
        const events = await this.node.readBlockEvents(block.header.number);
        transfers.push(...this.readTokenTransfers(block, events, watchedAccounts, watchedAssets));
      }
    }

    const headers = blocks
      .slice(Math.max(0, blocks.length - request.headerDepth))
      .map((block) => toLedgerHeader(block.header));
    const last = blocks.at(-1);
    if (last === undefined) {
      throw new TronTransportError('the block range came back empty after decoding');
    }

    return { scannedThrough: toLedgerHeader(last.header), headers, transfers };
  }

  private readNativeTransfers(
    block: TronBlock,
    watchedAccounts: ReadonlySet<string>,
  ): readonly ObservedTransfer[] {
    const transfers: ObservedTransfer[] = [];
    for (const transaction of block.transactions) {
      const contract = transaction.contract;
      if (!transaction.succeeded || contract?.type !== TRANSFER_CONTRACT_TYPE) {
        continue;
      }
      if (contract.toAddressHex === null || contract.amount === null || contract.amount <= 0n) {
        continue;
      }
      const recipient = encodeFromHexPayload(contract.toAddressHex);
      if (!watchedAccounts.has(recipient)) {
        continue;
      }
      transfers.push({
        reference: { transactionReference: transaction.transactionId, eventIndex: 0 },
        position: toPosition(block.header),
        destinationAccount: recipient,
        sourceAccount: encodeFromHexPayload(contract.ownerAddressHex),
        assetReference: NATIVE_ASSET_REFERENCE,
        amountInBaseUnits: contract.amount,
      });
    }
    return transfers;
  }

  private readTokenTransfers(
    block: TronBlock,
    events: readonly TronEventLog[],
    watchedAccounts: ReadonlySet<string>,
    watchedAssets: ReadonlySet<string>,
  ): readonly ObservedTransfer[] {
    const transfers: ObservedTransfer[] = [];
    for (const log of events) {
      const decoded = decodeTokenTransfer(log, watchedAccounts, watchedAssets);
      if (decoded === null) {
        continue;
      }
      transfers.push({
        // The log index within the transaction, so two Transfer events in one call stay distinct
        // under the uniqueness key that makes crediting exactly once.
        reference: { transactionReference: log.transactionId, eventIndex: log.logIndex },
        position: toPosition(block.header),
        destinationAccount: decoded.account,
        sourceAccount: decoded.source,
        assetReference: tronAddressFromLogValue(log.contractAddressHex),
        amountInBaseUnits: decoded.amount,
      });
    }
    return transfers;
  }

  async reconcileTransfer(
    reference: ChainTransferReference,
    expected: LedgerPosition,
  ): Promise<TransferReconciliation> {
    try {
      const found = await this.node.readTransaction(reference.transactionReference);
      if (found === null) {
        return { kind: 'orphaned' };
      }
      const block = await this.node.readBlock(found.blockHeight);
      if (block === null) {
        return { kind: 'indeterminate' };
      }
      // The position the transaction is at now. The caller compares it with the one it recorded and
      // decides; deciding here would duplicate the reorg rule in an adapter.
      void expected;
      return { kind: 'present', position: toPosition(block.header) };
    } catch {
      return { kind: 'indeterminate' };
    }
  }

  async readAssetBalance(account: string, assetReference: string): Promise<bigint> {
    if (assetReference === NATIVE_ASSET_REFERENCE) {
      return this.node.readNativeBalance(account);
    }
    return this.node.readTokenBalance(account, assetReference);
  }

  async readNativeBalance(account: string): Promise<bigint> {
    return this.node.readNativeBalance(account);
  }
}

/**
 * Contract parameters carry the full twenty-one byte payload with its 0x41 prefix, while log values
 * carry only the twenty byte key hash. Chosen by length rather than by inspecting the first byte,
 * because a key hash may legitimately begin with 0x41 and stripping it would silently corrupt one
 * address in every two hundred and fifty six.
 */
const PAYLOAD_HEX_LENGTH = 42;

function encodeFromHexPayload(payloadHex: string): string {
  const normalised = payloadHex.startsWith('0x') ? payloadHex.slice(2) : payloadHex;
  if (normalised.length === PAYLOAD_HEX_LENGTH) {
    return encodeTronAddress(normalised);
  }
  return tronAddressFromLogValue(normalised);
}
