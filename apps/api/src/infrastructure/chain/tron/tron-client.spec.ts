import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HttpTronNode, TronTransportError } from './tron-client.js';

/**
 * What this client makes of what TronGrid says.
 *
 * The transport is split from the gateway precisely so these can be driven by recorded answers, and
 * the two questions they exist to settle are the ones that decide whether money moves: does a body
 * that reports a failure become "there is no payment here", and does a shape the endpoint really
 * sends decode to the values the gateway then reasons about.
 *
 * Every read on this client degrades an unrecognised body into a benign negative: no block at this
 * height, no events in this block, the chain does not know this transaction, the account holds
 * nothing. Each is a legitimate answer the scanner and the reconciler act on, so an endpoint failing
 * while answering 200 used to become a window scanned as empty with the cursor advanced past it, or
 * a credited transfer withdrawn as orphaned because the node that could confirm it was the one that
 * failed.
 */

/** TronGrid chose these spellings, not this codebase, so they are data rather than identifiers. */
const BLOCK_NUMBER_FIELD = 'num';
const RANGE_START_FIELD = 'startNum';
const RANGE_END_FIELD = 'endNum';

const CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const HOLDER = 'TVF2Mp9QY7FEGTnr3DBpFLobA6jguHyMvi';

interface Received {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly apiKey: string | undefined;
}

let server: Server;
let baseUrl = '';
let answer: unknown = {};
let status = 200;
let received: Received[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
        apiKey: request.headers['tron-pro-api-key'] as string | undefined,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port.toString()}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => {
    server.close(() => {
      closed();
    });
  });
});

beforeEach(() => {
  answer = {};
  status = 200;
  received = [];
});

function node(apiKey: string | null = null): HttpTronNode {
  return new HttpTronNode({ baseUrl, apiKey, timeoutMilliseconds: 5000 });
}

function lastRequest(): Received {
  const last = received.at(-1);
  if (last === undefined) {
    throw new Error('The client sent no request');
  }
  return last;
}

function blockBody(options: {
  readonly number?: number;
  readonly blockId?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly transactions?: unknown[];
}): unknown {
  return {
    blockID: options.blockId ?? 'AABB'.padEnd(64, '0'),
    block_header: {
      raw_data: {
        number: options.number,
        parentHash: options.parentHash ?? 'CCDD'.padEnd(64, '0'),
        timestamp: options.timestamp ?? 1_757_000_000_000,
      },
    },
    transactions: options.transactions,
  };
}

describe('an endpoint that fails while answering two hundred', () => {
  it.each([
    ['reading a block', async () => node().readBlock(100)],
    ['reading a block range', async () => node().readBlockRange(100, 101)],
    ['reading the events in a block', async () => node().readBlockEvents(100)],
    ['looking a transaction up', async () => node().readTransaction('a'.repeat(64))],
    ['reading a native balance', async () => node().readNativeBalance(CONTRACT)],
    ['reading the head', async () => node().readHead()],
  ])('refuses rather than reporting nothing found when %s', async (_label, read) => {
    answer = { Error: 'class org.tron.core.exception.ItemNotFoundException : failed' };

    await expect(read()).rejects.toBeInstanceOf(TronTransportError);
  });

  /**
   * The distinction that has to survive the fix. A height above the head is a real answer and must
   * stay one, or the scanner would halt every time it caught up with the chain.
   */
  it('still reports no block for a height the chain has not reached', async () => {
    answer = {};

    await expect(node().readBlock(100)).resolves.toBeNull();
  });

  it('still reports an account that holds nothing', async () => {
    answer = {};

    await expect(node().readNativeBalance(CONTRACT)).resolves.toBe(0n);
  });

  it('still reports a transaction the chain genuinely does not carry', async () => {
    answer = {};

    await expect(node().readTransaction('a'.repeat(64))).resolves.toBeNull();
  });

  it('refuses a status line that is not a success', async () => {
    status = 502;

    await expect(node().readHead()).rejects.toBeInstanceOf(TronTransportError);
  });
});

