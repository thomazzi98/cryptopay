import { createServer } from 'node:http';

import { NATIVE_ASSET_REFERENCE } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import {
  LedgerIdentityMismatchError,
  LedgerRangeTooWideError,
} from '../../../application/ports/chain-gateway.port.js';
import { SolanaChainGateway } from './solana-chain-gateway.js';
import {
  decodeSolanaBlock,
  HttpSolanaNode,
  type SolanaBlock,
  type SolanaNode,
} from './solana-client.js';

/**
 * What the adapter makes of what Solana says.
 *
 * The block and balance shapes here are the ones a devnet node really returns, including the two
 * that catch people out: a `parentSlot` that is not the slot before, because slots are skipped, and
 * an `owner` on every token balance, which is what makes matching an SPL payment possible without
 * deriving an associated token account.
 */

const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const PAYER = '7a5J7J7PSKoLf4n9FsvDV4oA7rPoZVMzYVqEvAJSXmAF';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OTHER_MINT = 'G2hQNzFttMafChpP6PvkvXFkVfBqXQPtF7SsVTvWWxHt';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** Solana names this field on transaction metadata; the abbreviation is the protocol's, not ours. */
const TRANSACTION_ERROR_FIELD = 'err';

const SIGNATURE =
  '3YCdv9yNh5be9mkYd3hgrzu7UjXkixr1L2NkYwqmo5vo3aJoGfk5w5ujo6M3dUpsoAG3RqAXVDgSy6dZNAVgJYKz';

/**
 * A raw block in the shape `getBlock` returns with `jsonParsed`, so the decoder is exercised rather
 * than bypassed. `parentSlot` is deliberately far below `slot`: on Solana that is normal, and an
 * adapter that assumed otherwise would call a healthy chain a fork.
 */
function rawBlock(options: {
  readonly slot: number;
  readonly succeeded?: boolean;
  readonly nativeBefore?: number;
  readonly nativeAfter?: number;
  readonly tokenOwner?: string;
  readonly mint?: string;
  readonly tokenBefore?: string;
  readonly tokenAfter?: string;
}): unknown {
  const tokenBalances =
    options.tokenOwner === undefined
      ? { pre: [], post: [] }
      : {
          pre:
            options.tokenBefore === undefined
              ? []
              : [
                  {
                    accountIndex: 1,
                    mint: options.mint ?? USDC_DEVNET,
                    owner: options.tokenOwner,
                    uiTokenAmount: { amount: options.tokenBefore },
                  },
                ],
          post: [
            {
              accountIndex: 1,
              mint: options.mint ?? USDC_DEVNET,
              owner: options.tokenOwner,
              uiTokenAmount: { amount: options.tokenAfter ?? '0' },
            },
          ],
        };

  return {
    blockhash: `blockhash-${options.slot}`,
    previousBlockhash: `blockhash-parent-${options.slot}`,
    parentSlot: options.slot - 26,
    blockTime: 1_757_000_000,
    transactions: [
      {
        transaction: {
          signatures: [SIGNATURE],
          message: { accountKeys: [{ pubkey: PAYER }, { pubkey: MERCHANT }] },
        },
        meta: {
          [TRANSACTION_ERROR_FIELD]:
            options.succeeded === false ? { InstructionError: [0, 'Custom'] } : null,
          preBalances: [1_000_000_000, options.nativeBefore ?? 0],
          postBalances: [900_000_000, options.nativeAfter ?? 0],
          preTokenBalances: tokenBalances.pre,
          postTokenBalances: tokenBalances.post,
        },
      },
    ],
  };
}

function blockAt(options: Parameters<typeof rawBlock>[0]): SolanaBlock {
  return decodeSolanaBlock(options.slot, rawBlock(options));
}

/**
 * Records the options each block request carried, so the request itself can be asserted rather than
 * only its result.
 */
interface StubOptions {
  readonly blocks?: readonly SolanaBlock[];
  readonly produced?: readonly number[];
  readonly finalizedSlot?: number;
  readonly genesis?: string;
  readonly signatureSlot?: number | null;
}

