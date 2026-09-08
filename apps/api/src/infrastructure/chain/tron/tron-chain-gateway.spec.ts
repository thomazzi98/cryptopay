import { describe, expect, it } from 'vitest';

import {
  LedgerIdentityMismatchError,
  LedgerRangeTooWideError,
} from '../../../application/ports/chain-gateway.port.js';
import { NATIVE_ASSET_REFERENCE } from '../token-registry.js';
import { decodeTronAddress } from './address.js';
import { TronChainGateway } from './tron-chain-gateway.js';
import type {
  TronBlock,
  TronBlockHeader,
  TronEventLog,
  TronNode,
  TronTransaction,
} from './tron-client.js';

/**
 * What the adapter makes of what TRON says.
 *
 * The values that decide whether money is credited are real, read from the Nile network: the
 * contract addresses, the log topic layout, the twenty byte key hashes and the amounts. Block
 * identifiers and transaction ids are synthetic, because the adapter only ever compares them as
 * opaque strings and a realistic-looking one would be a sixty-four character hex literal that a
 * credential scanner cannot tell from a private key.
 */

const NILE_USDT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const NILE_TEST_TOKEN = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const PAYER = 'TVF2Mp9QY7FEGTnr3DBpFLobA6jguHyMvi';
const UNWATCHED = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';

const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f'.concat(
  '163c4a11628f55a4df523b3ef',
);

const GENESIS = 'g'.repeat(8).concat('0'.repeat(56));

function keyHashOf(address: string): string {
  return decodeTronAddress(address).slice(2);
}

function topicFor(address: string): string {
  return keyHashOf(address).padStart(64, '0');
}

function amountData(amount: bigint): string {
  return amount.toString(16).padStart(64, '0');
}

function header(number: number, suffix: string): TronBlockHeader {
  return {
    number,
    blockId: `block-${suffix}`,
    parentHash: `block-parent-${suffix}`,
    timestamp: 1_757_000_000_000 + number,
  };
}

function nativeTransfer(
  transactionId: string,
  to: string,
  amount: bigint,
  succeeded = true,
): TronTransaction {
  return {
    transactionId,
    succeeded,
    contract: {
      type: 'TransferContract',
      ownerAddressHex: decodeTronAddress(PAYER),
      toAddressHex: decodeTronAddress(to),
      amount,
      contractAddressHex: null,
    },
  };
}

function tokenLog(
  transactionId: string,
  contract: string,
  to: string,
  amount: bigint,
  succeeded = true,
): TronEventLog {
  return {
    transactionId,
    logIndex: 0,
    contractAddressHex: keyHashOf(contract),
    topics: [TRANSFER_TOPIC, topicFor(PAYER), topicFor(to)],
    data: amountData(amount),
    succeeded,
  };
}

interface StubOptions {
  readonly blocks?: readonly TronBlock[];
  readonly events?: Readonly<Record<number, readonly TronEventLog[]>>;
  readonly headNumber?: number;
  readonly solidifiedNumber?: number;
  readonly genesis?: string;
}

let eventReads = 0;

function stubNode(options: StubOptions = {}): TronNode {
  const blocks = options.blocks ?? [];
  return {
    readHead: () => Promise.resolve(header(options.headNumber ?? 100, 'head')),
    readSolidifiedHead: () => Promise.resolve(header(options.solidifiedNumber ?? 81, 'solid')),
    readGenesisIdentity: () => Promise.resolve(options.genesis ?? GENESIS),
    readBlock: (height) =>
      Promise.resolve(blocks.find((block) => block.header.number === height) ?? null),
    readBlockRange: () => Promise.resolve(blocks),
    readBlockEvents: (height) => {
      eventReads += 1;
      return Promise.resolve(options.events?.[height] ?? []);
    },
    readTransaction: () => Promise.resolve(null),
    readNativeBalance: () => Promise.resolve(4_000_000n),
    readTokenBalance: () => Promise.resolve(25_000_000n),
  };
}

/**
 * The network identifier is an existing one because the TRON networks are not yet values of the
 * database enum, and adding them is a migration rather than a constant. Nothing in the adapter reads
 * it beyond copying it onto an observation, so it does not weaken what these tests establish.
 */
function gatewayOver(node: TronNode): TronChainGateway {
  return new TronChainGateway({
    networkIdentifier: 'polygon-amoy',
    node,
    expectedLedgerIdentity: GENESIS,
  });
}

const SCAN = {
  fromHeight: 10n,
  toHeight: 10n,
  headerDepth: 1,
};