describe('reading a block header', () => {
  /** The genesis block omits `number` rather than reporting zero, and it is a real block. */
  it('reads the genesis block, which states no height at all', async () => {
    answer = blockBody({ blockId: 'FF'.padEnd(64, '0') });

    const genesis = await node().readGenesisIdentity();

    expect(genesis).toBe('ff'.padEnd(64, '0'));
    expect(lastRequest().body).toEqual({ [BLOCK_NUMBER_FIELD]: 0 });
  });

  /**
   * Identifiers are compared as opaque strings against values this system stored earlier, so a node
   * that answers in upper case and one that answers in lower case have to produce the same header.
   */
  it('lowercases the identifiers it will later be asked to compare', async () => {
    answer = blockBody({
      number: 42,
      blockId: 'AB'.padEnd(64, 'C'),
      parentHash: 'DE'.padEnd(64, 'F'),
    });

    const header = await node().readHead();

    expect(header.blockId).toBe('ab'.padEnd(64, 'c'));
    expect(header.parentHash).toBe('de'.padEnd(64, 'f'));
    expect(header.number).toBe(42);
  });

  it('refuses a block response carrying no identifier', async () => {
    answer = { block_header: { raw_data: { number: 42 } } };

    await expect(node().readHead()).rejects.toBeInstanceOf(TronTransportError);
  });

  it('reads the solidified head from the endpoint that serves it', async () => {
    answer = blockBody({ number: 81 });

    await node().readSolidifiedHead();

    expect(lastRequest().path).toBe('/walletsolidity/getnowblock');
  });

  it('sends the api key when one is configured, and no header when none is', async () => {
    answer = blockBody({ number: 1 });
    await node('a-key').readHead();
    expect(lastRequest().apiKey).toBe('a-key');

    await node().readHead();
    expect(lastRequest().apiKey).toBeUndefined();
  });
});

describe('reading the transactions in a block', () => {
  const TRANSFER = {
    txID: 'AA'.padEnd(64, '1'),
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: {
      contract: [
        {
          type: 'TransferContract',
          parameter: {
            value: {
              owner_address: '41AAAA'.padEnd(42, '0'),
              to_address: '41BBBB'.padEnd(42, '0'),
              amount: 25_000_000,
            },
          },
        },
      ],
    },
  };

  it('decodes a native transfer into the fields the gateway credits on', async () => {
    answer = blockBody({ number: 10, transactions: [TRANSFER] });

    const block = await node().readBlock(10);
    const transaction = block?.transactions[0];

    expect(transaction?.transactionId).toBe('aa'.padEnd(64, '1'));
    expect(transaction?.succeeded).toBe(true);
    expect(transaction?.contract).toEqual({
      type: 'TransferContract',
      ownerAddressHex: '41aaaa'.padEnd(42, '0'),
      toAddressHex: '41bbbb'.padEnd(42, '0'),
      amount: 25_000_000n,
      contractAddressHex: null,
    });
  });

  /** A reverted transfer occupies a block and moves nothing. Crediting one credits money that never moved. */
  it.each([['REVERT'], ['OUT_OF_ENERGY'], [undefined]])(
    'reports a transaction whose result is %s as not succeeded',
    async (contractRet) => {
      answer = blockBody({
        number: 10,
        transactions: [{ ...TRANSFER, ret: contractRet === undefined ? [] : [{ contractRet }] }],
      });

      const block = await node().readBlock(10);

      expect(block?.transactions[0]?.succeeded).toBe(false);
    },
  );

  it('reports no contract at all for a transaction that names none', async () => {
    answer = blockBody({
      number: 10,
      transactions: [{ txID: 'bb'.padEnd(64, '2'), raw_data: {} }],
    });

    const block = await node().readBlock(10);

    expect(block?.transactions[0]?.contract).toBeNull();
  });

  it('reads a contract call, which names a contract and no plain recipient', async () => {
    answer = blockBody({
      number: 10,
      transactions: [
        {
          txID: 'cc'.padEnd(64, '3'),
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: {
            contract: [
              {
                type: 'TriggerSmartContract',
                parameter: { value: { contract_address: '41CCCC'.padEnd(42, '0') } },
              },
            ],
          },
        },
      ],
    });

    const block = await node().readBlock(10);

    expect(block?.transactions[0]?.contract).toEqual({
      type: 'TriggerSmartContract',
      ownerAddressHex: '',
      toAddressHex: null,
      amount: null,
      contractAddressHex: '41cccc'.padEnd(42, '0'),
    });
  });

  it('reads a block that carries no transactions as a block with none', async () => {
    answer = blockBody({ number: 10 });

    const block = await node().readBlock(10);

    expect(block?.transactions).toEqual([]);
    expect(block?.header.number).toBe(10);
  });
});