function stubNode(options: StubOptions = {}): SolanaNode {
  const blocks = options.blocks ?? [];
  return {
    readFinalizedSlot: () => Promise.resolve(options.finalizedSlot ?? 500),
    readGenesisIdentity: () => Promise.resolve(options.genesis ?? DEVNET_GENESIS),
    readProducedSlots: () =>
      Promise.resolve(options.produced ?? blocks.map((block) => block.header.slot)),
    readBlock: (slot) =>
      Promise.resolve(blocks.find((block) => block.header.slot === slot) ?? null),
    readSlotOfSignature: () => Promise.resolve(options.signatureSlot ?? null),
    readNativeBalance: () => Promise.resolve(2_500_000_000n),
    readTokenBalance: () => Promise.resolve(25_000_000n),
  };
}

function gatewayOver(node: SolanaNode): SolanaChainGateway {
  return new SolanaChainGateway({
    networkIdentifier: 'solana-devnet',
    node,
    expectedLedgerIdentity: DEVNET_GENESIS,
  });
}

const SCAN = { fromHeight: 100n, toHeight: 100n, headerDepth: 1 };

describe('what the adapter reports about the chain', () => {
  it('reads finalized only, so the tip it reports is already final', async () => {
    const progress = await gatewayOver(stubNode({ finalizedSlot: 500 })).readChainProgress();
    expect(progress.tip.height).toBe(500n);
    expect(progress.finalizedHeight).toBe(500n);
  });

  it('accepts the genesis hash it was configured with and refuses another chain', async () => {
    await expect(gatewayOver(stubNode()).assertLedgerIdentity()).resolves.toBeUndefined();
    await expect(
      gatewayOver(stubNode({ genesis: 'a-different-chain' })).assertLedgerIdentity(),
    ).rejects.toBeInstanceOf(LedgerIdentityMismatchError);
  });

  /**
   * The defect every design of this adapter is at risk of. A leader that fails to produce leaves an
   * empty slot; reporting that as absent or as an outage would halt a chain behaving exactly as
   * designed.
   */
  it('reports a skipped slot as skipped, not as missing history or an outage', async () => {
    const lookup = await gatewayOver(stubNode({ blocks: [] })).readPositionAtHeight(100n);
    expect(lookup.kind).toBe('skipped');
  });

  it('reports an endpoint that will not answer as unavailable', async () => {
    const failing: SolanaNode = {
      ...stubNode(),
      readBlock: () => Promise.reject(new Error('rate limited')),
    };
    const lookup = await gatewayOver(failing).readPositionAtHeight(100n);
    expect(lookup.kind).toBe('unavailable');
  });

  /**
   * A block's parent is routinely not the slot before it, so the header chain has to link by
   * identifier. This asserts the decoder keeps the parent the node reported rather than computing
   * one.
   */
  it('keeps the parent link the node reported instead of assuming the previous slot', async () => {
    const block = blockAt({ slot: 100 });
    const lookup = await gatewayOver(stubNode({ blocks: [block] })).readPositionAtHeight(100n);

    expect(lookup.kind).toBe('present');
    expect(block.header.parentSlot).toBe(74);
    expect(lookup.kind === 'present' ? lookup.header.parentReference : '').toBe(
      'blockhash-parent-100',
    );
  });

  it('refuses a scan window wider than it reads slot by slot', async () => {
    await expect(
      gatewayOver(stubNode()).scanIncomingTransfers({
        ...SCAN,
        toHeight: 100n + 900n,
        watchedAccounts: [MERCHANT],
        assetReferences: [NATIVE_ASSET_REFERENCE],
      }),
    ).rejects.toBeInstanceOf(LedgerRangeTooWideError);
  });

  it('advances through a window in which every slot was skipped', async () => {
    const result = await gatewayOver(stubNode({ blocks: [], produced: [] })).scanIncomingTransfers({
      ...SCAN,
      toHeight: 110n,
      watchedAccounts: [MERCHANT],
      assetReferences: [NATIVE_ASSET_REFERENCE],
    });
    expect(result.transfers).toEqual([]);
    expect(result.scannedThrough.position.height).toBe(110n);
  });
});

function scanNative(block: SolanaBlock, watched: string = MERCHANT) {
  return gatewayOver(stubNode({ blocks: [block] })).scanIncomingTransfers({
    ...SCAN,
    watchedAccounts: [watched],
    assetReferences: [NATIVE_ASSET_REFERENCE],
  });
}

