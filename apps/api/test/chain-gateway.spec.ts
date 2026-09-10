import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  http,
  toEventSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { beforeAll, describe, expect, inject, it } from 'vitest';

import {
  LedgerIdentityMismatchError,
  type ChainGateway,
} from '../src/application/ports/chain-gateway.port.js';
import {
  EXPECTED_TRANSFER_TOPIC,
  EvmChainGateway,
} from '../src/infrastructure/chain/evm-chain-gateway.js';
import { anvilAccount, mineBlock } from './setup/anvil.global-setup.js';

/**
 * The gateway against a real EVM chain.
 *
 * These are the tests that decide whether a wrong amount can ever be credited. Every one of them
 * asks the same underlying question: does the system believe the chain, and only the chain?
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let rpcUrl: string;
let tokenAddress: string;
let gateway: ChainGateway;
let tokenAbi: Abi;

const payer = anvilAccount(0);
const customer = anvilAccount(1);
const RECEIVING_ACCOUNT = anvilAccount(5).address.toLowerCase();
const OTHER_ACCOUNT = anvilAccount(6).address.toLowerCase();

async function mint(to: string, amount: bigint): Promise<void> {
  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: tokenAddress as Address,
    abi: tokenAbi,
    functionName: 'mint',
    args: [to as Address, amount],
    account: payer,
    chain: null,
  });
  await mineBlock(rpcUrl);
}

async function transferToken(
  from: typeof payer,
  to: string,
  amount: bigint,
): Promise<{ hash: Hex; blockNumber: bigint }> {
  const wallet = createWalletClient({ account: from, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: tokenAddress as Address,
    abi: tokenAbi,
    functionName: 'transfer',
    args: [to as Address, amount],
    account: from,
    chain: null,
  });
  await mineBlock(rpcUrl);

  const client = createPublicClient({ transport: http(rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash });
  return { hash, blockNumber: receipt.blockNumber };
}

beforeAll(async () => {
  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress');

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  gateway = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });

  await mint(payer.address, 1_000_000_000n);
  await mint(customer.address, 1_000_000_000n);
});

describe('the Transfer event signature', () => {
  /**
   * The shared constant and the event the adapter filters on must be the same thing. If they ever
   * drift, the scanner silently matches nothing and every payment stays pending forever, which is
   * the most expensive way this system could fail quietly.
   */
  it('matches the topic derived from the event signature', () => {
    expect(EXPECTED_TRANSFER_TOPIC).toBe(toEventSelector('Transfer(address,address,uint256)'));
  });
});

describe('endpoint identity', () => {
  it('accepts an endpoint serving the configured chain', async () => {
    await expect(gateway.assertLedgerIdentity()).resolves.toBeUndefined();
  });

  /**
   * An endpoint quietly serving a different chain would make every payment fail validation for
   * reasons that look like anything but a misconfiguration, so it is caught at the boundary.
   */
  it('refuses an endpoint serving a different chain', async () => {
    const wrongChain = new EvmChainGateway({
      networkIdentifier: 'polygon-amoy',
      chainIdentifier: 80_002,
      rpcUrls: [rpcUrl],
      supportsFinalityTag: false,
    });
    await expect(wrongChain.assertLedgerIdentity()).rejects.toThrow(LedgerIdentityMismatchError);
  });
});

describe('reading chain progress', () => {
  it('reports the tip height and its reference', async () => {
    const progress = await gateway.readChainProgress();
    expect(progress.tip.height).toBeGreaterThan(0n);
    expect(progress.tip.reference).toMatch(/^0x[\da-f]{64}$/);
  });

  it('reports no finalized height on a chain that publishes no finality tag', async () => {
    const progress = await gateway.readChainProgress();
    expect(progress.finalizedHeight).toBeNull();
  });

  it('advances only when a block is mined, so confirmations are exact', async () => {
    const before = await gateway.readChainProgress();
    const stillBefore = await gateway.readChainProgress();
    expect(stillBefore.tip.height).toBe(before.tip.height);

    await mineBlock(rpcUrl);
    const after = await gateway.readChainProgress();
    expect(after.tip.height).toBe(before.tip.height + 1n);
  });
});

