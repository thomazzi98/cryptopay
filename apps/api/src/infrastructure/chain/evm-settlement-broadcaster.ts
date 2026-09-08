import {
  toCanonicalAddress,
  type Environment,
  type LedgerPosition,
  type NetworkIdentifier,
} from '@cryptopay/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  fallback,
  getAddress,
  http,
  keccak256,
  BaseError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  NonceTooLowError,
  RpcRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';

import type {
  AssetTransferRequest,
  BroadcastReconciliation,
  EstimateOutcome,
  FeeEstimate,
  NativeTransferRequest,
  SettlementBroadcaster,
  SigningRole,
  SignOutcome,
  SubmitResult,
} from '../../application/ports/settlement-broadcaster.port.js';
import type { SigningPath, WalletSigningProvider } from '../wallet/signing-provider.js';

/**
 * The EVM write path.
 *
 * This file and the wallet signing provider are the only two places that can move money. Everything
 * here is written on the assumption that the network will fail in the middle of an operation,
 * because eventually it does, and the difference between a good and a bad payment system is which
 * of those failures cost money.
 *
 * Three decisions carry that weight:
 *
 * Transactions are signed and then submitted, never both at once. The reference is derived from the
 * signed bytes before anything is sent, so a submission that times out leaves something to ask the
 * chain about. Without it the only choices are sending again, which can pay twice, or writing the
 * funds off.
 *
 * Every fee field is supplied explicitly rather than filled in by the client. Letting the transport
 * choose a nonce means two workers can be handed the same one, and letting it choose fees means the
 * amount recorded against the spend ceiling is not the amount that was signed.
 *
 * Provider errors are classified rather than counted. A reverted call and an unreachable endpoint
 * both surface as a rejected promise, and answering them the same way either retries something that
 * will never work or abandons something that would have worked on the next tick.
 */

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;

/** Estimates are exact for a plain transfer and can be a little low for a contract call. */
const COMPUTE_LIMIT_SAFETY_PERCENT = 125n;

export interface EvmSettlementBroadcasterOptions {
  readonly networkIdentifier: NetworkIdentifier;
  readonly chainIdentifier: number;
  readonly displayName: string;
  readonly nativeCurrencySymbol: string;
  readonly nativeCurrencyDecimals: number;
  readonly rpcUrls: readonly string[];
  readonly environment: Environment;
  readonly signingProvider: WalletSigningProvider;
  /** Resolved once at construction so nothing has to open the seed to learn where gas comes from. */
  readonly treasuryAccount: string;
  readonly requestTimeoutMilliseconds?: number;
}

class SettlementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementConfigurationError';
  }
}

function toSigningPath(role: SigningRole): SigningPath {
  if (role.kind === 'treasury') {
    return { kind: 'treasury' };
  }
  return { kind: 'deposit', derivationIndex: role.derivationIndex };
}

/**
 * Classifies why an estimate failed.
 *
 * The distinction that matters is "this will never work" against "nobody answered". Treating the
 * first as transient retries a doomed call until the attempt limit; treating the second as
 * permanent abandons a settlement because an endpoint was briefly rate limited.
 */
function classifyEstimateFailure(error: unknown): EstimateOutcome {
  if (!(error instanceof BaseError)) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : 'unknown error',
    };
  }

  const transport = error.walk(
    (candidate) =>
      candidate instanceof HttpRequestError ||
      candidate instanceof TimeoutError ||
      candidate instanceof RpcRequestError,
  );
  if (transport !== null) {
    return { kind: 'unavailable', reason: error.shortMessage };
  }

  const reverted = error.walk(
    (candidate) =>
      candidate instanceof ExecutionRevertedError || candidate instanceof InsufficientFundsError,
  );
  if (reverted !== null) {
    return { kind: 'would_revert', reason: error.shortMessage };
  }

  // Unrecognised failures are treated as transient. The attempt counter bounds the cost of being
  // wrong in this direction; abandoning a settlement that would have worked has no such bound.
  return { kind: 'unavailable', reason: error.shortMessage };
}

export class EvmSettlementBroadcaster implements SettlementBroadcaster {
  private readonly options: EvmSettlementBroadcasterOptions;
  private readonly client: PublicClient;
  private readonly chain: Chain;

  readonly networkIdentifier: NetworkIdentifier;
  readonly treasuryAccount: string;

  constructor(options: EvmSettlementBroadcasterOptions) {
    if (options.rpcUrls.length === 0) {
      throw new SettlementConfigurationError(
        `${options.networkIdentifier} has no RPC endpoint, so nothing can be broadcast for it`,
      );
    }

    this.options = options;
    this.networkIdentifier = options.networkIdentifier;
    this.treasuryAccount = toCanonicalAddress(options.treasuryAccount);

    const timeout = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;

    // Declared rather than imported from viem/chains so the chain id comes from the same
    // configuration the scanner validates against, and the two cannot describe different networks.
    this.chain = defineChain({
      id: options.chainIdentifier,
      name: options.displayName,
      nativeCurrency: {
        name: options.nativeCurrencySymbol,
        symbol: options.nativeCurrencySymbol,
        decimals: options.nativeCurrencyDecimals,
      },
      rpcUrls: { default: { http: [...options.rpcUrls] } },
    });

    this.client = createPublicClient({
      chain: this.chain,
      transport: fallback(options.rpcUrls.map((url) => http(url, { timeout }))),
    });
  }