describe('reading a range of blocks', () => {
  /** The endpoint treats the end as exclusive, so asking for one block means asking for two. */
  it('asks for one block past the end, because the end is exclusive', async () => {
    answer = { block: [blockBody({ number: 10 })] };

    const blocks = await node().readBlockRange(10, 10);

    expect(lastRequest().body).toEqual({ [RANGE_START_FIELD]: 10, [RANGE_END_FIELD]: 11 });
    expect(blocks).toHaveLength(1);
  });

  it('reads an answer with no blocks in it as no blocks', async () => {
    answer = {};

    await expect(node().readBlockRange(10, 12)).resolves.toEqual([]);
  });
});

describe('reading the events in a block', () => {
  const LOG = {
    address: 'AAAA'.padEnd(40, '0'),
    topics: ['DDF2'.padEnd(64, '0')],
    data: 'FF'.padEnd(64, '0'),
  };

  it('numbers the logs within a transaction and lowercases what it will compare', async () => {
    answer = [{ id: 'EE'.padEnd(64, '4'), receipt: { result: 'SUCCESS' }, log: [LOG, LOG] }];

    const events = await node().readBlockEvents(10);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.logIndex)).toEqual([0, 1]);
    expect(events[0]?.transactionId).toBe('ee'.padEnd(64, '4'));
    expect(events[0]?.contractAddressHex).toBe('aaaa'.padEnd(40, '0'));
    expect(events[0]?.topics).toEqual(['ddf2'.padEnd(64, '0')]);
    expect(events[0]?.data).toBe('ff'.padEnd(64, '0'));
    expect(events[0]?.succeeded).toBe(true);
  });

  /**
   * A call that ran out of energy still emits a receipt, and its logs describe work that was rolled
   * back. They are reported rather than dropped so the gateway decides, but they are not successes.
   */
  it('reports the logs of a call that failed as not succeeded', async () => {
    answer = [{ id: 'ff'.padEnd(64, '5'), receipt: { result: 'OUT_OF_ENERGY' }, log: [LOG] }];

    const events = await node().readBlockEvents(10);

    expect(events).toHaveLength(1);
    expect(events[0]?.succeeded).toBe(false);
  });

  it('contributes nothing for a receipt that emitted no log', async () => {
    answer = [{ id: 'ab'.padEnd(64, '6'), receipt: { result: 'SUCCESS' } }];

    await expect(node().readBlockEvents(10)).resolves.toEqual([]);
  });

  it('reads an answer that is not a list as no events', async () => {
    answer = { note: 'this endpoint answered with an object' };

    await expect(node().readBlockEvents(10)).resolves.toEqual([]);
  });
});

describe('reading a token balance', () => {
  /**
   * The ABI argument is the twenty byte key hash left padded to thirty two. The base58 string and
   * the twenty-one byte payload both produce a call that returns zero for an account holding money,
   * which reads as an unpaid payment rather than as a broken request.
   */
  it('asks for the balance of the key hash, padded, without the address prefix', async () => {
    answer = { constant_result: ['0'.repeat(58).concat('17D7840')] };

    const balance = await node().readTokenBalance(HOLDER, CONTRACT);

    const sent = lastRequest().body;
    expect(sent.function_selector).toBe('balanceOf(address)');
    expect(sent.parameter).toMatch(/^0{24}[0-9a-f]{40}$/);
    expect(balance).toBe(25_000_000n);
  });

  it.each([[[]], [['']], [undefined]])('reads %s as a balance of nothing', async (result) => {
    answer = { constant_result: result };

    await expect(node().readTokenBalance(HOLDER, CONTRACT)).resolves.toBe(0n);
  });
});

describe('looking a transaction up', () => {
  it('reports the height the chain says it is in', async () => {
    answer = { blockNumber: 5000 };

    await expect(node().readTransaction('a'.repeat(64))).resolves.toEqual({ blockHeight: 5000 });
  });
});
