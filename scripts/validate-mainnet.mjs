#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { createPublicClient, createWalletClient, formatEther, formatGwei, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmSettlementBroadcaster } from '../apps/api/dist/infrastructure/chain/evm-settlement-broadcaster.js';
import { SettlementRepository } from '../apps/api/dist/infrastructure/persistence/settlement.repository.js';
import { WalletSeedRepository } from '../apps/api/dist/infrastructure/persistence/wallet-seed.repository.js';
import { createKeyWrapperRegistry } from '../apps/api/dist/infrastructure/wallet/key-wrapping.js';
import { WalletSigningProvider } from '../apps/api/dist/infrastructure/wallet/signing-provider.js';
import { decideSpend, totalCommitted } from '../apps/api/dist/domain/spend-ceiling.js';

/**
 * The one manual rehearsal against Polygon PoS mainnet.
 *
 * Everything provable on a local chain is proved there: the settlement suite signs with keys derived
 * from a sealed seed, broadcasts to a node, and asserts on what the token contract says afterwards.
 * What a local chain cannot show is real fee estimation where the base fee moves, a real chain
 * identity, a real receipt, and whether the spend arithmetic matches what Polygon actually charges.
 * That is the whole reason to spend anything here.
 *
 * It is deliberately not a test. A test that spends money on every run is a test somebody eventually
 * disables, so this runs when a person decides it should, prints what each step will cost before
 * taking it, and refuses to continue when the running total would cross the ceiling.
 *
 * The transaction in step two is signed by the same broadcaster the settlement worker uses, from a
 * key derived by the same provider, against the same database. Nothing about it is a simulation
 * except the absence of an ERC-20 to sweep, which mainnet has no free way to obtain.
 *
 * No key is printed and no key leaves this process. Keys derive addresses and sign locally; only
 * signed transactions and addresses go over the wire.
 */

const CHAIN_IDENTIFIER = 137;
const NETWORK = 'polygon-mainnet';
const ENVIRONMENT = 'live';
const ENVIRONMENT_FILE = '.env';

/** The hard ceiling for this entire exercise, in wei. Checked as a worst case before every send. */
const MAXIMUM_SPEND = 5n * 10n ** 17n;

/** Enough for one native transfer at a fee well above the market, and nothing more. */
const TREASURY_FUNDING = 2n * 10n ** 16n;

/** The value of the rehearsal transfer. The point is the transaction, not the amount. */
const REHEARSAL_VALUE = 1n;

const NATIVE_TRANSFER_GAS = 21_000n;

