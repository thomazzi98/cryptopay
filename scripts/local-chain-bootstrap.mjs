#!/usr/bin/env node
/**
 * Makes a fresh Anvil chain usable by the local stack: the mock USDC deployed at the address the
 * stack is configured with, and the demo payer holding enough of it to pay with.
 *
 * The address is deterministic rather than discovered. A contract created by an account's first
 * transaction has an address that follows from the account and the nonce alone, so deploying from
 * Anvil's first account at nonce zero always lands the token at the same place, and the API and the
 * chain worker can be given that address in configuration before the deployment has happened.
 *
 * Idempotent, because Compose runs it on every start: code already at the address is not deployed
 * again, and a payer already funded is not funded again. Nothing here is signed by this script —
 * Anvil unlocks its development accounts, and the transactions are sent from one of them.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const rpcUrl = process.env.ANVIL_RPC_URL ?? 'http://anvil:8545';
const artifactPath = process.env.MOCK_TOKEN_ARTIFACT ?? '/bootstrap/mock-usdc.json';
const expectedTokenAddress = (
  process.env.EXPECTED_TOKEN_ADDRESS ?? '0x5fbdb2315678afecb367f032d93f642f64180aa3'
).toLowerCase();
// Anvil's first two development accounts. The first deploys; the second pays in the demo.
const deployer = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const payer = (
  process.env.PAYER_ADDRESS ?? '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
).toLowerCase();
// One million USDC in base units (six decimals).
const payerFunding = 1_000_000n * 1_000_000n;

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  const body = await response.json();
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function waitForChain() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const chainId = await rpc('eth_chainId', []);
      process.stdout.write(`chain ${Number(chainId)} is answering at ${rpcUrl}\n`);
      return;
    } catch {
      await new Promise((settle) => setTimeout(settle, 1000));
    }
  }
  throw new Error(`Anvil did not answer at ${rpcUrl}`);
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt !== null) {
      if (receipt.status !== '0x1') {
        throw new Error(`transaction ${hash} reverted`);
      }
      return receipt;
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error(`transaction ${hash} was never mined`);
}

function padWord(hex) {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

async function ensureToken() {
  const code = await rpc('eth_getCode', [expectedTokenAddress, 'latest']);
  if (code !== '0x') {
    process.stdout.write(`mock USDC already deployed at ${expectedTokenAddress}\n`);
    return;
  }
  const nonce = Number(await rpc('eth_getTransactionCount', [deployer, 'latest']));
  if (nonce !== 0) {
    throw new Error(
      `the deployer has already sent ${nonce} transaction(s), so the token cannot land at ${expectedTokenAddress}; reset the chain volume`,
    );
  }
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const hash = await rpc('eth_sendTransaction', [{ from: deployer, data: artifact.bytecode }]);
  const receipt = await waitForReceipt(hash);
  const deployed = String(receipt.contractAddress).toLowerCase();
  if (deployed !== expectedTokenAddress) {
    throw new Error(`the token landed at ${deployed}, not the configured ${expectedTokenAddress}`);
  }
  process.stdout.write(`mock USDC deployed at ${deployed}\n`);
}

async function ensurePayerFunded() {
  const balanceOf = `0x70a08231${padWord(payer)}`;
  const balance = BigInt(
    await rpc('eth_call', [{ to: expectedTokenAddress, data: balanceOf }, 'latest']),
  );
  if (balance >= payerFunding / 2n) {
    process.stdout.write(`payer ${payer} holds ${balance.toString()} base units of USDC\n`);
    return;
  }
  const mint = `0x40c10f19${padWord(payer)}${padWord(payerFunding.toString(16))}`;
  const hash = await rpc('eth_sendTransaction', [
    { from: deployer, to: expectedTokenAddress, data: mint },
  ]);
  await waitForReceipt(hash);
  process.stdout.write(`minted ${payerFunding.toString()} base units of USDC to ${payer}\n`);
}

await waitForChain();
await ensureToken();
await ensurePayerFunded();
