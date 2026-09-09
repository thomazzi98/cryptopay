import {
  NATIVE_ASSET_REFERENCE,
  TRON_NILE_GENESIS_IDENTITY,
  USDT_TRON_NILE_ADDRESS,
} from '@cryptopay/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { LedgerIdentityMismatchError } from '../../src/application/ports/chain-gateway.port.js';
import { networkConfigurationFor } from '../../src/infrastructure/chain/network-configuration.js';
import { TronChainGateway } from '../../src/infrastructure/chain/tron/tron-chain-gateway.js';
import { HttpTronNode } from '../../src/infrastructure/chain/tron/tron-client.js';

/**
 * The TRON adapter against the real Nile network.
 *
 * Excluded from `npm test` and from the integration suite because it reads the public internet, and
 * run on demand with `npm run test:tron`. Nothing here spends anything: every assertion is a read,
 * and the transfer it checks was made by somebody else and has been on the chain for weeks.
 *
 * What this establishes that a recorded fixture cannot: that the shapes TronGrid actually returns
 * today still decode, that the solidified head really does trail the head, and above all that the
 * address the adapter recovers from an event log is the same address TronGrid's own
 * account-indexed API reports for that transfer. That last check is the important one, because it
 * compares this system's decoding against an independent answer from the same chain rather than
 * against its own expectations.
 */

const NILE_BASE_URL = 'https://nile.trongrid.io';

function gateway(): TronChainGateway {
  return new TronChainGateway({
    networkIdentifier: 'tron-nile',
    node: new HttpTronNode({ baseUrl: NILE_BASE_URL, apiKey: null, timeoutMilliseconds: 30_000 }),
    expectedLedgerIdentity: networkConfigurationFor('tron-nile').ledgerIdentity,
  });
}

interface IndexedTransfer {
  readonly transaction_id: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly token_info: { readonly address: string };
}

