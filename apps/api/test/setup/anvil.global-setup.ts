import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, http, type Abi, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { TestProject } from 'vitest/node';

/**
 * A real EVM chain for the integration suite, run as a native binary rather than a container.
 *
 * Anvil is started with mining disabled, which is the load-bearing flag: no block exists unless a
 * test mines one, so confirmation counts are exact and no test ever sleeps waiting for a block to
 * appear. A suite that waits on wall-clock block production is a suite that is flaky on a busy
 * machine and slow on every machine.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT_PATH = resolve(packageRoot, 'test/fixtures/mock-usdc.json');

/**
 * The mnemonic every Ethereum development tool ships with. Accounts are derived from it at runtime
 * rather than written out as private keys: a key literal in the repository is a key the secret
 * scanner has to be taught to ignore, and an exception granted once is an exception forever.
 */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export function anvilAccount(index: number) {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

export interface AnvilHandle {
  readonly port: number;
  readonly rpcUrl: string;
  readonly tokenAddress: string;
}

function resolveAnvilCommand(): string {
  const configured = process.env.ANVIL_PATH;
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  // The Windows toolchain is unpacked outside the repository; CI installs anvil onto the PATH.
  if (process.platform === 'win32') {
    return 'E:/dev-cache/foundry/bin/anvil.exe';
  }
  return 'anvil';
}

function readPort(): number {
  const configured = process.env.TEST_ANVIL_PORT;
  if (configured === undefined) {
    return 8547;
  }
  return Number(configured);
}

async function waitForChain(rpcUrl: string): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((settle) => setTimeout(settle, 250));
    }
  }
  throw new Error(`Anvil did not become reachable at ${rpcUrl}`);
}

/** Anvil mines only when asked, so every test controls exactly how many confirmations exist. */
export async function mineBlock(rpcUrl: string): Promise<void> {
  await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
  });
}

async function deployMockToken(rpcUrl: string): Promise<string> {
  const artifact = JSON.parse(await readFile(ARTIFACT_PATH, 'utf8')) as {
    abi: Abi;
    bytecode: Hex;
  };

  const account = anvilAccount(0);
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    chain: null,
    args: [],
  });
  await mineBlock(rpcUrl);
  const receipt = await publicClient.getTransactionReceipt({ hash });

  if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
    throw new Error('The mock token did not produce a contract address');
  }
  return receipt.contractAddress.toLowerCase();
}

let anvil: ChildProcess | null = null;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = readPort();
  const rpcUrl = `http://127.0.0.1:${port.toString()}`;

  anvil = spawn(
    resolveAnvilCommand(),
    [
      '--port',
      port.toString(),
      '--chain-id',
      '31337',
      '--mnemonic',
      ANVIL_MNEMONIC,
      // Nothing is mined unless a test asks for it, which is what makes confirmation counts exact.
      '--no-mining',
      '--silent',
    ],
    { stdio: 'ignore' },
  );

  await waitForChain(rpcUrl);
  const tokenAddress = await deployMockToken(rpcUrl);

  project.provide('anvilPort', port);
  project.provide('anvilTokenAddress', tokenAddress);

  return async () => {
    anvil?.kill();
    anvil = null;
    await Promise.resolve();
  };
}
