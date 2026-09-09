import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

/**
 * Enough Solana to build a real SPL token transfer, without taking on the web3 SDK.
 *
 * The adapter under test speaks raw JSON-RPC on purpose. Adding a large client library so the tests
 * could speak something else would put a second, differently-behaved implementation of the same
 * protocol in the repository, and a disagreement between them would be indistinguishable from a bug
 * in the adapter.
 *
 * A legacy message is a three byte header, a compact array of account keys, the recent blockhash,
 * then a compact array of instructions. Signatures go in front. Two things have to be exactly right
 * or the runtime rejects the transaction without saying why: the account keys are ordered
 * writable-signers, readonly-signers, writable, readonly, with the fee payer first; and the header
 * counts have to describe that ordering.
 */

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** The account layout of an SPL mint, which decides what it costs to make one rent exempt. */
export const MINT_ACCOUNT_BYTES = 82;

export interface Keypair {
  readonly account: string;
  readonly secretKey: Uint8Array;
}

interface AccountMeta {
  readonly account: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface Instruction {
  readonly programId: string;
  readonly keys: readonly AccountMeta[];
  readonly data: Uint8Array;
}

export function randomKeypair(): Keypair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { account: base58.encode(ed25519.getPublicKey(secretKey)), secretKey };
}

/** Solana's compact-u16: seven bits per byte, high bit continues. */
function compactLength(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const chunk = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      bytes.push(chunk);
      return Uint8Array.from(bytes);
    }
    bytes.push(chunk | 0x80);
  }
}

interface ResolvedAccount {
  readonly account: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Collects every account an instruction touches and puts them in the order the runtime expects.
 *
 * A key that appears twice keeps the strongest privilege it was given anywhere, which is why this
 * merges rather than appends: an account passed read-only to one instruction and writable to another
 * must end up writable, or the transaction fails at execution instead of at build time.
 */
function orderAccounts(payer: string, instructions: readonly Instruction[]): ResolvedAccount[] {
  const collected = new Map<string, ResolvedAccount>([
    [payer, { account: payer, isSigner: true, isWritable: true }],
  ]);

  const merge = (account: string, isSigner: boolean, isWritable: boolean): void => {
    const existing = collected.get(account);
    if (existing === undefined) {
      collected.set(account, { account, isSigner, isWritable });
      return;
    }
    existing.isSigner ||= isSigner;
    existing.isWritable ||= isWritable;
  };

  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      merge(key.account, key.isSigner, key.isWritable);
    }
    merge(instruction.programId, false, false);
  }

  const rank = (entry: ResolvedAccount): number => {
    if (entry.isSigner) {
      return entry.isWritable ? 0 : 1;
    }
    return entry.isWritable ? 2 : 3;
  };
  // The fee payer must come first. It is already writable and a signer, so it lands in bucket zero,
  // and a stable sort keeps it ahead of anything collected after it.
  return collected
    .values()
    .toArray()
    .toSorted((left, right) => rank(left) - rank(right));
}

export interface BuiltTransaction {
  readonly message: Uint8Array;
  readonly signerAccounts: readonly string[];
}

export function buildMessage(
  payer: string,
  instructions: readonly Instruction[],
  recentBlockhash: string,
): BuiltTransaction {
  const accounts = orderAccounts(payer, instructions);
  const indexOf = (account: string): number =>
    accounts.findIndex((entry) => entry.account === account);

  const requiredSignatures = accounts.filter((entry) => entry.isSigner).length;
  const readonlySigned = accounts.filter((entry) => entry.isSigner && !entry.isWritable).length;
  const readonlyUnsigned = accounts.filter((entry) => !entry.isSigner && !entry.isWritable).length;

  const encodedInstructions = instructions.map((instruction) =>
    Buffer.concat([
      Uint8Array.from([indexOf(instruction.programId)]),
      compactLength(instruction.keys.length),
      Uint8Array.from(instruction.keys.map((key) => indexOf(key.account))),
      compactLength(instruction.data.length),
      instruction.data,
    ]),
  );

  const message = Buffer.concat([
    Uint8Array.from([requiredSignatures, readonlySigned, readonlyUnsigned]),
    compactLength(accounts.length),
    ...accounts.map((entry) => base58.decode(entry.account)),
    base58.decode(recentBlockhash),
    compactLength(encodedInstructions.length),
    ...encodedInstructions,
  ]);

  return {
    message,
    signerAccounts: accounts.filter((entry) => entry.isSigner).map((entry) => entry.account),
  };
}

class SolanaTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaTransactionError';
  }
}

/**
 * Signatures travel in the order the signing accounts appear in the key list, so a signer that is
 * present but signs in the wrong slot produces a transaction the runtime attributes to the wrong
 * account and rejects.
 */