  async assertLedgerIdentity(): Promise<void> {
    const observed = await this.client.getChainId();
    if (observed !== this.options.chainIdentifier) {
      throw new SettlementConfigurationError(
        `The endpoint for ${this.networkIdentifier} reported chain ${observed.toString()} where ${this.options.chainIdentifier.toString()} was configured. Refusing to sign.`,
      );
    }
  }

  /**
   * EIP-1559 fees only. viem raises its own error on a chain that does not support them, which is
   * the correct outcome: a legacy-priced transaction on a network that expects the new fields is
   * mispriced rather than merely different, and mispricing is how a sweep sits in the mempool.
   */
  private async estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const fees = await this.client.estimateFeesPerGas();
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  private static toEstimate(
    gasLimit: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
  ): FeeEstimate {
    const padded = (gasLimit * COMPUTE_LIMIT_SAFETY_PERCENT) / 100n;
    return {
      maximumFeeInNativeUnits: padded * maxFeePerGas,
      feeParameters: Object.freeze({
        computeLimit: padded.toString(),
        maximumFeePerComputeUnit: maxFeePerGas.toString(),
        priorityFeePerComputeUnit: maxPriorityFeePerGas.toString(),
      }),
    };
  }

  private static readFeeParameters(estimate: FeeEstimate): {
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  } {
    // Read back through a widened view: these values round-trip through JSONB, where nothing
    // guarantees the adapter that wrote them is the one reading them.
    const parameters: Partial<Record<string, string>> = estimate.feeParameters;
    const gas = parameters.computeLimit;
    const maximum = parameters.maximumFeePerComputeUnit;
    const priority = parameters.priorityFeePerComputeUnit;
    if (gas === undefined || maximum === undefined || priority === undefined) {
      throw new SettlementConfigurationError(
        'Fee parameters are missing fields this adapter wrote, so they came from another chain',
      );
    }
    return {
      gas: BigInt(gas),
      maxFeePerGas: BigInt(maximum),
      maxPriorityFeePerGas: BigInt(priority),
    };
  }