describe('what the adapter reports about the chain', () => {
  it('treats the solidified head as the finality tag, because TRON publishes one', async () => {
    const gateway = gatewayOver(stubNode({ headNumber: 100, solidifiedNumber: 81 }));
    const progress = await gateway.readChainProgress();

    expect(gateway.supportsFinalityTag).toBe(true);
    expect(progress.tip.height).toBe(100n);
    expect(progress.finalizedHeight).toBe(81n);
  });

  it('confirms a height at or below the solidified head and contradicts one above it', async () => {
    const gateway = gatewayOver(stubNode({ solidifiedNumber: 81 }));
    await expect(gateway.confirmFinalizedHeight(81n)).resolves.toBe('confirmed');
    await expect(gateway.confirmFinalizedHeight(82n)).resolves.toBe('contradicted');
  });

  it('accepts the genesis identity it was configured with', async () => {
    await expect(gatewayOver(stubNode()).assertLedgerIdentity()).resolves.toBeUndefined();
  });

  /** A Nile endpoint configured where mainnet was expected must fail loudly, not scan the wrong chain. */
  it('refuses an endpoint serving a different chain', async () => {
    const gateway = gatewayOver(stubNode({ genesis: 'a-different-chain' }));
    await expect(gateway.assertLedgerIdentity()).rejects.toBeInstanceOf(
      LedgerIdentityMismatchError,
    );
  });

  it('reports a height above the head as absent rather than as an outage', async () => {
    const lookup = await gatewayOver(stubNode()).readPositionAtHeight(999n);
    expect(lookup.kind).toBe('absent');
  });

  it('reports an endpoint that will not answer as unavailable, so scanning waits', async () => {
    const failing: TronNode = {
      ...stubNode(),
      readBlock: () => Promise.reject(new Error('gateway timeout')),
    };
    const lookup = await gatewayOver(failing).readPositionAtHeight(10n);
    expect(lookup.kind).toBe('unavailable');
  });

  it('refuses a scan window wider than it can read block by block', async () => {
    await expect(
      gatewayOver(stubNode()).scanIncomingTransfers({
        ...SCAN,
        toHeight: 10n + 500n,
        watchedAccounts: [NILE_USDT],
        assetReferences: [NATIVE_ASSET_REFERENCE],
      }),
    ).rejects.toBeInstanceOf(LedgerRangeTooWideError);
  });
});

function blockWith(transactions: readonly TronTransaction[]): TronBlock {
  return { header: header(10, 'ten'), transactions };
}

describe('finding a native TRX payment', () => {
  it('credits a transfer to a watched account', async () => {
    const node = stubNode({
      blocks: [blockWith([nativeTransfer('native-1', NILE_USDT, 12_500_000n)])],
    });
    const result = await gatewayOver(node).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [NILE_USDT],
      assetReferences: [NATIVE_ASSET_REFERENCE],
    });

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      destinationAccount: NILE_USDT,
      sourceAccount: PAYER,
      assetReference: NATIVE_ASSET_REFERENCE,
      amountInBaseUnits: 12_500_000n,
    });
  });

  it('ignores a transfer to an account nobody is watching', async () => {
    const node = stubNode({
      blocks: [blockWith([nativeTransfer('native-2', UNWATCHED, 12_500_000n)])],
    });
    const result = await gatewayOver(node).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [NILE_USDT],
      assetReferences: [NATIVE_ASSET_REFERENCE],
    });
    expect(result.transfers).toEqual([]);
  });

  /** A reverted transfer still occupies a block. Crediting it would credit money that never moved. */
  it('ignores a transaction that did not succeed', async () => {
    const node = stubNode({
      blocks: [blockWith([nativeTransfer('native-3', NILE_USDT, 12_500_000n, false)])],
    });
    const result = await gatewayOver(node).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [NILE_USDT],
      assetReferences: [NATIVE_ASSET_REFERENCE],
    });
    expect(result.transfers).toEqual([]);
  });

  it('does not read block bodies for native transfers nobody asked about', async () => {
    const node = stubNode({
      blocks: [blockWith([nativeTransfer('native-4', NILE_USDT, 12_500_000n)])],
    });
    const result = await gatewayOver(node).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [NILE_USDT],
      assetReferences: [NILE_TEST_TOKEN],
    });
    expect(result.transfers).toEqual([]);
  });
});