function scanTokens(block: SolanaBlock, mints: readonly string[] = [USDC_DEVNET]) {
  return gatewayOver(stubNode({ blocks: [block] })).scanIncomingTransfers({
    ...SCAN,
    watchedAccounts: [MERCHANT],
    assetReferences: mints,
  });
}

describe('finding a native SOL payment', () => {
  it('credits the increase in a watched account balance', async () => {
    const result = await scanNative(
      blockAt({ slot: 100, nativeBefore: 0, nativeAfter: 2_500_000_000 }),
    );

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      destinationAccount: MERCHANT,
      assetReference: NATIVE_ASSET_REFERENCE,
      amountInBaseUnits: 2_500_000_000n,
    });
  });

  /**
   * A Solana transaction may debit several accounts, so there is no single sender to record. The
   * adapter used to record the credited account, which named the merchant's own deposit address as
   * the payer everywhere the field is displayed. Not knowing is reported as not knowing.
   */
  it('names no sender, rather than naming the account it credited', async () => {
    const result = await scanNative(
      blockAt({ slot: 100, nativeBefore: 0, nativeAfter: 2_500_000_000 }),
    );

    expect(result.transfers[0]?.sourceAccount).toBeNull();
    expect(result.transfers[0]?.destinationAccount).toBe(MERCHANT);
  });

  it('ignores an account whose balance fell, which is the payer', async () => {
    const result = await scanNative(
      blockAt({ slot: 100, nativeBefore: 0, nativeAfter: 2_500_000_000 }),
      PAYER,
    );
    expect(result.transfers).toEqual([]);
  });

  it('ignores an account nobody is watching', async () => {
    const result = await scanNative(
      blockAt({ slot: 100, nativeBefore: 0, nativeAfter: 2_500_000_000 }),
      'BPFLoaderUpgradeab1e11111111111111111111111',
    );
    expect(result.transfers).toEqual([]);
  });

  /** A failed transaction still pays a fee and still appears in the block; its transfers rolled back. */
  it('ignores a transaction that failed', async () => {
    const result = await scanNative(
      blockAt({ slot: 100, nativeBefore: 0, nativeAfter: 2_500_000_000, succeeded: false }),
    );
    expect(result.transfers).toEqual([]);
  });

  it('ignores a balance that did not change', async () => {
    const result = await scanNative(blockAt({ slot: 100, nativeBefore: 5000, nativeAfter: 5000 }));
    expect(result.transfers).toEqual([]);
  });
});

describe('finding an SPL token payment', () => {
  /**
   * The decision that keeps this adapter simple and correct. An SPL transfer credits a token
   * account rather than the wallet, and the node already resolved which wallet owns it. Matching on
   * that owner means no program-derived address is ever computed here, and a destination is watched
   * before its token account exists.
   */
  it('credits the wallet that owns the token account, not the token account', async () => {
    const result = await scanTokens(
      blockAt({ slot: 100, tokenOwner: MERCHANT, tokenBefore: '0', tokenAfter: '25000000' }),
    );

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      destinationAccount: MERCHANT,
      assetReference: USDC_DEVNET,
      amountInBaseUnits: 25_000_000n,
    });
  });

  /** A first payment arrives at a token account that did not exist, so there is no pre balance. */
  it('credits a first payment, where the token account had no previous balance', async () => {
    const result = await scanTokens(
      blockAt({ slot: 100, tokenOwner: MERCHANT, tokenAfter: '25000000' }),
    );
    expect(result.transfers[0]?.amountInBaseUnits).toBe(25_000_000n);
  });

  it('credits only the increase when the account already held a balance', async () => {
    const result = await scanTokens(
      blockAt({ slot: 100, tokenOwner: MERCHANT, tokenBefore: '10000000', tokenAfter: '35000000' }),
    );
    expect(result.transfers[0]?.amountInBaseUnits).toBe(25_000_000n);
  });

  it('ignores a mint nobody is watching', async () => {
    const result = await scanTokens(
      blockAt({
        slot: 100,
        tokenOwner: MERCHANT,
        mint: OTHER_MINT,
        tokenBefore: '0',
        tokenAfter: '25000000',
      }),
    );
    expect(result.transfers).toEqual([]);
  });

  it('ignores a token account owned by somebody else', async () => {
    const result = await scanTokens(
      blockAt({ slot: 100, tokenOwner: PAYER, tokenBefore: '0', tokenAfter: '25000000' }),
    );
    expect(result.transfers).toEqual([]);
  });

  it('ignores a token transfer in a transaction that failed', async () => {
    const result = await scanTokens(
      blockAt({
        slot: 100,
        tokenOwner: MERCHANT,
        tokenBefore: '0',
        tokenAfter: '25000000',
        succeeded: false,
      }),
    );
    expect(result.transfers).toEqual([]);
  });

  it('keeps a native and a token credit in one transaction distinct', async () => {
    const block = blockAt({
      slot: 100,
      nativeBefore: 0,
      nativeAfter: 1_000_000,
      tokenOwner: MERCHANT,
      tokenBefore: '0',
      tokenAfter: '25000000',
    });
    const result = await gatewayOver(stubNode({ blocks: [block] })).scanIncomingTransfers({
      ...SCAN,
      watchedAccounts: [MERCHANT],
      assetReferences: [NATIVE_ASSET_REFERENCE, USDC_DEVNET],
    });

    expect(result.transfers).toHaveLength(2);
    expect(result.transfers.map((transfer) => transfer.reference.eventIndex)).toEqual([0, 1]);
    expect(
      new Set(result.transfers.map((transfer) => transfer.reference.transactionReference)).size,
    ).toBe(1);
  });
});

