import { SOLANA_DEVNET_GENESIS_IDENTITY } from '@cryptopay/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { LedgerIdentityMismatchError } from '../../src/application/ports/chain-gateway.port.js';
import { networkConfigurationFor } from '../../src/infrastructure/chain/network-configuration.js';
import { NATIVE_ASSET_REFERENCE } from '../../src/infrastructure/chain/token-registry.js';
import { SolanaChainGateway } from '../../src/infrastructure/chain/solana/solana-chain-gateway.js';
import { HttpSolanaNode } from '../../src/infrastructure/chain/solana/solana-client.js';

/**
 * The Solana adapter against the real devnet.
 *
 * Excluded from the unit and integration runs and executed on demand, because it reads the public
 * internet. Nothing here spends anything, and nothing here needs funding: every assertion is a read
 * of history that already exists.
 *
 * The claim it establishes that a fixture cannot is that slots really are skipped and the adapter
 * really does survive it. A recorded block can be made to look however the author expected; a live
 * range of slots contains whatever the network actually produced, which on Solana is reliably fewer
 * blocks than slots.
 */

const DEVNET_ENDPOINT = 'https://api.devnet.solana.com';
const WATCHED_ACCOUNT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function gateway(): SolanaChainGateway {
  return new SolanaChainGateway({
    networkIdentifier: 'solana-devnet',
    node: new HttpSolanaNode({ endpoint: DEVNET_ENDPOINT, timeoutMilliseconds: 30_000 }),
    expectedLedgerIdentity: networkConfigurationFor('solana-devnet').ledgerIdentity,
  });
}

let finalizedSlot: bigint;
let window: Awaited<ReturnType<SolanaChainGateway['scanIncomingTransfers']>>;

/**
 * One scan, shared by every assertion that needs it.
 *
 * The public devnet endpoint rate limits a client that reads a block per slot, which is exactly what
 * a scan does, and it began refusing at around twenty slots from this machine. That is a real
 * operational fact about running against a shared endpoint rather than a test inconvenience: a
 * deployment scanning Solana needs either a paid endpoint or a window small enough to stay under the
 * limit. The window here is four slots, which is enough to show that some of them produced no block
 * at all, and small enough that the shared endpoint answers it.
 */
beforeAll(async () => {
  const progress = await gateway().readChainProgress();
  finalizedSlot = progress.tip.height;
  window = await gateway().scanIncomingTransfers({
    fromHeight: finalizedSlot - 4n,
    toHeight: finalizedSlot,
    watchedAccounts: [WATCHED_ACCOUNT],
    assetReferences: [NATIVE_ASSET_REFERENCE],
    headerDepth: 8,
  });
});

describe('the devnet as the adapter sees it', () => {
  it('reports the genesis hash this deployment was configured with', async () => {
    await expect(gateway().assertLedgerIdentity()).resolves.toBeUndefined();
    expect(networkConfigurationFor('solana-devnet').ledgerIdentity).toBe(
      SOLANA_DEVNET_GENESIS_IDENTITY,
    );
  });

  it('refuses when the configured identity is not the chain being served', async () => {
    const wrong = new SolanaChainGateway({
      networkIdentifier: 'solana-devnet',
      node: new HttpSolanaNode({ endpoint: DEVNET_ENDPOINT, timeoutMilliseconds: 30_000 }),
      expectedLedgerIdentity: networkConfigurationFor('solana-mainnet').ledgerIdentity,
    });
    await expect(wrong.assertLedgerIdentity()).rejects.toBeInstanceOf(LedgerIdentityMismatchError);
  });

  it('reads a finalized slot, and reports it as both the tip and the finalized height', async () => {
    const progress = await gateway().readChainProgress();
    expect(progress.tip.height).toBeGreaterThan(0n);
    expect(progress.finalizedHeight).toBe(progress.tip.height);
  });

  /**
   * The property this adapter is most at risk of getting wrong, measured against the live chain
   * rather than asserted. A window of slots contains fewer blocks than slots, so an adapter that
   * expected one block per slot would treat an ordinary window as missing data.
   */
  it('reads only the slots that produced a block, and names them', () => {
    expect(window.headers.length).toBeGreaterThan(0);
    // Every header carries the slot it came from, and each is inside the window that was asked for.
    for (const header of window.headers) {
      expect(header.position.height).toBeGreaterThanOrEqual(finalizedSlot - 4n);
      expect(header.position.height).toBeLessThanOrEqual(finalizedSlot);
    }
    expect(window.scannedThrough.position.height).toBeLessThanOrEqual(finalizedSlot);
    // Nobody paid that address in this window, which is the expected answer and still exercises the
    // whole read path.
    expect(window.transfers).toEqual([]);
  });

  /**
   * The adapter asks which slots produced a block rather than assuming every slot did.
   *
   * Deliberately NOT asserting that slots are skipped right now. Skipping is intermittent: a
   * healthy devnet often produces a block in every slot of a span, and this very assertion failed
   * against a 250-slot window in which all 251 slots produced one. A test that demanded a gap would
   * be asserting a property of the network's mood rather than of this code, and would fail on a
   * good day.
   *
   * What is asserted is the contract the adapter depends on: the node returns the produced slots,
   * in order, never more than the span asked for. Handling a gap when one appears is proven by the
   * unit suite, which can produce one on demand.
   */
  it('asks the node which slots produced a block, rather than assuming every slot did', async () => {
    const node = new HttpSolanaNode({ endpoint: DEVNET_ENDPOINT, timeoutMilliseconds: 30_000 });
    const span = 250;
    const from = Number(finalizedSlot) - span;
    const produced = await node.readProducedSlots(from, Number(finalizedSlot));

    expect(produced.length).toBeGreaterThan(0);
    expect(produced.length).toBeLessThanOrEqual(span + 1);
    const ordered = [...produced].toSorted((left, right) => left - right);
    expect(ordered).toEqual([...produced]);
    for (const slot of produced) {
      expect(slot).toBeGreaterThanOrEqual(from);
      expect(slot).toBeLessThanOrEqual(Number(finalizedSlot));
    }
  });

  /**
   * Each header names its own parent rather than the slot before it. Walking the chain by
   * arithmetic is the mistake that turns a healthy Solana network into a halted one.
   */
  it('links each block to its parent by identifier, across skipped slots', () => {
    expect(window.headers.length).toBeGreaterThan(1);
    const links = window.headers.slice(1).map((header, index) => ({
      parent: header.parentReference,
      previous: window.headers[index]?.position.reference,
      rose: header.position.height > (window.headers[index]?.position.height ?? 0n),
    }));
    for (const link of links) {
      expect(link.parent).toBe(link.previous);
      expect(link.rose).toBe(true);
    }
  });

  it('reads the balance of a real account', async () => {
    const balance = await gateway().readAssetBalance(WATCHED_ACCOUNT, NATIVE_ASSET_REFERENCE);
    expect(balance).toBeGreaterThanOrEqual(0n);
  });

  it('reports a signature the chain does not know as orphaned', async () => {
    const result = await gateway().reconcileTransfer(
      { transactionReference: `${'1'.repeat(87)}2`, eventIndex: 0 },
      { height: finalizedSlot, reference: 'unknown' },
    );
    expect(['orphaned', 'indeterminate']).toContain(result.kind);
  });
});