function readVariable(name) {
  const fromEnvironment = process.env[name];
  if (fromEnvironment !== undefined && fromEnvironment.trim() !== '') {
    return fromEnvironment.trim();
  }
  let contents;
  try {
    contents = readFileSync(ENVIRONMENT_FILE, 'utf8');
  } catch {
    return null;
  }
  const line = contents.split('\n').find((entry) => entry.startsWith(`${name}=`));
  if (line === undefined) {
    return null;
  }
  const value = line
    .slice(name.length + 1)
    .trim()
    .replaceAll(/^["']|["']$/g, '');
  return value === '' ? null : value;
}

function pol(amount) {
  return `${formatEther(amount)} POL`;
}

const spent = [];

function committed() {
  return spent.reduce((running, entry) => running + entry.cost, 0n);
}

/**
 * Refuses a step whose worst case would cross the ceiling, and says so in the same terms the
 * settlement engine uses, because it is the same arithmetic.
 */
function authorise(label, valueInNativeUnits, maximumFeeInNativeUnits) {
  const decision = decideSpend({
    ceilingInNativeUnits: MAXIMUM_SPEND,
    committedInNativeUnits: committed(),
    proposed: { valueInNativeUnits, maximumFeeInNativeUnits },
  });

  console.log(`\n  ${label}`);
  console.log(`    value           ${pol(valueInNativeUnits)}`);
  console.log(`    maximum fee     ${pol(maximumFeeInNativeUnits)}`);
  console.log(`    already spent   ${pol(committed())}`);
  console.log(`    ceiling         ${pol(MAXIMUM_SPEND)}`);

  if (decision.kind === 'refused') {
    console.error(
      `    REFUSED: this would reach ${pol(decision.wouldReachInNativeUnits)}. Stopping.`,
    );
    return false;
  }
  console.log(`    remaining after ${pol(decision.remainingInNativeUnits)}`);
  return true;
}

function record(label, cost, reference) {
  spent.push({ label, cost, reference });
  console.log(`    actual cost     ${pol(cost)}`);
  console.log(`    running total   ${pol(committed())} of ${pol(MAXIMUM_SPEND)}`);
}

async function waitForReceipt(client, hash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error(`No receipt for ${hash} after three minutes`);
}

async function main() {
  const confirmed = process.argv.includes('--confirm');
  const funderKey = readVariable('AMOY_TESTNET_PRIVATE_KEY');
  const databaseUrl =
    readVariable('MAINNET_VALIDATION_DATABASE_URL') ?? readVariable('DATABASE_URL');
  const walletKey = readVariable('WALLET_KEY_ENCRYPTION_KEY');
  const rpcUrls = (readVariable('POLYGON_MAINNET_RPC_URLS') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const [name, value] of [
    ['AMOY_TESTNET_PRIVATE_KEY', funderKey],
    ['DATABASE_URL', databaseUrl],
    ['WALLET_KEY_ENCRYPTION_KEY', walletKey],
  ]) {
    if (value === null) {
      console.error(`${name} is not configured.`);
      process.exitCode = 1;
      return;
    }
  }
  if (rpcUrls.length === 0) {
    console.error('POLYGON_MAINNET_RPC_URLS is not configured.');
    process.exitCode = 1;
    return;
  }

  const client = createPublicClient({ transport: http(rpcUrls[0], { timeout: 20_000 }) });
  const observedChain = await client.getChainId();
  if (observedChain !== CHAIN_IDENTIFIER) {
    console.error(
      `The endpoint reported chain ${observedChain}, not ${CHAIN_IDENTIFIER}. Refusing.`,
    );
    process.exitCode = 1;
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const signingProvider = new WalletSigningProvider(
    new WalletSeedRepository(pool),
    createKeyWrapperRegistry(Buffer.from(walletKey, 'base64'), 'local-key-1'),
  );
  const settlementRepository = new SettlementRepository(pool);

  let treasury;
  try {
    treasury = await signingProvider.treasuryAccount(ENVIRONMENT);
  } catch (error) {
    console.error(`Could not derive the live treasury: ${error.message}`);
    console.error(
      'Provision a live seed first: npm run wallet:provision --workspace @cryptopay/api -- live',
    );
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const broadcaster = new EvmSettlementBroadcaster({
    networkIdentifier: NETWORK,
    chainIdentifier: CHAIN_IDENTIFIER,
    displayName: 'Polygon',
    nativeCurrencySymbol: 'POL',
    nativeCurrencyDecimals: 18,
    rpcUrls,
    environment: ENVIRONMENT,
    signingProvider,
    treasuryAccount: treasury,
  });

  const funder = privateKeyToAccount(funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`);
  const [funderBalance, treasuryBalance, fees, block] = await Promise.all([
    client.getBalance({ address: funder.address }),
    broadcaster.readNativeBalance(treasury),
    client.estimateFeesPerGas(),
    client.getBlock({ blockTag: 'latest' }),
  ]);

  console.log('Polygon PoS mainnet rehearsal');
  console.log('============================');
  console.log(`  chain            ${observedChain}`);
  console.log(`  height           ${block.number}`);
  console.log(`  base fee         ${formatGwei(block.baseFeePerGas ?? 0n)} gwei`);
  console.log(`  max fee per gas  ${formatGwei(fees.maxFeePerGas)} gwei`);
  console.log(`  priority fee     ${formatGwei(fees.maxPriorityFeePerGas)} gwei`);
  console.log(`  funding account  ${funder.address}  ${pol(funderBalance)}`);
  console.log(`  treasury         ${treasury}  ${pol(treasuryBalance)}`);

  const fundingFee = NATIVE_TRANSFER_GAS * fees.maxFeePerGas;
  const needsFunding = treasuryBalance < fundingFee;

  if (!confirmed) {
    console.log('\nDry run. Nothing has been sent.');
    if (needsFunding) {
      authorise('Step 1: fund the treasury', TREASURY_FUNDING, fundingFee);
    }
    authorise('Step 2: the engine signs and broadcasts', REHEARSAL_VALUE, fundingFee);
    console.log('\nRun again with --confirm to execute.');
    await pool.end();
    return;
  }

  // Step one. The only transaction here the engine does not sign: the funding account is not derived
  // from the wallet seed, and that separation is deliberate rather than incidental.
  if (needsFunding) {
    if (!authorise('Step 1: fund the treasury', TREASURY_FUNDING, fundingFee)) {
      await pool.end();
      process.exitCode = 1;
      return;
    }

    const wallet = createWalletClient({
      account: funder,
      transport: http(rpcUrls[0], { timeout: 20_000 }),
    });
    const fundingHash = await wallet.sendTransaction({
      to: treasury,
      value: TREASURY_FUNDING,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      gas: NATIVE_TRANSFER_GAS,
      chain: null,
    });
    console.log(`    transaction     ${fundingHash}`);
    console.log(`    explorer        https://polygonscan.com/tx/${fundingHash}`);

    const receipt = await waitForReceipt(client, fundingHash);
    console.log(`    block           ${receipt.blockNumber}`);
    console.log(`    gas used        ${receipt.gasUsed}`);
    console.log(`    status          ${receipt.status}`);
    record(
      'treasury funding',
      TREASURY_FUNDING + receipt.gasUsed * receipt.effectiveGasPrice,
      fundingHash,
    );
  }

  // Step two, and the point of the exercise: the engine's own path, on real Polygon.
  console.log('\n  Step 2: the settlement engine signs and broadcasts');

  const request = {
    signingRole: { kind: 'treasury' },
    sourceAccount: treasury,
    destinationAccount: funder.address.toLowerCase(),
    amountInNativeUnits: REHEARSAL_VALUE,
  };

  const estimate = await broadcaster.estimateNativeTransfer(request);
  if (estimate.kind !== 'estimated') {
    console.error(`    estimate failed: ${estimate.kind} — ${estimate.reason}`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  console.log(`    estimated fee   ${pol(estimate.estimate.maximumFeeInNativeUnits)}`);
  console.log(`    fee parameters  ${JSON.stringify(estimate.estimate.feeParameters)}`);

  if (!authorise('    authorising', REHEARSAL_VALUE, estimate.estimate.maximumFeeInNativeUnits)) {
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const observedSequence = await broadcaster.readAccountSequence(treasury);
  const sequenceNumber = await settlementRepository.claimSequenceNumber(
    NETWORK,
    treasury,
    observedSequence,
  );
  console.log(`    chain sequence  ${observedSequence}`);
  console.log(`    claimed         ${sequenceNumber}`);

  const signed = await broadcaster.signNativeTransfer(request, sequenceNumber, estimate.estimate);
  if (signed.kind !== 'signed') {
    console.error(`    refused to sign: ${signed.reason}`);
    await settlementRepository.releaseSequenceNumber(NETWORK, treasury, sequenceNumber);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  // Known before anything is sent. This is the property that makes a timeout survivable.
  console.log(`    reference       ${signed.transactionReference}`);
  console.log(`    explorer        https://polygonscan.com/tx/${signed.transactionReference}`);

  const submitted = await broadcaster.submit(signed.signedPayload);
  console.log(`    submitted       ${submitted.kind}`);
  if (submitted.kind === 'rejected') {
    console.error(`    rejected: ${submitted.reason}`);
    await settlementRepository.releaseSequenceNumber(NETWORK, treasury, sequenceNumber);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  let reconciliation = { kind: 'pending' };
  for (let attempt = 0; attempt < 60 && reconciliation.kind === 'pending'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    reconciliation = await broadcaster.reconcileBroadcast(
      signed.transactionReference,
      treasury,
      sequenceNumber,
    );
  }

  console.log(`    reconciled      ${reconciliation.kind}`);
  if (reconciliation.kind !== 'mined') {
    console.error('    the transaction did not reach a block within three minutes.');
    await pool.end();
    process.exitCode = 1;
    return;
  }

  console.log(`    block           ${reconciliation.position.height}`);
  console.log(`    block hash      ${reconciliation.position.reference}`);
  console.log(`    succeeded       ${reconciliation.succeeded}`);
  console.log(`    gas used        ${reconciliation.computeUsed}`);
  record(
    'engine broadcast',
    REHEARSAL_VALUE + reconciliation.feePaidInNativeUnits,
    signed.transactionReference,
  );

  const finalTreasury = await broadcaster.readNativeBalance(treasury);
  console.log('\nResult');
  console.log('======');
  for (const entry of spent) {
    const cost = pol(entry.cost).padEnd(24);
    console.log(`  ${entry.label.padEnd(18)} ${cost} ${entry.reference}`);
  }
  console.log(`  ${'total'.padEnd(18)} ${pol(committed())}`);
  console.log(`  ${'ceiling'.padEnd(18)} ${pol(MAXIMUM_SPEND)}`);
  console.log(`  ${'treasury left'.padEnd(18)} ${pol(finalTreasury)}`);
  // Zero for this rehearsal, and correctly so: with no payment to settle there is no settlement row
  // for a transaction to belong to, so the engine's own ledger has nothing recorded against mainnet.
  const recorded = await settlementRepository.treasurySpends(NETWORK, treasury);
  console.log(`\n  Committed as the engine counts it: ${pol(totalCommitted(recorded))}`);

  await pool.end();
}

await main();