  private assetTransferData(request: AssetTransferRequest): Hex {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [getAddress(request.destinationAccount), request.amount],
    });
  }

  async estimateAssetTransfer(request: AssetTransferRequest): Promise<EstimateOutcome> {
    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.estimateFees();
      const gasLimit = await this.client.estimateGas({
        account: getAddress(request.sourceAccount),
        to: getAddress(request.assetReference),
        data: this.assetTransferData(request),
      });
      return {
        kind: 'estimated',
        estimate: EvmSettlementBroadcaster.toEstimate(gasLimit, maxFeePerGas, maxPriorityFeePerGas),
      };
    } catch (error) {
      return classifyEstimateFailure(error);
    }
  }

  async estimateNativeTransfer(request: NativeTransferRequest): Promise<EstimateOutcome> {
    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.estimateFees();
      const gasLimit = await this.client.estimateGas({
        account: getAddress(request.sourceAccount),
        to: getAddress(request.destinationAccount),
        value: request.amountInNativeUnits,
      });
      return {
        kind: 'estimated',
        estimate: EvmSettlementBroadcaster.toEstimate(gasLimit, maxFeePerGas, maxPriorityFeePerGas),
      };
    } catch (error) {
      return classifyEstimateFailure(error);
    }
  }

  /**
   * Signs, having first checked that the key really controls the account the caller named and that
   * the endpoint really is the configured chain.
   *
   * Both checks are here rather than at the call site because a signature is valid on every EVM
   * chain simultaneously. An endpoint quietly serving a different network turns a rehearsal into a
   * mainnet transaction, and there is no undo.
   */
  private async sign(
    role: SigningRole,
    expectedSourceAccount: string,
    to: string,
    data: Hex | undefined,
    value: bigint,
    sequenceNumber: number,
    estimate: FeeEstimate,
  ): Promise<SignOutcome> {
    await this.assertLedgerIdentity();

    const { gas, maxFeePerGas, maxPriorityFeePerGas } =
      EvmSettlementBroadcaster.readFeeParameters(estimate);

    return this.options.signingProvider.withAccount(
      this.options.environment,
      toSigningPath(role),
      async (account) => {
        const derived = toCanonicalAddress(account.address);
        if (derived !== toCanonicalAddress(expectedSourceAccount)) {
          return {
            kind: 'refused',
            reason: `The key for this role derives ${derived}, not ${expectedSourceAccount}. Refusing to sign for an account this seed does not control.`,
          };
        }

        const walletClient = createWalletClient({
          account,
          chain: this.chain,
          transport: http(this.options.rpcUrls[0]),
        });

        const signedPayload = await walletClient.signTransaction({
          to: getAddress(to),
          value,
          nonce: sequenceNumber,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          type: 'eip1559',
          ...(data !== undefined && { data }),
        });

        return {
          kind: 'signed',
          transactionReference: keccak256(signedPayload).toLowerCase(),
          signedPayload,
        };
      },
    );
  }

  signAssetTransfer(
    request: AssetTransferRequest,
    sequenceNumber: number,
    estimate: FeeEstimate,
  ): Promise<SignOutcome> {
    return this.sign(
      request.signingRole,
      request.sourceAccount,
      request.assetReference,
      this.assetTransferData(request),
      0n,
      sequenceNumber,
      estimate,
    );
  }

  signNativeTransfer(
    request: NativeTransferRequest,
    sequenceNumber: number,
    estimate: FeeEstimate,
  ): Promise<SignOutcome> {
    return this.sign(
      request.signingRole,
      request.sourceAccount,
      request.destinationAccount,
      undefined,
      request.amountInNativeUnits,
      sequenceNumber,
      estimate,
    );
  }

  async submit(signedPayload: string): Promise<SubmitResult> {
    try {
      await this.client.sendRawTransaction({ serializedTransaction: signedPayload as Hex });
      return { kind: 'accepted' };
    } catch (error) {
      if (!(error instanceof BaseError)) {
        return {
          kind: 'indeterminate',
          reason: error instanceof Error ? error.message : 'unknown error',
        };
      }

      // A sequence number the chain has already passed means this exact transaction cannot enter the
      // mempool. Nothing was sent and nothing will be, so the caller is free to plan again.
      const alreadyPast = error.walk((candidate) => candidate instanceof NonceTooLowError);
      if (alreadyPast !== null) {
        return { kind: 'rejected', reason: error.shortMessage };
      }

      const refused = error.walk(
        (candidate) =>
          candidate instanceof ExecutionRevertedError ||
          candidate instanceof InsufficientFundsError,
      );
      if (refused !== null) {
        return { kind: 'rejected', reason: error.shortMessage };
      }

      // Anything else may or may not have reached a node. The caller recorded the reference before
      // calling precisely so that this case is answerable by the chain rather than by guessing.
      return { kind: 'indeterminate', reason: error.shortMessage };
    }
  }

  /**
   * Answers what became of a transaction, and never guesses.
   *
   * The order is deliberate. A receipt is proof. Absent a receipt, an account sequence that has
   * moved past this transaction proves something else took the slot, which is the only evidence
   * that makes replanning safe. The receipt is checked once more before concluding that, because a
   * single failed lookup against one endpoint would otherwise be read as displacement.
   */
  async reconcileBroadcast(
    transactionReference: string,
    sourceAccount: string,
    sequenceNumber: number,
  ): Promise<BroadcastReconciliation> {
    const receipt = await this.tryReadReceipt(transactionReference);
    if (receipt.kind === 'error') {
      return { kind: 'indeterminate', reason: receipt.reason };
    }
    if (receipt.kind === 'found') {
      return receipt.reconciliation;
    }

    let observedSequence: number;
    try {
      observedSequence = await this.client.getTransactionCount({
        address: getAddress(sourceAccount),
        blockTag: 'latest',
      });
    } catch (error) {
      return {
        kind: 'indeterminate',
        reason: error instanceof BaseError ? error.shortMessage : 'the account count is unknown',
      };
    }

    if (observedSequence <= sequenceNumber) {
      return { kind: 'pending' };
    }

    const confirmation = await this.tryReadReceipt(transactionReference);
    if (confirmation.kind === 'found') {
      return confirmation.reconciliation;
    }
    if (confirmation.kind === 'error') {
      return { kind: 'indeterminate', reason: confirmation.reason };
    }
    return { kind: 'superseded' };
  }

  private async tryReadReceipt(
    transactionReference: string,
  ): Promise<
    | { kind: 'found'; reconciliation: BroadcastReconciliation }
    | { kind: 'absent' }
    | { kind: 'error'; reason: string }
  > {
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: transactionReference as Hex,
      });
      const position: LedgerPosition = {
        height: receipt.blockNumber,
        reference: receipt.blockHash.toLowerCase(),
      };
      return {
        kind: 'found',
        reconciliation: {
          kind: 'mined',
          position,
          succeeded: receipt.status === 'success',
          computeUsed: receipt.gasUsed,
          feePaidInNativeUnits: receipt.gasUsed * receipt.effectiveGasPrice,
        },
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        return { kind: 'absent' };
      }
      return {
        kind: 'error',
        reason: error instanceof BaseError ? error.shortMessage : 'the receipt is unknown',
      };
    }
  }

  async readAccountSequence(account: string): Promise<number> {
    return this.client.getTransactionCount({
      address: getAddress(account),
      blockTag: 'latest',
    });
  }

  async readNativeBalance(account: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(account) });
  }

  async readAssetBalance(account: string, assetReference: string): Promise<bigint> {
    return this.client.readContract({
      address: getAddress(assetReference),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(account)],
    });
  }
}