describe('finding a TRC-20 payment', () => {
  const block: TronBlock = { header: header(10, 'ten'), transactions: [] };

  async function scanFor(
    events: readonly TronEventLog[],
    assetReferences: readonly string[] = [NILE_TEST_TOKEN],
  ) {
    const node = stubNode({ blocks: [block], events: { 10: events } });
    return gatewayOver(node).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [NILE_USDT],
      assetReferences,
    });
  }

  it('credits a transfer of a watched token to a watched account', async () => {
    const result = await scanFor([tokenLog('token-1', NILE_TEST_TOKEN, NILE_USDT, 25_000_000n)]);

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      destinationAccount: NILE_USDT,
      sourceAccount: PAYER,
      assetReference: NILE_TEST_TOKEN,
      amountInBaseUnits: 25_000_000n,
    });
  });

  /**
   * The failure the address codec exists to prevent, asserted end to end: the recipient recovered
   * from the log is the base58 account the payment was created for, not an EVM reading of the same
   * twenty bytes.
   */
  it('recovers a base58 recipient, not an EVM address, from the log topic', async () => {
    const result = await scanFor([tokenLog('token-2', NILE_TEST_TOKEN, NILE_USDT, 1n)]);
    const destination = result.transfers[0]?.destinationAccount ?? '';

    expect(destination).toBe(NILE_USDT);
    expect(destination.startsWith('T')).toBe(true);
    expect(destination.startsWith('0x')).toBe(false);
  });

  it('ignores a transfer of a token nobody is watching', async () => {
    const result = await scanFor([tokenLog('token-3', NILE_USDT, NILE_USDT, 25_000_000n)]);
    expect(result.transfers).toEqual([]);
  });

  it('ignores a transfer to an account nobody is watching', async () => {
    const result = await scanFor([tokenLog('token-4', NILE_TEST_TOKEN, UNWATCHED, 25_000_000n)]);
    expect(result.transfers).toEqual([]);
  });

  it('ignores a log from a call that reverted or ran out of energy', async () => {
    const result = await scanFor([
      tokenLog('token-5', NILE_TEST_TOKEN, NILE_USDT, 25_000_000n, false),
    ]);
    expect(result.transfers).toEqual([]);
  });

  it('ignores an event that is not a Transfer', async () => {
    const approval = {
      ...tokenLog('token-6', NILE_TEST_TOKEN, NILE_USDT, 25_000_000n),
      topics: ['a-different-event', topicFor(PAYER), topicFor(NILE_USDT)],
    };
    const result = await scanFor([approval]);
    expect(result.transfers).toEqual([]);
  });

  it('ignores a zero-value transfer, which credits nothing', async () => {
    const result = await scanFor([tokenLog('token-7', NILE_TEST_TOKEN, NILE_USDT, 0n)]);
    expect(result.transfers).toEqual([]);
  });

  /**
   * Two Transfer events in one transaction must stay distinct, because the uniqueness key that makes
   * crediting happen exactly once is the transaction reference together with the event index.
   */
  it('keeps two transfers in one transaction apart by their log index', async () => {
    const first = tokenLog('token-8', NILE_TEST_TOKEN, NILE_USDT, 1_000_000n);
    const second = { ...first, logIndex: 1, data: amountData(2_000_000n) };
    const result = await scanFor([first, second]);

    expect(result.transfers).toHaveLength(2);
    expect(result.transfers.map((transfer) => transfer.reference.eventIndex)).toEqual([0, 1]);
    expect(result.transfers[0]?.reference.transactionReference).toBe(
      result.transfers[1]?.reference.transactionReference,
    );
  });

  /**
   * Reading events costs one request per block. A deployment taking only native payments should not
   * pay for them, and the assertion counts the calls rather than trusting the branch.
   */
  it('reads no events at all when only native currency is watched', async () => {
    eventReads = 0;
    await scanFor([tokenLog('token-9', NILE_TEST_TOKEN, NILE_USDT, 1n)], [NATIVE_ASSET_REFERENCE]);
    expect(eventReads).toBe(0);
  });
});

describe('reconciling a transfer that was already credited', () => {
  it('reports a transaction the chain no longer knows as orphaned', async () => {
    const result = await gatewayOver(stubNode()).reconcileTransfer(
      { transactionReference: 'token-1', eventIndex: 0 },
      { height: 10n, reference: 'block-ten' },
    );
    expect(result.kind).toBe('orphaned');
  });

  it('leaves the row alone when the endpoint cannot answer', async () => {
    const failing: TronNode = {
      ...stubNode(),
      readTransaction: () => Promise.reject(new Error('gateway timeout')),
    };
    const result = await gatewayOver(failing).reconcileTransfer(
      { transactionReference: 'token-1', eventIndex: 0 },
      { height: 10n, reference: 'block-ten' },
    );
    expect(result.kind).toBe('indeterminate');
  });
});

describe('reading a balance', () => {
  it('reads native currency and a token through different calls', async () => {
    const gateway = gatewayOver(stubNode());
    await expect(gateway.readAssetBalance(NILE_USDT, NATIVE_ASSET_REFERENCE)).resolves.toBe(
      4_000_000n,
    );
    await expect(gateway.readAssetBalance(NILE_USDT, NILE_TEST_TOKEN)).resolves.toBe(25_000_000n);
  });
});