export function signTransaction(built: BuiltTransaction, signers: readonly Keypair[]): Uint8Array {
  const signatures = built.signerAccounts.map((account) => {
    const signer = signers.find((candidate) => candidate.account === account);
    if (signer === undefined) {
      throw new SolanaTransactionError(`No signer was supplied for ${account}`);
    }
    return ed25519.sign(built.message, signer.secretKey);
  });

  return Buffer.concat([compactLength(signatures.length), ...signatures, built.message]);
}

function withUnsignedLittleEndian(tag: number, value: bigint): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = tag;
  new DataView(data.buffer).setBigUint64(1, value, true);
  return data;
}

/** System program: create an account, fund it, size it and hand it to a program. */
export function createAccountInstruction(input: {
  readonly payer: string;
  readonly created: string;
  readonly lamports: bigint;
  readonly space: number;
  readonly owner: string;
}): Instruction {
  const data = new Uint8Array(52);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0, true);
  view.setBigUint64(4, input.lamports, true);
  view.setBigUint64(12, BigInt(input.space), true);
  data.set(base58.decode(input.owner), 20);

  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { account: input.payer, isSigner: true, isWritable: true },
      { account: input.created, isSigner: true, isWritable: true },
    ],
    data,
  };
}

/** System program: move lamports. */
export function transferLamportsInstruction(
  from: string,
  toAccount: string,
  lamports: bigint,
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);

  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { account: from, isSigner: true, isWritable: true },
      { account: toAccount, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** Token program instruction 20, which takes the authorities inline rather than from a sysvar. */
export function initializeMintInstruction(input: {
  readonly mint: string;
  readonly decimals: number;
  readonly mintAuthority: string;
}): Instruction {
  const data = new Uint8Array(35);
  data[0] = 20;
  data[1] = input.decimals;
  data.set(base58.decode(input.mintAuthority), 2);
  // No freeze authority. A mint that can freeze is a mint that can strand a payment.
  data[34] = 0;

  return {
    programId: TOKEN_PROGRAM,
    keys: [{ account: input.mint, isSigner: false, isWritable: true }],
    data,
  };
}

/** Token program instruction 7. */
export function mintToInstruction(input: {
  readonly mint: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: bigint;
}): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { account: input.mint, isSigner: false, isWritable: true },
      { account: input.destination, isSigner: false, isWritable: true },
      { account: input.authority, isSigner: true, isWritable: false },
    ],
    data: withUnsignedLittleEndian(7, input.amount),
  };
}

/** Token program instruction 3. */
export function transferTokenInstruction(input: {
  readonly source: string;
  readonly destination: string;
  readonly owner: string;
  readonly amount: bigint;
}): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { account: input.source, isSigner: false, isWritable: true },
      { account: input.destination, isSigner: false, isWritable: true },
      { account: input.owner, isSigner: true, isWritable: false },
    ],
    data: withUnsignedLittleEndian(3, input.amount),
  };
}

/**
 * Associated token account program instruction 1, the idempotent create.
 *
 * Idempotent because a destination may already have an account for this mint, and a payer must not
 * have to know which. The non-idempotent form fails the whole transaction when it exists.
 */
export function createAssociatedTokenAccountInstruction(input: {
  readonly payer: string;
  readonly associatedAccount: string;
  readonly owner: string;
  readonly mint: string;
}): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { account: input.payer, isSigner: true, isWritable: true },
      { account: input.associatedAccount, isSigner: false, isWritable: true },
      { account: input.owner, isSigner: false, isWritable: false },
      { account: input.mint, isSigner: false, isWritable: false },
      { account: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { account: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from([1]),
  };
}

const PROGRAM_DERIVED_ADDRESS_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const MAXIMUM_BUMP_SEED = 255;

function isOnCurve(candidate: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address an SPL wallet actually sends to.
 *
 * A program derived address is the first hash of the seeds that does *not* land on the ed25519
 * curve, walking the bump seed down from 255. Being off the curve is the whole point: no private key
 * can exist for it, so only the owning program can sign for it.
 */
export function associatedTokenAccount(owner: string, mint: string): string {
  const seeds = [base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint)];
  const programId = base58.decode(ASSOCIATED_TOKEN_PROGRAM);

  for (let bump = MAXIMUM_BUMP_SEED; bump >= 0; bump -= 1) {
    const candidate = sha256(
      Buffer.concat([...seeds, Uint8Array.from([bump]), programId, PROGRAM_DERIVED_ADDRESS_MARKER]),
    );
    if (!isOnCurve(candidate)) {
      return base58.encode(candidate);
    }
  }
  throw new SolanaTransactionError(`No associated token account exists for ${owner} and ${mint}`);
}
