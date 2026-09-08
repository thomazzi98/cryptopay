import type { Environment, NetworkIdentifier, SettlementStatus } from '@cryptopay/shared';

import { decideSpend, totalCommitted } from '../domain/spend-ceiling.js';
import type { StructuredLogger } from '../observability/logger.js';
import type {
  ChainTransaction,
  Settlement,
  SettlementRepository,
} from '../infrastructure/persistence/settlement.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';
import type { ChainGateway } from './ports/chain-gateway.port.js';
import type {
  FeeEstimate,
  SettlementBroadcaster,
  SigningRole,
} from './ports/settlement-broadcaster.port.js';

/**
 * Moving credited funds out of the address a customer paid into.
 *
 * The order of operations in a tick is the design. Outstanding transactions are reconciled against
 * the chain before anything new is signed, so the system never decides what to do next from a stale
 * belief about what it already did. Only then does it plan, and only then does it sign.
 *
 * Nothing here retries by resending. A transaction that might be in the mempool is resolved by
 * asking the chain what happened to it, and a new one is signed only once the old one is provably
 * incapable of being mined. That is the difference between a retry and a double payment.
 *
 * The sweep amount is read from the chain at planning time rather than taken from the credited
 * figure. They are usually equal and the difference is the point: the balance is what can actually
 * move, and a transfer for more than that reverts and costs a fee to learn nothing.
 */

export interface SettlementTickOutcome {
  readonly reconciled: number;
  readonly planned: number;
  readonly broadcast: number;
  readonly settled: number;
  readonly failed: number;
  readonly awaitingPayoutDestination: number;
}

export interface SettlePaymentsDependencies {
  readonly networkIdentifier: NetworkIdentifier;
  readonly gateway: ChainGateway;
  readonly broadcaster: SettlementBroadcaster;
  readonly settlementRepository: SettlementRepository;
  readonly ulidFactory: UlidFactory;
  readonly logger: StructuredLogger;
  readonly now: () => Date;
  /** Null means unlimited. Present as a number of native base units. */
  readonly spendCeilingInNativeUnits: bigint | null;
  readonly requiredConfirmations: number;
  readonly requiresFinalityTag: boolean;
  readonly maximumAttempts: number;
  readonly retryBackoffMilliseconds: number;
  readonly batchSize: number;
}

export class SettlePaymentsUseCase {
  private readonly dependencies: SettlePaymentsDependencies;