describe('reading a position by height', () => {
  it('returns the header and its parent', async () => {
    const progress = await gateway.readChainProgress();
    const lookup = await gateway.readPositionAtHeight(progress.tip.height);

    expect(lookup.kind).toBe('present');
    if (lookup.kind !== 'present') {
      return;
    }
    expect(lookup.header.position.height).toBe(progress.tip.height);
    expect(lookup.header.parentReference).toMatch(/^0x[\da-f]{64}$/);
  });

  it('chains each header to its parent, which is what makes fork resolution possible', async () => {
    const progress = await gateway.readChainProgress();
    const tip = await gateway.readPositionAtHeight(progress.tip.height);
    const parent = await gateway.readPositionAtHeight(progress.tip.height - 1n);

    expect(tip).toMatchObject({ kind: 'present' });
    expect(parent).toMatchObject({ kind: 'present' });

    const parentReference = tip.kind === 'present' ? tip.header.parentReference : null;
    const parentPosition = parent.kind === 'present' ? parent.header.position.reference : null;
    expect(parentReference).toBe(parentPosition);
  });

  it('reports a height beyond the tip as absent', async () => {
    const progress = await gateway.readChainProgress();
    const lookup = await gateway.readPositionAtHeight(progress.tip.height + 1000n);
    expect(lookup.kind).toBe('absent');
  });
});

describe('scanning incoming transfers', () => {
  it('finds a transfer to a watched account', async () => {
    const before = await gateway.readChainProgress();
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 25_000_000n);

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: sent.blockNumber,
      watchedAccounts: [RECEIVING_ACCOUNT],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });

    expect(result.transfers).toHaveLength(1);
    const transfer = result.transfers[0];
    expect(transfer?.destinationAccount).toBe(RECEIVING_ACCOUNT);
    expect(transfer?.sourceAccount).toBe(customer.address.toLowerCase());
    expect(transfer?.assetReference).toBe(tokenAddress);
    expect(transfer?.reference.transactionReference).toBe(sent.hash.toLowerCase());
  });

  /**
   * The amount is read from the event and from nowhere else. This is the assertion that makes a
   * forged or altered client hint worthless: whatever anyone claims, the credited value is the one
   * the chain recorded.
   */
  it('reads the amount from the chain, exactly', async () => {
    const before = await gateway.readChainProgress();
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 1_234_567n);

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: sent.blockNumber,
      watchedAccounts: [RECEIVING_ACCOUNT],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });

    expect(result.transfers[0]?.amountInBaseUnits).toBe(1_234_567n);
  });

  it('ignores a transfer to an account it is not watching', async () => {
    const before = await gateway.readChainProgress();
    const sent = await transferToken(customer, OTHER_ACCOUNT, 5_000_000n);

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: sent.blockNumber,
      watchedAccounts: [RECEIVING_ACCOUNT],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });

    expect(result.transfers).toHaveLength(0);
  });

  /**
   * Token identity is the contract address. Bridged USDC.e reports the byte-identical symbol as
   * native USDC, so a look-alike token must produce no credit at all.
   */
  it('ignores a transfer of a token it does not settle', async () => {
    const decoyAddress = '0x000000000000000000000000000000000000dead';
    const before = await gateway.readChainProgress();
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 9_000_000n);

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: sent.blockNumber,
      watchedAccounts: [RECEIVING_ACCOUNT],
      assetReferences: [decoyAddress],
      headerDepth: 8,
    });

    expect(result.transfers).toHaveLength(0);
  });

  it('finds several transfers to several watched accounts in one query', async () => {
    const before = await gateway.readChainProgress();
    await transferToken(customer, RECEIVING_ACCOUNT, 1000n);
    const last = await transferToken(customer, OTHER_ACCOUNT, 2000n);

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: last.blockNumber,
      watchedAccounts: [RECEIVING_ACCOUNT, OTHER_ACCOUNT],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });

    expect(result.transfers).toHaveLength(2);
  });

  it('returns the headers covering the scanned range', async () => {
    const before = await gateway.readChainProgress();
    await mineBlock(rpcUrl);
    await mineBlock(rpcUrl);
    const after = await gateway.readChainProgress();

    const result = await gateway.scanIncomingTransfers({
      fromHeight: before.tip.height + 1n,
      toHeight: after.tip.height,
      watchedAccounts: [RECEIVING_ACCOUNT],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });

    expect(result.headers).toHaveLength(2);
    expect(result.scannedThrough.position.height).toBe(after.tip.height);
  });

  it('returns nothing when there is nothing to watch', async () => {
    const progress = await gateway.readChainProgress();
    const result = await gateway.scanIncomingTransfers({
      fromHeight: progress.tip.height,
      toHeight: progress.tip.height,
      watchedAccounts: [],
      assetReferences: [tokenAddress],
      headerDepth: 8,
    });
    expect(result.transfers).toHaveLength(0);
  });
});