describe('reconciling and reading balances', () => {
  it('reports a signature the chain no longer knows as orphaned', async () => {
    const node = stubNode({ signatureSlot: null, blocks: [blockAt({ slot: 100 })] });
    const result = await gatewayOver(node).reconcileTransfer(
      { transactionReference: SIGNATURE, eventIndex: 0 },
      { height: 100n, reference: 'blockhash-100' },
    );
    expect(result.kind).toBe('orphaned');
  });

  /**
   * A replica that has not indexed the recorded slot answers "unknown signature" exactly as a node
   * does for one that genuinely no longer exists. Only the second justifies withdrawing a credit,
   * so an endpoint that cannot serve that slot must not produce one.
   */
  it('leaves the row alone when the node cannot serve the slot it was recorded in', async () => {
    const result = await gatewayOver(stubNode({ signatureSlot: null })).reconcileTransfer(
      { transactionReference: SIGNATURE, eventIndex: 0 },
      { height: 100n, reference: 'blockhash-100' },
    );
    expect(result.kind).toBe('indeterminate');
  });

  it('leaves the row alone when the endpoint cannot answer', async () => {
    const failing: SolanaNode = {
      ...stubNode(),
      readSlotOfSignature: () => Promise.reject(new Error('rate limited')),
    };
    const result = await gatewayOver(failing).reconcileTransfer(
      { transactionReference: SIGNATURE, eventIndex: 0 },
      { height: 100n, reference: 'blockhash-100' },
    );
    expect(result.kind).toBe('indeterminate');
  });

  it('reads native and token balances through different calls', async () => {
    const gateway = gatewayOver(stubNode());
    await expect(gateway.readAssetBalance(MERCHANT, NATIVE_ASSET_REFERENCE)).resolves.toBe(
      2_500_000_000n,
    );
    await expect(gateway.readAssetBalance(MERCHANT, USDC_DEVNET)).resolves.toBe(25_000_000n);
  });
});

/**
 * A node refuses an entire block when it holds a transaction above the version the caller stated,
 * rather than omitting that one transaction. Devnet already carries version 1, so a client pinned
 * to version 0 stops scanning Solana altogether the moment a newer transaction lands in any block.
 * This is the regression guard for that, driven through the real HTTP client against a stub server.
 */
describe('the version a block request is willing to accept', () => {
  it('asks for a version high enough that a newer transaction cannot halt scanning', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const node = new HttpSolanaNode({ endpoint: `http://127.0.0.1:${port}` });
      await node.readBlock(100);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parameters = (requests[0]?.params as [number, Record<string, unknown>] | undefined)?.[1];
    expect(parameters?.maxSupportedTransactionVersion).toBeGreaterThan(1);
    expect(parameters?.commitment).toBe('finalized');
  });
});