  constructor(dependencies: SettlePaymentsDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Records the treasury address and its balance where the API can read them.
   *
   * The API cannot derive the address — it holds no key material and must not — so the process that
   * can is the one that writes it down. Without this an operator has no way to learn which account
   * to fund, and the first symptom of an unfunded treasury is settlements that quietly wait.
   */
  async reportTreasury(environment: Environment): Promise<void> {
    const account = this.dependencies.broadcaster.treasuryAccount;
    const balance = await this.readBalanceOrNothing(account);
    await this.dependencies.settlementRepository.recordTreasury(
      this.dependencies.networkIdentifier,
      environment,
      account,
      balance,
    );
  }

  /** A balance nobody could read is unknown, which is not the same as zero and must not look like it. */
  private async readBalanceOrNothing(account: string): Promise<bigint | null> {
    try {
      return await this.dependencies.broadcaster.readNativeBalance(account);
    } catch {
      return null;
    }
  }

  async execute(): Promise<SettlementTickOutcome> {
    const reconciled = await this.reconcileOutstanding();
    const planned = await this.planNewSettlements();
    const advanced = await this.advanceSettlements();

    return {
      reconciled,
      planned: planned.planned,
      awaitingPayoutDestination: planned.awaitingPayoutDestination,
      broadcast: advanced.broadcast,
      settled: advanced.settled,
      failed: advanced.failed,
    };
  }

  /**
   * Asks the chain what became of every transaction still in flight.
   *
   * This runs first and unconditionally. Deciding what to broadcast next while a previous broadcast
   * is unaccounted for is how a system sends twice, and the cost of asking is one call per
   * outstanding transaction rather than one per tick.
   */
  private async reconcileOutstanding(): Promise<number> {
    const outstanding = await this.dependencies.settlementRepository.unresolvedTransactions(
      this.dependencies.networkIdentifier,
    );
    let resolved = 0;

    for (const transaction of outstanding) {
      const answer = await this.dependencies.broadcaster.reconcileBroadcast(
        transaction.transactionReference,
        transaction.sourceAccount,
        transaction.sequenceNumber,
      );

      if (answer.kind === 'indeterminate') {
        this.dependencies.logger.warn(
          {
            event: 'settlement.reconcile_indeterminate',
            settlementId: transaction.settlementId,
            transactionReference: transaction.transactionReference,
            reason: answer.reason,
          },
          'no endpoint could say what happened to a broadcast transaction',
        );
        continue;
      }

      if (answer.kind === 'pending') {
        continue;
      }

      if (answer.kind === 'superseded') {
        await this.dependencies.settlementRepository.markTransactionResolved(
          transaction.identifier,
          'dropped',
          { failureReason: 'another transaction took this sequence number' },
        );
        await this.failSettlement(
          transaction.settlementId,
          'the transaction was displaced before it was mined',
        );
        resolved += 1;
        continue;
      }

      await this.dependencies.settlementRepository.markTransactionResolved(
        transaction.identifier,
        answer.succeeded ? 'confirmed' : 'reverted',
        {
          computeUsed: answer.computeUsed,
          feePaidInNativeUnits: answer.feePaidInNativeUnits,
          blockHeight: answer.position.height,
          blockReference: answer.position.reference,
          ...(!answer.succeeded && { failureReason: 'the transaction reverted on chain' }),
        },
      );

      this.dependencies.logger.info(
        {
          event: answer.succeeded
            ? 'settlement.transaction_confirmed'
            : 'settlement.transaction_reverted',
          settlementId: transaction.settlementId,
          purpose: transaction.purpose,
          transactionReference: transaction.transactionReference,
          blockHeight: answer.position.height.toString(),
          feePaidInNativeUnits: answer.feePaidInNativeUnits.toString(),
        },
        answer.succeeded
          ? 'a settlement transaction was mined'
          : 'a settlement transaction reverted',
      );

      if (!answer.succeeded) {
        await this.failSettlement(transaction.settlementId, 'the transaction reverted on chain');
      }
      resolved += 1;
    }

    return resolved;
  }

  private async planNewSettlements(): Promise<{
    planned: number;
    awaitingPayoutDestination: number;
  }> {
    const candidates = await this.dependencies.settlementRepository.findSettleablePayments(
      this.dependencies.networkIdentifier,
      this.dependencies.batchSize,
    );

    let planned = 0;
    let awaiting = 0;

    for (const candidate of candidates) {
      const destination = await this.dependencies.settlementRepository.payoutDestinationFor(
        candidate.merchantId,
        candidate.environment,
        this.dependencies.networkIdentifier,
      );
      if (destination === null) {
        awaiting += 1;
        continue;
      }

      // Read from the chain, never from the credited figure. What is actually there is what can
      // actually move, and a transfer for more reverts and pays a fee to discover it.
      const balance = await this.dependencies.broadcaster.readAssetBalance(
        candidate.depositAccount,
        candidate.assetReference,
      );
      if (balance === 0n) {
        continue;
      }

      await this.dependencies.settlementRepository.planIfAbsent({
        identifier: `stl_${this.dependencies.ulidFactory.create(this.dependencies.now().getTime())}`,
        paymentId: candidate.paymentId,
        merchantId: candidate.merchantId,
        environment: candidate.environment,
        networkIdentifier: this.dependencies.networkIdentifier,
        sourceAccount: candidate.depositAccount,
        destinationAccount: destination,
        assetReference: candidate.assetReference,
        amountInBaseUnits: balance,
      });
      planned += 1;
    }

    return { planned, awaitingPayoutDestination: awaiting };
  }

  private async advanceSettlements(): Promise<{
    broadcast: number;
    settled: number;
    failed: number;
  }> {
    const settlements = await this.dependencies.settlementRepository.findUnfinished(
      this.dependencies.networkIdentifier,
      this.dependencies.batchSize,
    );

    let broadcast = 0;
    let settled = 0;
    let failed = 0;

    for (const settlement of settlements) {
      const transactions = await this.dependencies.settlementRepository.transactionsFor(
        settlement.identifier,
      );
      const outcome = await this.advanceOne(settlement, transactions);
      broadcast += outcome === 'broadcast' ? 1 : 0;
      settled += outcome === 'settled' ? 1 : 0;
      failed += outcome === 'failed' ? 1 : 0;
    }

    return { broadcast, settled, failed };
  }

  private async advanceOne(
    settlement: Settlement,
    transactions: readonly ChainTransaction[],
  ): Promise<'broadcast' | 'settled' | 'failed' | 'waiting'> {
    if (settlement.status === 'pending') {
      return this.startSettlement(settlement);
    }
    if (settlement.status === 'funding') {
      return this.continueAfterFunding(settlement, transactions);
    }
    if (settlement.status === 'sweeping') {
      return this.continueAfterSweep(settlement, transactions);
    }
    if (settlement.status === 'confirming') {
      return this.confirmSweep(settlement, transactions);
    }
    return 'waiting';
  }

  /**
   * Decides whether the deposit address can pay for its own sweep, and funds it if not.
   *
   * A freshly derived address holds nothing, so the usual answer is no. Funding sends exactly the
   * estimated worst case rather than a round number: the remainder is stranded at an address that
   * will never be used again, and rounding up is how that dust becomes material across thousands of
   * payments.
   */
  private async startSettlement(
    settlement: Settlement,
  ): Promise<'broadcast' | 'failed' | 'waiting'> {
    const sweepRole: SigningRole = {
      kind: 'deposit',
      derivationIndex: await this.derivationIndexFor(settlement),
    };

    const estimate = await this.dependencies.broadcaster.estimateAssetTransfer({
      signingRole: sweepRole,
      sourceAccount: settlement.sourceAccount,
      destinationAccount: settlement.destinationAccount,
      assetReference: settlement.assetReference,
      amount: settlement.amountInBaseUnits,
    });

    if (estimate.kind === 'unavailable') {
      this.dependencies.logger.warn(
        { event: 'settlement.estimate_unavailable', settlementId: settlement.identifier },
        estimate.reason,
      );
      return 'waiting';
    }
    if (estimate.kind === 'would_revert') {
      await this.failSettlement(
        settlement.identifier,
        `the sweep would revert: ${estimate.reason}`,
      );
      return 'failed';
    }

    const available = await this.dependencies.broadcaster.readNativeBalance(
      settlement.sourceAccount,
    );
    if (available >= estimate.estimate.maximumFeeInNativeUnits) {
      return this.broadcastSweep(settlement, sweepRole, estimate.estimate, 'sweeping');
    }

    const shortfall = estimate.estimate.maximumFeeInNativeUnits - available;
    return this.broadcastFunding(settlement, shortfall);
  }

  private async broadcastFunding(
    settlement: Settlement,
    amountInNativeUnits: bigint,
  ): Promise<'broadcast' | 'failed' | 'waiting'> {
    const treasury = this.dependencies.broadcaster.treasuryAccount;
    const request = {
      signingRole: { kind: 'treasury' } as const,
      sourceAccount: treasury,
      destinationAccount: settlement.sourceAccount,
      amountInNativeUnits,
    };

    const estimate = await this.dependencies.broadcaster.estimateNativeTransfer(request);
    if (estimate.kind !== 'estimated') {
      const waiting = estimate.kind === 'unavailable';
      if (waiting) {
        return 'waiting';
      }
      await this.failSettlement(
        settlement.identifier,
        `the treasury cannot fund this settlement: ${estimate.reason}`,
      );
      return 'failed';
    }

    // The ceiling is checked here, before a signature exists, and against the treasury's whole
    // committed history rather than against this transaction alone.
    const spends = await this.dependencies.settlementRepository.treasurySpends(
      this.dependencies.networkIdentifier,
      treasury,
    );
    const decision = decideSpend({
      ceilingInNativeUnits: this.dependencies.spendCeilingInNativeUnits,
      committedInNativeUnits: totalCommitted(spends),
      proposed: {
        valueInNativeUnits: amountInNativeUnits,
        maximumFeeInNativeUnits: estimate.estimate.maximumFeeInNativeUnits,
      },
    });

    if (decision.kind === 'refused') {
      this.dependencies.logger.error(
        {
          event: 'settlement.spend_ceiling_reached',
          settlementId: settlement.identifier,
          committedInNativeUnits: decision.committedInNativeUnits.toString(),
          ceilingInNativeUnits: decision.ceilingInNativeUnits.toString(),
          wouldReachInNativeUnits: decision.wouldReachInNativeUnits.toString(),
        },
        'refusing to sign: the network spend ceiling would be exceeded',
      );
      await this.failSettlement(
        settlement.identifier,
        'the network spend ceiling would be exceeded by funding this settlement',
      );
      return 'failed';
    }

    const treasuryBalance = await this.dependencies.broadcaster.readNativeBalance(treasury);
    const required = amountInNativeUnits + estimate.estimate.maximumFeeInNativeUnits;
    if (treasuryBalance < required) {
      this.dependencies.logger.error(
        {
          event: 'settlement.treasury_underfunded',
          treasuryAccount: treasury,
          balanceInNativeUnits: treasuryBalance.toString(),
          requiredInNativeUnits: required.toString(),
        },
        'the treasury cannot cover the next settlement',
      );
      return 'waiting';
    }

    return this.signRecordAndSubmit({
      settlement,
      purpose: 'gas_funding',
      sourceAccount: treasury,
      destinationAccount: settlement.sourceAccount,
      valueInNativeUnits: amountInNativeUnits,
      estimate: estimate.estimate,
      nextStatus: 'funding',
      sign: (sequenceNumber) =>
        this.dependencies.broadcaster.signNativeTransfer(
          request,
          sequenceNumber,
          estimate.estimate,
        ),
    });
  }

  private async broadcastSweep(
    settlement: Settlement,
    signingRole: SigningRole,
    estimate: FeeEstimate,
    nextStatus: SettlementStatus,
  ): Promise<'broadcast' | 'failed' | 'waiting'> {
    const request = {
      signingRole,
      sourceAccount: settlement.sourceAccount,
      destinationAccount: settlement.destinationAccount,
      assetReference: settlement.assetReference,
      amount: settlement.amountInBaseUnits,
    };

    return this.signRecordAndSubmit({
      settlement,
      purpose: 'asset_sweep',
      sourceAccount: settlement.sourceAccount,
      destinationAccount: settlement.destinationAccount,
      valueInNativeUnits: 0n,
      estimate,
      nextStatus,
      sign: (sequenceNumber) =>
        this.dependencies.broadcaster.signAssetTransfer(request, sequenceNumber, estimate),
    });
  }

  /**
   * Sign, write down what was signed, then send. In that order, always.
   *
   * Recording between signing and sending is what makes a timeout survivable: the reference is
   * already known, so the next tick asks the chain about it instead of guessing whether to send
   * again. Sending first and recording afterwards leaves a window in which a crash loses the only
   * evidence that money may already be moving.
   */
  private async signRecordAndSubmit(input: {
    settlement: Settlement;
    purpose: 'gas_funding' | 'asset_sweep';
    sourceAccount: string;
    destinationAccount: string;
    valueInNativeUnits: bigint;
    estimate: FeeEstimate;
    nextStatus: SettlementStatus;
    sign: (
      sequenceNumber: number,
    ) => Promise<
      | { kind: 'signed'; transactionReference: string; signedPayload: string }
      | { kind: 'refused'; reason: string }
    >;
  }): Promise<'broadcast' | 'failed' | 'waiting'> {
    const observedSequence = await this.dependencies.broadcaster.readAccountSequence(
      input.sourceAccount,
    );
    const sequenceNumber = await this.dependencies.settlementRepository.claimSequenceNumber(
      this.dependencies.networkIdentifier,
      input.sourceAccount,
      observedSequence,
    );

    const signed = await input.sign(sequenceNumber);
    if (signed.kind === 'refused') {
      // Nothing was signed, so nothing can reach the mempool with this number. Keeping it would
      // leave a hole every later transaction from this account waits behind.
      await this.dependencies.settlementRepository.releaseSequenceNumber(
        this.dependencies.networkIdentifier,
        input.sourceAccount,
        sequenceNumber,
      );
      await this.failSettlement(input.settlement.identifier, signed.reason);
      return 'failed';
    }

    const transactionIdentifier = `ctx_${this.dependencies.ulidFactory.create(
      this.dependencies.now().getTime(),
    )}`;
    const recorded = await this.dependencies.settlementRepository.recordBroadcast({
      identifier: transactionIdentifier,
      settlementId: input.settlement.identifier,
      networkIdentifier: this.dependencies.networkIdentifier,
      purpose: input.purpose,
      sourceAccount: input.sourceAccount,
      destinationAccount: input.destinationAccount,
      sequenceNumber,
      transactionReference: signed.transactionReference,
      valueInNativeUnits: input.valueInNativeUnits,
      maximumFeeInNativeUnits: input.estimate.maximumFeeInNativeUnits,
      feeParameters: input.estimate.feeParameters,
      settlementStatus: input.nextStatus,
      expectedStatusVersion: input.settlement.statusVersion,
    });

    // Losing the compare-and-swap means another worker moved this settlement while this one was
    // signing. Nothing has been sent, so the signed payload is discarded and the sequence number is
    // returned to the chain's own accounting on the next claim.
    if (!recorded) {
      await this.dependencies.settlementRepository.releaseSequenceNumber(
        this.dependencies.networkIdentifier,
        input.sourceAccount,
        sequenceNumber,
      );
      this.dependencies.logger.info(
        { event: 'settlement.contended', settlementId: input.settlement.identifier },
        'another worker advanced this settlement first',
      );
      return 'waiting';
    }

    const submitted = await this.dependencies.broadcaster.submit(signed.signedPayload);

    // Rejection is the one answer that proves nothing reached the mempool, so the row is retired and
    // the number handed back. An indeterminate answer must keep both: the transaction may be in
    // flight, and reusing its number would replace it with something the ceiling never counted.
    if (submitted.kind === 'rejected') {
      await this.dependencies.settlementRepository.markTransactionResolved(
        transactionIdentifier,
        'dropped',
        { failureReason: submitted.reason },
      );
      await this.dependencies.settlementRepository.releaseSequenceNumber(
        this.dependencies.networkIdentifier,
        input.sourceAccount,
        sequenceNumber,
      );
      await this.failSettlement(input.settlement.identifier, submitted.reason);
      return 'failed';
    }

    this.dependencies.logger.info(
      {
        event: 'settlement.broadcast',
        settlementId: input.settlement.identifier,
        purpose: input.purpose,
        transactionReference: signed.transactionReference,
        sequenceNumber,
        maximumFeeInNativeUnits: input.estimate.maximumFeeInNativeUnits.toString(),
        valueInNativeUnits: input.valueInNativeUnits.toString(),
        accepted: submitted.kind === 'accepted',
      },
      submitted.kind === 'accepted'
        ? 'a settlement transaction was broadcast'
        : 'a settlement transaction was signed and sent, and the endpoint did not answer',
    );

    return 'broadcast';
  }

  private async continueAfterFunding(
    settlement: Settlement,
    transactions: readonly ChainTransaction[],
  ): Promise<'broadcast' | 'failed' | 'waiting'> {
    const funding = transactions.findLast((entry) => entry.purpose === 'gas_funding');
    if (funding?.status !== 'confirmed') {
      return 'waiting';
    }

    const sweepRole: SigningRole = {
      kind: 'deposit',
      derivationIndex: await this.derivationIndexFor(settlement),
    };
    const estimate = await this.dependencies.broadcaster.estimateAssetTransfer({
      signingRole: sweepRole,
      sourceAccount: settlement.sourceAccount,
      destinationAccount: settlement.destinationAccount,
      assetReference: settlement.assetReference,
      amount: settlement.amountInBaseUnits,
    });
    if (estimate.kind !== 'estimated') {
      return estimate.kind === 'unavailable' ? 'waiting' : 'failed';
    }

    return this.broadcastSweep(settlement, sweepRole, estimate.estimate, 'sweeping');
  }

  private async continueAfterSweep(
    settlement: Settlement,
    transactions: readonly ChainTransaction[],
  ): Promise<'waiting'> {
    const sweep = transactions.findLast((entry) => entry.purpose === 'asset_sweep');
    if (sweep?.status !== 'confirmed') {
      return 'waiting';
    }

    // Mined is not settled. The confirmation gate is applied on the next tick, from `confirming`.
    await this.dependencies.settlementRepository.saveStatus(
      settlement.identifier,
      'sweeping',
      'confirming',
      settlement.statusVersion,
      null,
    );
    return 'waiting';
  }

  /**
   * Holds the settlement open until the sweep is as final as an incoming payment has to be.
   *
   * The same gate as the receive side, deliberately. A merchant told their money has arrived at
   * their own address, only for a reorg to take it back, is a worse outcome than being told a few
   * blocks later.
   */
  private async confirmSweep(
    settlement: Settlement,
    transactions: readonly ChainTransaction[],
  ): Promise<'settled' | 'waiting'> {
    const sweep = transactions.findLast((entry) => entry.purpose === 'asset_sweep');
    const minedAt = sweep?.blockHeight ?? null;
    if (minedAt === null) {
      return 'waiting';
    }

    const progress = await this.dependencies.gateway.readChainProgress();
    const confirmations = progress.tip.height - minedAt + 1n;
    if (confirmations < BigInt(this.dependencies.requiredConfirmations)) {
      return 'waiting';
    }

    if (this.dependencies.requiresFinalityTag) {
      const finalized = progress.finalizedHeight;
      if (finalized === null || finalized < minedAt) {
        return 'waiting';
      }
    }

    const moved = await this.dependencies.settlementRepository.saveStatus(
      settlement.identifier,
      'confirming',
      'settled',
      settlement.statusVersion,
      null,
    );
    if (!moved) {
      return 'waiting';
    }

    this.dependencies.logger.info(
      {
        event: 'settlement.settled',
        settlementId: settlement.identifier,
        paymentId: settlement.paymentId,
        destinationAccount: settlement.destinationAccount,
        amountInBaseUnits: settlement.amountInBaseUnits.toString(),
      },
      'a settlement reached its destination',
    );
    return 'settled';
  }

  private async derivationIndexFor(settlement: Settlement): Promise<number> {
    const index = await this.dependencies.settlementRepository.derivationIndexFor(
      settlement.paymentId,
    );
    if (index === null) {
      throw new Error(`No deposit address is recorded for ${settlement.paymentId}`);
    }
    return index;
  }

  private async failSettlement(settlementId: string, reason: string): Promise<void> {
    const settlement = await this.dependencies.settlementRepository.findById(settlementId);
    if (settlement === null || settlement.status === 'failed') {
      return;
    }
    await this.dependencies.settlementRepository.saveStatus(
      settlement.identifier,
      settlement.status,
      'failed',
      settlement.statusVersion,
      reason,
    );
  }

  /**
   * Returns failed settlements to the queue once their backoff has elapsed.
   *
   * A failed settlement is money sitting in an address this system controls, so giving up
   * permanently strands it. The attempt ceiling is what keeps that from becoming a loop, and the
   * funds cannot be sent twice regardless, because the sequence number decides that and not the
   * status.
   */
  async retryFailed(): Promise<number> {
    const retryable = await this.dependencies.settlementRepository.findRetryable(
      this.dependencies.networkIdentifier,
      this.dependencies.maximumAttempts,
      this.dependencies.retryBackoffMilliseconds,
      this.dependencies.batchSize,
    );

    let restarted = 0;
    for (const settlement of retryable) {
      const moved = await this.dependencies.settlementRepository.saveStatus(
        settlement.identifier,
        'failed',
        'pending',
        settlement.statusVersion,
        null,
      );
      restarted += moved ? 1 : 0;
    }
    return restarted;
  }
}