describe('reconciling a recorded transfer', () => {
  it('confirms a transfer still on the canonical chain', async () => {
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 3000n);
    const client = createPublicClient({ transport: http(rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: sent.hash });

    const outcome = await gateway.reconcileTransfer(
      { transactionReference: sent.hash.toLowerCase(), eventIndex: receipt.logs[0]?.logIndex ?? 0 },
      { height: sent.blockNumber, reference: receipt.blockHash.toLowerCase() },
    );
    expect(outcome.kind).toBe('present');
  });

  /**
   * Filtering by block hash rather than height is the whole point: a replacement block at the same
   * height would satisfy a height-based check and silently keep a withdrawn credit alive.
   */
  it('reports a transfer as orphaned when the recorded block no longer matches', async () => {
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 4000n);
    const outcome = await gateway.reconcileTransfer(
      { transactionReference: sent.hash.toLowerCase(), eventIndex: 0 },
      { height: sent.blockNumber, reference: `0x${'b'.repeat(64)}` },
    );
    expect(outcome.kind).toBe('orphaned');
  });

  it('reports a transaction that never existed as orphaned', async () => {
    const outcome = await gateway.reconcileTransfer(
      { transactionReference: `0x${'c'.repeat(64)}`, eventIndex: 0 },
      { height: 1n, reference: `0x${'d'.repeat(64)}` },
    );
    expect(outcome.kind).toBe('orphaned');
  });

  /**
   * The endpoint that answers is not necessarily one that knows. An endpoint which does not
   * implement `eth_getTransactionReceipt` at all replies that the method does not exist, which
   * reads like "not found" and is nothing of the kind: it is an infrastructure failure, and taking
   * it for a missing receipt would withdraw every credit it was asked about.
   */
  it('reports an endpoint that will not serve the receipt call as indeterminate', async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number;
          method: string;
        };
        const answer =
          call.method === 'eth_chainId'
            ? { jsonrpc: '2.0', id: call.id, result: '0x7a69' }
            : {
                jsonrpc: '2.0',
                id: call.id,
                error: { code: -32_601, message: 'the method eth_getTransactionReceipt not found' },
              };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((ready) => {
      server.listen(0, '127.0.0.1', ready);
    });
    const port = (server.address() as AddressInfo).port;
    const unhelpful = new EvmChainGateway({
      networkIdentifier: 'local-anvil',
      chainIdentifier: 31_337,
      rpcUrls: [`http://127.0.0.1:${port.toString()}`],
      supportsFinalityTag: false,
    });

    try {
      const outcome = await unhelpful.reconcileTransfer(
        { transactionReference: `0x${'e'.repeat(64)}`, eventIndex: 0 },
        { height: 1n, reference: `0x${'f'.repeat(64)}` },
      );
      expect(outcome.kind).toBe('indeterminate');
    } finally {
      await new Promise<void>((closed) => {
        server.close(() => {
          closed();
        });
      });
    }
  });

  it('reports an event index the transaction does not contain as orphaned', async () => {
    const sent = await transferToken(customer, RECEIVING_ACCOUNT, 5000n);
    const client = createPublicClient({ transport: http(rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: sent.hash });

    const outcome = await gateway.reconcileTransfer(
      { transactionReference: sent.hash.toLowerCase(), eventIndex: 9999 },
      { height: sent.blockNumber, reference: receipt.blockHash.toLowerCase() },
    );
    expect(outcome.kind).toBe('orphaned');
  });
});

describe('reading balances', () => {
  it('reads a token balance in base units', async () => {
    const balance = await gateway.readAssetBalance(RECEIVING_ACCOUNT, tokenAddress);
    expect(balance).toBeGreaterThan(0n);
  });

  it('reads a native balance', async () => {
    const balance = await gateway.readNativeBalance(customer.address);
    expect(balance).toBeGreaterThan(0n);
  });

  it('reports zero for an account that has never been funded', async () => {
    const balance = await gateway.readAssetBalance(
      '0x0000000000000000000000000000000000000123',
      tokenAddress,
    );
    expect(balance).toBe(0n);
  });
});

/**
 * Why a header read failed decides what the caller does with the answer, so the adapter has to tell
 * the two apart. Reporting an unreachable endpoint as a pruned block halted the whole network — and
 * a halt freezes completion and expiry for every payment on it until an operator resumes it by hand.
 */
describe('a header read that fails', () => {
  it('reports an unreachable endpoint as unavailable, not as a missing block', async () => {
    // A port nothing is listening on. Real transport failure, no stubbing.
    const unreachable = new EvmChainGateway({
      networkIdentifier: 'local-anvil',
      chainIdentifier: 31_337,
      rpcUrls: ['http://127.0.0.1:1'],
      supportsFinalityTag: false,
    });

    const lookup = await unreachable.readPositionAtHeight(1n);
    expect(lookup.kind).toBe('unavailable');
  });

  /**
   * A height the chain genuinely does not have is a different answer, and it must stay different:
   * this is the one that means the history the scanner relies on is gone.
   */
  it('reports a height above the tip as absent', async () => {
    const lookup = await gateway.readPositionAtHeight(99_999_999n);
    expect(lookup.kind).toBe('absent');
  });

  it('still reads a height the chain does have', async () => {
    const lookup = await gateway.readPositionAtHeight(1n);
    expect(lookup.kind).toBe('present');
  });
});
