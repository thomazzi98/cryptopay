import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HttpSolanaNode } from './solana-client.js';

/**
 * What this client makes of what a Solana node says.
 *
 * One distinction decides whether a payment can be missed: Solana reports a slot that produced no
 * block as an *error*, not as an empty result, and an unwell endpoint reports its trouble the same
 * way. Reading the second as the first means the scanner sees an empty slot, advances past it, and
 * never looks at that slot again. Reading the first as the second means a healthy chain halts every
 * time it skips a slot, which it does routinely.
 *
 * The rest of these settle the decoding: a Solana transfer is a balance delta rather than an event,
 * so what the gateway credits is entirely a product of how these arrays are read.
 */

const PAYER = 'HN7cABqLq46Es1jh92dQQpjP1Y2eL3RGX1KFqjVvDpUS';
const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNATURE =
  '23XfW1pvgFCsiVNr4WHZwSpyK7grrk6Ao4wbAKK6mbHwocyAr57TdVtjQQjg4hJN7fcfdvMWaVx2obwujA1uTLyP';

/** The node named this field, not this codebase, so it is data rather than an identifier. */
const FAILURE_FIELD = 'err';

interface Answer {
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
  readonly status?: number;
}

let server: Server;
let endpoint = '';
let answers: Record<string, Answer> = {};
let received: { method: string; params: unknown[] }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      received.push({ method: call.method, params: call.params ?? [] });
      const answer = answers[call.method] ?? { result: null };
      if (answer.status !== undefined && answer.status !== 200) {
        response.writeHead(answer.status);
        response.end('unavailable');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          answer.error === undefined
            ? { jsonrpc: '2.0', id: call.id, result: answer.result }
            : { jsonrpc: '2.0', id: call.id, error: answer.error },
        ),
      );
    });
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  endpoint = `http://127.0.0.1:${port.toString()}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => {
    server.close(() => {
      closed();
    });
  });
});

beforeEach(() => {
  answers = {};
  received = [];
});

function held(amount: string): unknown {
  return { account: { data: { parsed: { info: { tokenAmount: { amount } } } } } };
}

function node(): HttpSolanaNode {
  return new HttpSolanaNode({ endpoint, timeoutMilliseconds: 5000 });
}

function blockResult(options: {
  readonly blockhash?: string;
  readonly previousBlockhash?: string;
  readonly parentSlot?: number;
  readonly blockTime?: number;
  readonly transactions?: unknown[];
}): unknown {
  return {
    blockhash: options.blockhash ?? 'blockhash-100',
    previousBlockhash: options.previousBlockhash,
    parentSlot: options.parentSlot,
    blockTime: options.blockTime,
    transactions: options.transactions ?? [],
  };
}

function transactionResult(options: {
  readonly accountKeys?: unknown[];
  readonly failed?: boolean;
  readonly preBalances?: number[];
  readonly postBalances?: number[];
  readonly preTokenBalances?: unknown[];
  readonly postTokenBalances?: unknown[];
  readonly withoutMeta?: boolean;
}): unknown {
  const transaction = {
    signatures: [SIGNATURE],
    message: { accountKeys: options.accountKeys ?? [{ pubkey: PAYER }, { pubkey: MERCHANT }] },
  };
  if (options.withoutMeta === true) {
    return { transaction };
  }
  return {
    transaction,
    meta: {
      [FAILURE_FIELD]: options.failed === true ? { InstructionError: [0, 'Custom'] } : null,
      preBalances: options.preBalances ?? [],
      postBalances: options.postBalances ?? [],
      preTokenBalances: options.preTokenBalances ?? [],
      postTokenBalances: options.postTokenBalances ?? [],
    },
  };
}

describe('a slot that produced no block, and an endpoint that could not say', () => {
  it.each([
    ['the node calls it skipped', { code: -32_009, message: 'Slot 100 was skipped' }],
    ['the node cites a ledger jump', { code: -32_007, message: 'missing due to ledger jump' }],
    ['the node sends only the code for an unavailable slot', { code: -32_004 }],
  ])('reports no block when %s', async (_label, error) => {
    answers.getBlock = { error };

    await expect(node().readBlock(100)).resolves.toBeNull();
  });

  it('reports no block when the node answers with a null result', async () => {
    answers.getBlock = { result: null };

    await expect(node().readBlock(100)).resolves.toBeNull();
  });

  /**
   * The one that decides whether a payment can be lost. An unwell endpoint reports its trouble the
   * same way a skipped slot is reported, and reading it as an empty slot means the scan succeeds,
   * the cursor advances past the slot, and nothing looks at it again.
   */
  it('refuses, rather than reporting an empty slot, when the node is merely unwell', async () => {
    answers.getBlock = { error: { code: -32_005, message: 'Node is behind by 500 slots' } };

    await expect(node().readBlock(100)).rejects.toThrow(/could not be reached/);
  });

  it('refuses a block response carrying no blockhash', async () => {
    answers.getBlock = { result: { transactions: [] } };

    await expect(node().readBlock(100)).rejects.toThrow(/no blockhash/);
  });

  it('refuses a status line that is not a success', async () => {
    answers.getBlock = { status: 503 };

    await expect(node().readBlock(100)).rejects.toThrow(/answered 503/);
  });
});

describe('reading a block header', () => {
  /**
   * Solana skips slots, so a block's parent is very often not the slot before it. Following height
   * minus one would read a healthy chain as a fork, which is why the reported value wins.
   */
  it('keeps the parent slot the node reported', async () => {
    answers.getBlock = { result: blockResult({ parentSlot: 74, blockTime: 1_757_000_000 }) };

    const block = await node().readBlock(100);

    expect(block?.header.parentSlot).toBe(74);
    expect(block?.header.slot).toBe(100);
    expect(block?.header.blockTimeMilliseconds).toBe(1_757_000_000_000);
  });

  /** Only where the node states none, and only then, is the previous slot the honest guess. */
  it('falls back to the previous slot when the node states no parent', async () => {
    answers.getBlock = { result: blockResult({}) };

    const block = await node().readBlock(100);

    expect(block?.header.parentSlot).toBe(99);
    expect(block?.header.previousBlockhash).toBe('');
    expect(block?.header.blockTimeMilliseconds).toBe(0);
  });
});

describe('reading what moved in a block', () => {
  it('pairs each account with its balance before and after', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [
          transactionResult({
            preBalances: [1_000_000_000, 0],
            postBalances: [900_000_000, 2_500_000_000],
          }),
        ],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.nativeDeltas).toEqual([
      { account: PAYER, before: 1_000_000_000n, after: 900_000_000n },
      { account: MERCHANT, before: 0n, after: 2_500_000_000n },
    ]);
  });

  /** A balance array shorter than the account list describes accounts nothing is known about. */
  it('reports no delta for an account the balance arrays do not reach', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [transactionResult({ preBalances: [1000], postBalances: [900] })],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.nativeDeltas).toHaveLength(1);
  });

  /** An account list may carry bare strings rather than objects, and both name the same account. */
  it('reads an account list of plain strings', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [
          transactionResult({
            accountKeys: [PAYER, MERCHANT],
            preBalances: [10, 0],
            postBalances: [5, 5],
          }),
        ],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.nativeDeltas.map((delta) => delta.account)).toEqual([
      PAYER,
      MERCHANT,
    ]);
  });

  /**
   * The ordinary case for a first payment to a fresh destination: the token account did not exist
   * before the transaction, so it appears in no pre list. Reading that as anything but zero would
   * make the credited amount wrong on every new address.
   */
  it('reads a token account that did not exist before as having held nothing', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [
          transactionResult({
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: MERCHANT,
                uiTokenAmount: { amount: '25000000' },
              },
            ],
          }),
        ],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.tokenDeltas).toEqual([
      { owner: MERCHANT, mint: MINT, before: 0n, after: 25_000_000n },
    ]);
  });

  it('matches the balance before against the balance after by account index', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [
          transactionResult({
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: MERCHANT,
                uiTokenAmount: { amount: '1000000' },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: MERCHANT,
                uiTokenAmount: { amount: '3000000' },
              },
            ],
          }),
        ],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.tokenDeltas[0]).toEqual({
      owner: MERCHANT,
      mint: MINT,
      before: 1_000_000n,
      after: 3_000_000n,
    });
  });

  /** Without an owner or a mint there is nothing to attribute a credit to, or to identify it as. */
  it.each([
    ['no owner', { accountIndex: 1, mint: MINT, uiTokenAmount: { amount: '1' } }],
    ['no mint', { accountIndex: 1, owner: MERCHANT, uiTokenAmount: { amount: '1' } }],
    ['no account index', { mint: MINT, owner: MERCHANT, uiTokenAmount: { amount: '1' } }],
  ])('ignores a token balance with %s', async (_label, entry) => {
    answers.getBlock = {
      result: blockResult({ transactions: [transactionResult({ postTokenBalances: [entry] })] }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions[0]?.tokenDeltas).toEqual([]);
  });

  /**
   * A failed transaction still pays its fee and still appears in the block, and its balance changes
   * were rolled back. Crediting one would credit money that never moved.
   */
  it('reports a failed transaction as not succeeded rather than hiding it', async () => {
    answers.getBlock = {
      result: blockResult({
        transactions: [
          transactionResult({ failed: true, preBalances: [1, 0], postBalances: [0, 1] }),
        ],
      }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions).toHaveLength(1);
    expect(block?.transactions[0]?.succeeded).toBe(false);
  });

  it('skips an entry the node sent without the metadata every balance comes from', async () => {
    answers.getBlock = {
      result: blockResult({ transactions: [transactionResult({ withoutMeta: true })] }),
    };

    const block = await node().readBlock(100);

    expect(block?.transactions).toEqual([]);
  });
});

describe('the questions asked of the node', () => {
  it('reads slots, genesis and produced slots at the finalized commitment', async () => {
    answers.getSlot = { result: 500 };
    answers.getGenesisHash = { result: 'a-genesis-identity' };
    answers.getBlocks = { result: [100, 102] };

    await expect(node().readFinalizedSlot()).resolves.toBe(500);
    await expect(node().readGenesisIdentity()).resolves.toBe('a-genesis-identity');
    await expect(node().readProducedSlots(100, 103)).resolves.toEqual([100, 102]);

    expect(received[0]?.params).toEqual([{ commitment: 'finalized' }]);
    expect(received[2]?.params).toEqual([100, 103, { commitment: 'finalized' }]);
  });

  it('reports the slot a signature landed in, and nothing when the chain has no status for it', async () => {
    answers.getSignatureStatuses = { result: { value: [{ slot: 4242 }] } };
    await expect(node().readSlotOfSignature(SIGNATURE)).resolves.toBe(4242);

    answers.getSignatureStatuses = { result: { value: [null] } };
    await expect(node().readSlotOfSignature(SIGNATURE)).resolves.toBeNull();
  });

  it('reads a native balance, and nothing as zero', async () => {
    answers.getBalance = { result: { value: 2_500_000_000 } };
    await expect(node().readNativeBalance(MERCHANT)).resolves.toBe(2_500_000_000n);

    answers.getBalance = { result: {} };
    await expect(node().readNativeBalance(MERCHANT)).resolves.toBe(0n);
  });

  /**
   * One owner may hold several token accounts for the same mint. Reading only the first would report
   * a balance smaller than the one the chain actually holds.
   */
  it('adds up every token account the owner holds for that mint', async () => {
    answers.getTokenAccountsByOwner = { result: { value: [held('25000000'), held('5000000')] } };

    await expect(node().readTokenBalance(MERCHANT, MINT)).resolves.toBe(30_000_000n);
  });

  it('reads an owner with no token account for that mint as holding nothing', async () => {
    answers.getTokenAccountsByOwner = { result: { value: [] } };

    await expect(node().readTokenBalance(MERCHANT, MINT)).resolves.toBe(0n);
  });
});