/** TronGrid's own account-indexed view, used as the independent answer to compare decoding against. */
async function readIndexedTransfer(): Promise<IndexedTransfer> {
  const response = await fetch(
    `${NILE_BASE_URL}/v1/accounts/${USDT_TRON_NILE_ADDRESS}/transactions/trc20?limit=1&only_confirmed=true`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const body = (await response.json()) as { data?: IndexedTransfer[] };
  const transfer = body.data?.[0];
  if (transfer === undefined) {
    throw new Error('Nile reported no confirmed TRC-20 transfer to compare against');
  }
  return transfer;
}

let indexed: IndexedTransfer;
let transferHeight: number;

beforeAll(async () => {
  indexed = await readIndexedTransfer();
  const info = await fetch(`${NILE_BASE_URL}/wallet/gettransactioninfobyid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: indexed.transaction_id }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await info.json()) as { blockNumber?: number };
  if (body.blockNumber === undefined) {
    throw new Error('Nile did not report a block for the transfer under test');
  }
  transferHeight = body.blockNumber;
});

describe('the Nile network as the adapter sees it', () => {
  it('reports the genesis identity this deployment was configured with', async () => {
    await expect(gateway().assertLedgerIdentity()).resolves.toBeUndefined();
    expect(networkConfigurationFor('tron-nile').ledgerIdentity).toBe(TRON_NILE_GENESIS_IDENTITY);
  });

  /** A mainnet identity configured against a Nile endpoint has to fail, or nothing stops the mix-up. */
  it('refuses when the configured identity is not the chain being served', async () => {
    const wrong = new TronChainGateway({
      networkIdentifier: 'tron-nile',
      node: new HttpTronNode({ baseUrl: NILE_BASE_URL, apiKey: null, timeoutMilliseconds: 30_000 }),
      expectedLedgerIdentity: networkConfigurationFor('tron-mainnet').ledgerIdentity,
    });
    await expect(wrong.assertLedgerIdentity()).rejects.toBeInstanceOf(LedgerIdentityMismatchError);
  });

  it('sees a solidified head that trails the head, which is the finality tag', async () => {
    const progress = await gateway().readChainProgress();

    expect(progress.tip.height).toBeGreaterThan(0n);
    expect(progress.finalizedHeight).not.toBeNull();
    expect(progress.finalizedHeight ?? 0n).toBeLessThanOrEqual(progress.tip.height);
    // TRON solidifies roughly nineteen blocks behind. A tag that had caught up to the head would
    // mean the endpoint is answering the same question twice.
    expect(progress.tip.height - (progress.finalizedHeight ?? 0n)).toBeGreaterThan(0n);
  });

  it('reads a real block and links it to its parent', async () => {
    const lookup = await gateway().readPositionAtHeight(BigInt(transferHeight));
    expect(lookup.kind).toBe('present');
    if (lookup.kind !== 'present') {
      return;
    }
    expect(lookup.header.position.height).toBe(BigInt(transferHeight));
    expect(lookup.header.position.reference).toMatch(/^[\da-f]{64}$/);

    // The parent link, checked without a branch: an absent parent yields null and fails the
    // comparison, which is the outcome that matters either way.
    const parent = await gateway().readPositionAtHeight(BigInt(transferHeight - 1));
    const parentReference = parent.kind === 'present' ? parent.header.position.reference : null;
    expect(parentReference).toBe(lookup.header.parentReference);
  });

  it('reports a height above the head as absent rather than as an outage', async () => {
    const progress = await gateway().readChainProgress();
    const lookup = await gateway().readPositionAtHeight(progress.tip.height + 1_000_000n);
    expect(lookup.kind).toBe('absent');
  });
});

describe('decoding a real TRC-20 transfer', () => {
  /**
   * The assertion the whole TRON address codec exists for, checked against an independent source.
   * The adapter reads the transfer out of the event log, where addresses are bare hex with the
   * 0x41 prefix stripped; TronGrid's account API reports the same transfer with base58 addresses it
   * decoded itself. If the two disagree, the adapter is watching an address nobody will ever pay.
   */
  it('recovers the same sender, recipient, token and amount that TronGrid reports', async () => {
    const result = await gateway().scanIncomingTransfers({
      fromHeight: BigInt(transferHeight),
      toHeight: BigInt(transferHeight),
      watchedAccounts: [indexed.to],
      assetReferences: [indexed.token_info.address],
      headerDepth: 1,
    });

    const found = result.transfers.find(
      (transfer) => transfer.reference.transactionReference === indexed.transaction_id,
    );
    expect(found).toBeDefined();
    expect(found?.destinationAccount).toBe(indexed.to);
    expect(found?.sourceAccount).toBe(indexed.from);
    expect(found?.assetReference).toBe(indexed.token_info.address);
    expect(found?.amountInBaseUnits).toBe(BigInt(indexed.value));
  });

  it('credits nothing when the same block is scanned for a different recipient', async () => {
    const result = await gateway().scanIncomingTransfers({
      fromHeight: BigInt(transferHeight),
      toHeight: BigInt(transferHeight),
      watchedAccounts: [
        USDT_TRON_NILE_ADDRESS === indexed.to
          ? 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
          : USDT_TRON_NILE_ADDRESS,
      ],
      assetReferences: [indexed.token_info.address],
      headerDepth: 1,
    });
    expect(
      result.transfers.some(
        (transfer) => transfer.reference.transactionReference === indexed.transaction_id,
      ),
    ).toBe(false);
  });

  it('credits nothing when the same block is scanned for a different token', async () => {
    const result = await gateway().scanIncomingTransfers({
      fromHeight: BigInt(transferHeight),
      toHeight: BigInt(transferHeight),
      watchedAccounts: [indexed.to],
      assetReferences: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
      headerDepth: 1,
    });
    expect(result.transfers).toEqual([]);
  });

  it('reads the balance of a real account', async () => {
    const balance = await gateway().readAssetBalance(indexed.to, indexed.token_info.address);
    expect(balance).toBeGreaterThanOrEqual(0n);

    const native = await gateway().readAssetBalance(indexed.to, NATIVE_ASSET_REFERENCE);
    expect(native).toBeGreaterThanOrEqual(0n);
  });
});
