#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * One real payment on Polygon Amoy, end to end, against a running CryptoPay.
 *
 * This is the acceptance criterion the whole system exists to satisfy, and it is deliberately a
 * script rather than a test. It spends real testnet funds, it depends on a public RPC endpoint being
 * reachable, and it takes minutes: three properties that make something a bad test and a good
 * manually-triggered check.
 *
 * The amount is deliberately tiny. The gas budget on a faucet-funded key is the scarce resource here,
 * and a validation that drains it can only be run once.
 *
 * Nothing about the payment is asserted from this side. The script sends a transfer and then watches
 * the API's own view of the payment; the pass condition is that the backend reached `completed` on
 * its own, having been told nothing.
 */

const AMOY_CHAIN_IDENTIFIER = 80_002;
const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';
const USDC_DECIMALS = 6;
const EXPLORER = 'https://amoy.polygonscan.com';

const AMOUNT_DISPLAY = process.env.VALIDATION_AMOUNT ?? '0.01';
const API_URL = process.env.CRYPTOPAY_API_URL ?? 'http://127.0.0.1:3001';
const API_KEY = process.env.CRYPTOPAY_API_KEY ?? '';
const [RPC_URL] = (
  process.env.POLYGON_AMOY_RPC_URLS ?? 'https://rpc-amoy.polygon.technology'
).split(',', 1);
const DEADLINE_MINUTES = Number(process.env.VALIDATION_DEADLINE_MINUTES ?? '20');

function readPrivateKey() {
  const fromEnvironment = process.env.AMOY_TESTNET_PRIVATE_KEY;
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return fromEnvironment.startsWith('0x') ? fromEnvironment : `0x${fromEnvironment}`;
  }
  const contents = readFileSync('.env', 'utf8');
  const line = contents.split('\n').find((entry) => entry.startsWith('AMOY_TESTNET_PRIVATE_KEY='));
  if (line === undefined) {
    throw new Error('No AMOY_TESTNET_PRIVATE_KEY is configured.');
  }
  const raw = line
    .slice('AMOY_TESTNET_PRIVATE_KEY='.length)
    .trim()
    .replaceAll(/^["']|["']$/g, '');
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

async function callApi(path, options = {}) {
  const response = await fetch(`${API_URL}/${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${API_KEY}`,
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  if (API_KEY === '') {
    throw new Error('Set CRYPTOPAY_API_KEY to a cp_test_ key belonging to a merchant.');
  }

  const account = privateKeyToAccount(readPrivateKey());
  const publicClient = createPublicClient({ transport: http(RPC_URL, { timeout: 20_000 }) });

  const chainIdentifier = await publicClient.getChainId();
  if (chainIdentifier !== AMOY_CHAIN_IDENTIFIER) {
    throw new Error(
      `The endpoint served chain ${String(chainIdentifier)}, not Amoy. Refusing to continue.`,
    );
  }

  const [nativeBalance, tokenBalance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: USDC_AMOY,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }),
  ]);

  const amountInBaseUnits = parseUnits(AMOUNT_DISPLAY, USDC_DECIMALS);
  log(`Paying from ${account.address}`);
  log(`  gas   ${formatUnits(nativeBalance, 18)} POL`);
  log(`  USDC  ${formatUnits(tokenBalance, USDC_DECIMALS)}`);
  log(`  sending ${AMOUNT_DISPLAY} USDC\n`);

  if (nativeBalance === 0n) {
    throw new Error('This address holds no POL, so it cannot pay for gas. Use a faucet first.');
  }
  if (tokenBalance < amountInBaseUnits) {
    throw new Error(
      `This address holds ${formatUnits(tokenBalance, USDC_DECIMALS)} USDC, less than the ${AMOUNT_DISPLAY} it is about to send.`,
    );
  }

  log('Creating the payment through the API...');
  const payment = await callApi('v1/payments', {
    method: 'POST',
    idempotencyKey: `amoy-validation-${String(process.pid)}-${String(nativeBalance)}`,
    body: {
      amount: AMOUNT_DISPLAY,
      assetSymbol: 'USDC',
      network: 'polygon-amoy',
      merchantReference: 'amoy-validation',
    },
  });
  log(`  ${payment.identifier}`);
  log(`  receiving address ${payment.receivingAccount}`);
  log(`  ${EXPLORER}/address/${payment.receivingAccount}\n`);

  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
  log('Sending the transfer on chain...');
  const transactionHash = await walletClient.writeContract({
    address: USDC_AMOY,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [payment.receivingAccount, amountInBaseUnits],
    account,
    chain: null,
  });
  log(`  ${transactionHash}`);
  log(`  ${EXPLORER}/tx/${transactionHash}\n`);

  // Nothing tells the API about that hash. From here the backend is on its own, which is the whole
  // point of the exercise.
  log('Watching what the backend concludes, having been told nothing:');
  const deadline = Date.now() + DEADLINE_MINUTES * 60_000;
  let lastReport = '';

  while (Date.now() < deadline) {
    const current = await callApi(`v1/payments/${payment.identifier}`);
    const report = `  ${current.status} · credited ${current.creditedAmount.display} · ${String(current.confirmations)}/${String(current.requiredConfirmations)} confirmations · finality ${current.finalityConfirmed ? 'confirmed' : 'pending'}`;
    if (report !== lastReport) {
      log(report);
      lastReport = report;
    }

    if (current.status === 'completed' || current.status === 'overpaid') {
      log(`\nThe backend completed the payment on its own.`);
      log(`  payment      ${current.identifier}`);
      log(`  transaction  ${EXPLORER}/tx/${transactionHash}`);
      log(`  address      ${EXPLORER}/address/${current.receivingAccount}`);
      log(`  credited     ${current.creditedAmount.display} ${current.asset.symbol}`);
      log(`  completed at ${String(current.completedAt)}`);
      return;
    }
    if (current.status === 'expired' || current.status === 'canceled') {
      throw new Error(`The payment ended as ${current.status}, which is a failure of this run.`);
    }

    await new Promise((sleep) => setTimeout(sleep, 5000));
  }

  throw new Error(
    `The payment did not complete within ${String(DEADLINE_MINUTES)} minutes. It may simply need longer; check the dashboard.`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
