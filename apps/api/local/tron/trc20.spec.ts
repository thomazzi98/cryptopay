import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { decodeTronAddress } from '../../src/infrastructure/chain/tron/address.js';
import { TronChainGateway } from '../../src/infrastructure/chain/tron/tron-chain-gateway.js';
import { HttpTronNode } from '../../src/infrastructure/chain/tron/tron-client.js';
import {
  accountFor,
  deployContract,
  genesisAccount,
  isNodeRunning,
  readGenesisIdentity,
  readHeadHeight,
  triggerContract,
  TRON_NODE_BASE_URL,
  type FundedAccount,
} from '../setup/tron-node.js';

/**
 * A TRC-20 transfer, deployed and sent on a real TRON node, then read back by the adapter.
 *
 * This is the decoding that TRON gets wrong more often than anything else. TronGrid returns the
 * contract on `log.address` as twenty bare bytes and the sender and recipient in `log.topics`
 * left-padded to thirty-two, none of them carrying the `0x41` byte that makes them TRON addresses.
 * Reading any of them as an EVM address produces a plausible identity belonging to nobody, and a
 * payment matched against it is never credited. The only way to be sure is to send a transfer to an
 * address this system chose and check the adapter recovers that exact address from the log.
 *
 * The token is the same ERC-20 artifact the Anvil suite deploys. TRON's virtual machine is EVM
 * compatible, so the bytecode is portable, and using one artifact for both chains means the
 * contract is not a variable when the two adapters disagree.
 *
 * The payment lifecycle is not driven here, because the allowlist a payment is classified against is
 * frozen per network and correctly refuses a contract deployed at runtime. That is the safety
 * property working, not a gap: the local development escape hatch is deliberately restricted to the
 * Anvil network so it cannot become a way to add an asset to a real one.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeIsRunning = await isNodeRunning();

let genesis: FundedAccount;
let gateway: TronChainGateway;
let tokenAccount = '';

/** ABI encoding for `(address, uint256)`: a TRON address travels as its twenty-byte key hash. */
function addressAndAmount(account: string, amount: bigint): string {
  const keyHash = decodeTronAddress(account).slice(2);
  return keyHash.padStart(64, '0') + amount.toString(16).padStart(64, '0');
}

beforeAll(async () => {
  if (!nodeIsRunning) {
    return;
  }
  genesis = genesisAccount();
  gateway = new TronChainGateway({
    networkIdentifier: 'tron-nile',
    node: new HttpTronNode({
      baseUrl: TRON_NODE_BASE_URL,
      apiKey: null,
      timeoutMilliseconds: 30_000,
    }),
    expectedLedgerIdentity: await readGenesisIdentity(),
  });

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: readonly unknown[]; bytecode: string };
  tokenAccount = await deployContract(genesis, artifact.bytecode, artifact.abi);
}, 180_000);

describe.skipIf(!nodeIsRunning)('a TRC-20 transfer read from a real node', () => {
  it('deploys a contract at an address in TRON form', () => {
    expect(tokenAccount).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('recovers the recipient, the contract and the amount from the event log', async () => {
    const recipient = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 60));
    await triggerContract(
      genesis,
      tokenAccount,
      'mint(address,uint256)',
      addressAndAmount(genesis.account, 1_000_000_000n),
    );
    const transactionId = await triggerContract(
      genesis,
      tokenAccount,
      'transfer(address,uint256)',
      addressAndAmount(recipient, 25_000_000n),
    );

    const head = await readHeadHeight();
    const found = await gateway.scanIncomingTransfers({
      fromHeight: BigInt(Math.max(1, head - 40)),
      toHeight: BigInt(head),
      watchedAccounts: [recipient],
      assetReferences: [tokenAccount],
    });

    const transfer = found.transfers.find(
      (candidate) => candidate.reference.transactionReference === transactionId,
    );
    expect(transfer).toBeDefined();
    // The three facts a payment depends on, each recovered from bytes that carried no 0x41 prefix.
    expect(transfer?.destinationAccount).toBe(recipient);
    expect(transfer?.assetReference).toBe(tokenAccount);
    expect(transfer?.amountInBaseUnits).toBe(25_000_000n);
    expect(transfer?.sourceAccount).toBe(genesis.account);
  });

  it('ignores a transfer to an account nobody is watching', async () => {
    const watched = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 70));
    const stranger = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 80));
    await triggerContract(
      genesis,
      tokenAccount,
      'transfer(address,uint256)',
      addressAndAmount(stranger, 7_000_000n),
    );

    const head = await readHeadHeight();
    const found = await gateway.scanIncomingTransfers({
      fromHeight: BigInt(Math.max(1, head - 10)),
      toHeight: BigInt(head),
      watchedAccounts: [watched],
      assetReferences: [tokenAccount],
    });

    expect(found.transfers).toHaveLength(0);
  });

  it('reads the balance the contract itself reports', async () => {
    const recipient = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 90));
    await triggerContract(
      genesis,
      tokenAccount,
      'transfer(address,uint256)',
      addressAndAmount(recipient, 3_000_000n),
    );

    await expect(gateway.readAssetBalance(recipient, tokenAccount)).resolves.toBe(3_000_000n);
  });
});
